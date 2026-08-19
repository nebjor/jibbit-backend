import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parseScriptArgs } from "./script-args"

/**
 * Kundinnen und Kunden aus Odoo übernehmen.
 *
 * ─── DAS PROBLEM ──────────────────────────────────────────────────────────
 *
 * Odoo hasht Passwörter mit PBKDF2-SHA512 (passlib), Medusas `emailpass`-
 * Provider mit scrypt. Ein Hash lässt sich nicht in den anderen umrechnen —
 * die Passwörter der Bestandskunden sind schlicht nicht migrierbar. Alle
 * müssen einmalig ein neues setzen.
 *
 * ─── DIE FALLE, DIE DAS SCRIPT ENTSCHÄRFT ─────────────────────────────────
 *
 * Der naheliegende Import — nur `customer`-Datensätze anlegen, kein Passwort,
 * "die setzen sich dann halt eines" — führt in eine Sackgasse:
 *
 *   `generateResetPasswordTokenWorkflow` sucht zuerst die *Provider-Identität*
 *   zur Adresse und wirft, wenn es keine gibt. Die Route darüber schluckt den
 *   Fehler (`throwOnError: false`) und antwortet trotzdem mit 201. Für die
 *   Kundin sieht alles richtig aus, es kommt nur nie eine E-Mail. Und zwar
 *   für immer.
 *
 * Deshalb legt dieses Script zu jeder Adresse eine echte emailpass-Identität
 * an, mit einem zufälligen 32-Byte-Passwort, das niemand kennt und das
 * nirgends gespeichert wird. Damit gilt:
 *   - Anmeldung schlägt fehl wie bei jedem falschen Passwort — ununterscheidbar.
 *   - "Passwort vergessen" findet eine Identität und verschickt die E-Mail.
 *   - Nach dem Zurücksetzen ist das Konto normal nutzbar.
 *
 * ─── DIE ZWEITE FALLE: ÜBERNAHME EINES FREMDEN KONTOS ─────────────────────
 *
 * `emailpass.register()` prüft, ob zur Adresse schon eine Identität besteht.
 * Ist deren `app_metadata` LEER, gilt sie als "noch nicht beansprucht" und
 * wird kommentarlos mit dem neuen Passwort überschrieben — ohne jede
 * Bestätigung per E-Mail. Ein Import ohne verknüpften Kunden liesse also
 * jeden Beliebigen das Konto einer bekannten Adresse übernehmen, indem er
 * sich einfach damit "registriert".
 *
 * Das Script setzt die Verknüpfung deshalb im selben Durchgang über
 * `createCustomerAccountWorkflow`, das `app_metadata.customer_id` schreibt.
 * Sie ist ausserdem das, woraus das spätere Anmelde-Token seine `actor_id`
 * zieht: fehlt sie, gelingt die Anmeldung zwar, führt aber auf kein
 * Kundenkonto — `/store/customers/me` antwortet dann mit 401.
 *
 * ─── EINGABE ──────────────────────────────────────────────────────────────
 *
 * JSON-Array, so wie es `scripts/odoo-export.mjs` erzeugen kann:
 *
 *   [{ "email": "a@b.ch", "first_name": "Anna", "last_name": "Muster",
 *      "phone": "+41 79 000 00 00", "odoo_id": 1234, "company_name": "…" }]
 *
 * ─── AUFRUF ───────────────────────────────────────────────────────────────
 *
 *   npx medusa exec ./src/scripts/import-odoo-customers.ts kunden.json
 *   npx medusa exec ./src/scripts/import-odoo-customers.ts kunden.json dry-run
 *   npx medusa exec ./src/scripts/import-odoo-customers.ts kunden.json invite
 *
 * `dry-run` schreibt nichts. `invite` verschickt zusätzlich direkt die
 * "Passwort setzen"-E-Mail — der saubere Weg für den Umzugstag, weil dann
 * niemand erst an einer fehlgeschlagenen Anmeldung scheitern muss. Ohne
 * `invite` bleibt der Weg über "Passwort vergessen" auf der Anmeldeseite.
 *
 * Argumente ohne Bindestrich — siehe die Erklärung in script-args.ts.
 */

interface OdooCustomer {
  email?: string
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  company_name?: string | null
  odoo_id?: number | string | null
}

/**
 * Nur die Felder, die der Shop wirklich braucht. Odoo-Kontakte tragen oft
 * Umsatzzahlen, Notizen der Verkaufsabteilung und Geburtsdaten mit sich —
 * nichts davon gehört nach DSG in einen Webshop, der es nie verwendet.
 */
function toCustomerData(row: OdooCustomer) {
  return {
    email: row.email!.trim().toLowerCase(),
    first_name: row.first_name?.trim() || undefined,
    last_name: row.last_name?.trim() || undefined,
    phone: row.phone?.trim() || undefined,
    company_name: row.company_name?.trim() || undefined,
    metadata: {
      // Macht im Admin sichtbar, woher das Konto stammt — und erlaubt
      // später eine Auswertung "wie viele haben ihr Passwort gesetzt".
      imported_from: "odoo",
      ...(row.odoo_id != null ? { odoo_id: String(row.odoo_id) } : {}),
    },
  }
}

/**
 * 32 Byte aus dem CSPRNG. Wird gehasht abgelegt und danach vergessen: es gibt
 * keinen Ort, an dem dieses Passwort im Klartext existiert, und niemanden, der
 * es erraten könnte. Es ist ausschliesslich dazu da, dass eine gültige
 * Provider-Identität existiert.
 */
function unguessablePassword(): string {
  return randomBytes(32).toString("base64url")
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function importOdooCustomers({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const parsed = parseScriptArgs(args)
  const file = parsed.file(".json")
  const dryRun = parsed.flag("dry-run")
  const invite = parsed.flag("invite")

  if (!file) {
    logger.error(
      "Keine Eingabedatei. Aufruf: medusa exec ./src/scripts/import-odoo-customers.ts kunden.json [dry-run] [invite]"
    )
    return
  }

  const raw = JSON.parse(await readFile(file, "utf-8")) as unknown
  const rows: OdooCustomer[] = Array.isArray(raw)
    ? raw
    : ((raw as { customers?: OdooCustomer[] })?.customers ?? [])

  if (!rows.length) {
    logger.error(`${file} enthält keine Kundendatensätze.`)
    return
  }

  const authService = container.resolve(Modules.AUTH)
  const customerService = container.resolve(Modules.CUSTOMER)

  let created = 0
  let skipped = 0
  let failed = 0
  const invited: string[] = []

  // Bewusst sequenziell. Der emailpass-Provider hasht mit scrypt bei
  // logN: 15 — das kostet pro Datensatz spürbar CPU und RAM. Parallel würde
  // der Import auf der 2-GB-VPS den Node-Prozess umbringen.
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email)) {
      // Ohne Adresse gibt es keine Anmeldung und keinen Weg zurück ins Konto.
      skipped++
      continue
    }

    try {
      const [existing] = await customerService.listCustomers(
        { email },
        { select: ["id"], take: 1 }
      )
      if (existing) {
        // Schon da — der Import ist damit wiederholbar, ohne Dubletten oder
        // ein Überschreiben eines inzwischen gesetzten Passworts.
        skipped++
        continue
      }

      if (dryRun) {
        created++
        continue
      }

      const { success, authIdentity, error } = await authService.register("emailpass", {
        body: { email, password: unguessablePassword() },
      } as never)

      if (!success || !authIdentity) {
        // Häufigster Fall: es gibt bereits eine Identität mit dieser Adresse,
        // die einem anderen Akteur gehört. Nichts anfassen.
        logger.warn(`[import] Identität nicht anlegbar (${error ?? "unbekannt"}) — übersprungen.`)
        skipped++
        continue
      }

      await createCustomerAccountWorkflow(container).run({
        input: {
          authIdentityId: authIdentity.id,
          customerData: toCustomerData(row),
        },
      })

      created++
      if (invite) {
        invited.push(email)
      }
    } catch (err) {
      // Ohne Adresse im Log: eine fehlgeschlagene Zeile ist ein Betriebsfehler,
      // kein Grund, Personendaten dauerhaft in eine Logdatei zu schreiben.
      failed++
      logger.error(
        `[import] Datensatz fehlgeschlagen: ${err instanceof Error ? err.message : "unbekannt"}`
      )
    }
  }

  logger.info(
    `[import] ${created} angelegt, ${skipped} übersprungen, ${failed} fehlgeschlagen${
      dryRun ? " (dry-run, nichts geschrieben)" : ""
    }.`
  )

  if (invite && invited.length && !dryRun) {
    // Erst nach dem Import, damit ein Abbruch mittendrin nicht zu E-Mails für
    // Konten führt, die es am Ende gar nicht gibt.
    const { generateResetPasswordTokenWorkflow } = await import("@medusajs/medusa/core-flows")
    const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    let sent = 0
    for (const email of invited) {
      await generateResetPasswordTokenWorkflow(container).run({
        input: {
          entityId: email,
          actorType: "customer",
          provider: "emailpass",
          secret: config.projectConfig.http.jwtSecret as string,
        },
        throwOnError: false,
      })
      sent++
    }
    // ACHTUNG beim Umzugstag: das Reset-Token gilt 15 Minuten. Wer 2000
    // Einladungen auf einmal verschickt, verschickt 2000 Links, die abends
    // alle abgelaufen sind. Das ist verkraftbar — auf der Anmeldeseite
    // fordert man einen neuen an —, aber es gehört in den Text der E-Mail
    // und ins Wissen des Supports.
    logger.info(`[import] ${sent} Einladungen zum Passwortsetzen angestossen.`)
  }
}
