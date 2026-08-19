import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createCustomerAccountWorkflow,
  generateResetPasswordTokenWorkflow,
  setAuthAppMetadataWorkflow,
} from "@medusajs/medusa/core-flows"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { decideClaim, type ClaimDecision } from "../lib/odoo-login-claim"
import { parseScriptArgs } from "./script-args"

/**
 * Aus Odoo übernommene Kundinnen und Kunden anmeldefähig machen.
 *
 * ─── WOFÜR DAS DA IST ─────────────────────────────────────────────────────
 *
 * Der Kundenimport selbst passiert anderswo (Odoo-Export, eigener Strang). Er
 * legt `customer`-Datensätze an, mehr nicht. Was fehlt, ist alles, was mit
 * Anmeldung zu tun hat — und ohne diesen Schritt sind die importierten Konten
 * unbrauchbar, ohne dass es irgendwo auffällt:
 *
 *   Odoo hasht Passwörter mit PBKDF2-SHA512, Medusas `emailpass` mit scrypt.
 *   Ein Hash lässt sich nicht in den anderen umrechnen. Alle müssen einmalig
 *   ein neues Passwort setzen — und genau das geht nicht: der Reset-Ablauf
 *   setzt eine `provider_identity` voraus, die ein reiner Kundenimport nicht
 *   anlegt. `generateResetPasswordTokenWorkflow` wirft dann, die Store-Route
 *   fängt es ab (`throwOnError: false`) und antwortet trotzdem mit 201. Es
 *   sieht aus wie "E-Mail unterwegs" und ist eine Sackgasse.
 *
 * Zweitens: Medusas Unique-Index geht über `(email, has_account)`. Registriert
 * sich ein importierter Kunde stattdessen neu, entsteht eine ZWEITE Zeile mit
 * derselben Adresse — Bestellungen und Adressen bleiben an der ersten hängen.
 * Deshalb übernimmt dieses Script bestehende Datensätze, statt neue anzulegen.
 * Die Entscheidungstabelle dazu steht in `src/lib/odoo-login-claim.ts`.
 *
 * ─── ABLAUF AM UMZUGSTAG ──────────────────────────────────────────────────
 *
 *   1. Kunden importieren (anderer Strang).
 *   2. Dieses Script OHNE `invite` laufen lassen und die Zusammenfassung
 *      prüfen — vor allem die Zeile "Konflikte".
 *   3. Erst dann mit `invite` laufen lassen. Dann bekommen alle die
 *      "Passwort setzen"-E-Mail, ohne vorher an einer Anmeldung zu scheitern.
 *
 * Das Script ist wiederholbar: was schon anmeldefähig ist, wird übersprungen.
 *
 * ─── EINGABE ──────────────────────────────────────────────────────────────
 *
 * JSON-Array (oder `{ "customers": [...] }`):
 *
 *   [{ "email": "a@b.ch", "first_name": "Anna", "last_name": "Muster",
 *      "phone": "+41 79 000 00 00", "odoo_partner_id": 1234 }]
 *
 * Ohne Datei nimmt das Script ALLE Kunden mit `metadata.imported_from = "odoo"`
 * aus der Datenbank — der Normalfall, wenn der Import schon gelaufen ist.
 *
 * ─── AUFRUF ───────────────────────────────────────────────────────────────
 *
 *   npx medusa exec ./src/scripts/prepare-odoo-logins.ts
 *   npx medusa exec ./src/scripts/prepare-odoo-logins.ts kunden.json dry-run
 *   npx medusa exec ./src/scripts/prepare-odoo-logins.ts invite
 *
 * Argumente ohne Bindestrich — siehe die Erklärung in script-args.ts.
 */

interface OdooCustomer {
  email?: string
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  company_name?: string | null
  odoo_partner_id?: number | string | null
  /** Ältere Exporte nannten das Feld so. */
  odoo_id?: number | string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function odooId(row: OdooCustomer): string | null {
  const raw = row.odoo_partner_id ?? row.odoo_id
  return raw == null ? null : String(raw)
}

/**
 * Nur die Felder, die der Shop wirklich braucht. Odoo-Kontakte tragen oft
 * Umsatzzahlen, Verkaufsnotizen und Geburtsdaten mit sich — nichts davon
 * gehört nach DSG in einen Webshop, der es nie verwendet.
 */
function toCustomerData(row: OdooCustomer) {
  const id = odooId(row)
  return {
    email: row.email!.trim().toLowerCase(),
    first_name: row.first_name?.trim() || undefined,
    last_name: row.last_name?.trim() || undefined,
    phone: row.phone?.trim() || undefined,
    company_name: row.company_name?.trim() || undefined,
    metadata: {
      imported_from: "odoo",
      ...(id ? { odoo_partner_id: id } : {}),
    },
  }
}

/**
 * 32 Byte aus dem CSPRNG. Wird gehasht abgelegt und danach vergessen: es gibt
 * keinen Ort, an dem dieses Passwort im Klartext existiert. Es ist
 * ausschliesslich dazu da, dass überhaupt eine Provider-Identität existiert —
 * ohne sie gibt es keinen Reset-Link.
 */
function unguessablePassword(): string {
  return randomBytes(32).toString("base64url")
}

export default async function prepareOdooLogins({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const parsed = parseScriptArgs(args)
  const file = parsed.file(".json")
  const dryRun = parsed.flag("dry-run")
  const invite = parsed.flag("invite")

  const authService = container.resolve(Modules.AUTH)
  const customerService = container.resolve(Modules.CUSTOMER)

  let rows: OdooCustomer[]
  if (file) {
    const raw = JSON.parse(await readFile(file, "utf-8")) as unknown
    rows = Array.isArray(raw)
      ? raw
      : ((raw as { customers?: OdooCustomer[] })?.customers ?? [])
  } else {
    // Kein File: die bereits importierten Kunden aus der Datenbank nehmen.
    const alle = await customerService.listCustomers({}, { take: 100000 })
    rows = alle
      .filter(
        (c) => (c.metadata as Record<string, unknown> | null)?.imported_from === "odoo",
      )
      .map((c) => ({
        email: c.email ?? undefined,
        odoo_partner_id: (c.metadata as Record<string, unknown> | null)
          ?.odoo_partner_id as string | undefined,
      }))
    logger.info(`[odoo] ${rows.length} importierte Kunden in der Datenbank gefunden.`)
  }

  if (!rows.length) {
    logger.error("Keine Kundendatensätze zu verarbeiten.")
    return
  }

  const counts: Record<ClaimDecision["action"], number> = {
    skip: 0,
    link: 0,
    claim: 0,
    create: 0,
    conflict: 0,
  }
  let failed = 0
  let ungueltig = 0
  const anmeldefaehig: string[] = []

  // Bewusst sequenziell: der emailpass-Provider hasht mit scrypt bei
  // logN: 15. Das kostet pro Datensatz spürbar CPU und RAM; parallel bringt
  // das den Node-Prozess auf der 2-GB-VPS um.
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email)) {
      // Ohne Adresse gibt es weder Anmeldung noch Reset-Link.
      ungueltig++
      continue
    }

    try {
      const byEmail = await customerService.listCustomers(
        { email },
        { select: ["id", "has_account", "metadata"], take: 10 },
      )
      const id = odooId(row)

      // `has_account = true` heisst: hier hat sich jemand selbst registriert.
      const registered = byEmail.find((c) => c.has_account) ?? null
      // Der importierte Datensatz — bevorzugt über die Odoo-ID, sonst über die
      // Adresse ohne Konto.
      const imported =
        (id
          ? byEmail.find(
              (c) =>
                (c.metadata as Record<string, unknown> | null)?.odoo_partner_id === id,
            )
          : undefined) ??
        byEmail.find((c) => !c.has_account) ??
        null

      const [providerIdentity] = await authService.listProviderIdentities(
        { entity_id: email, provider: "emailpass" },
        { select: ["auth_identity_id", "entity_id"], take: 1 },
      )

      let identityCustomerId: string | null = null
      let authIdentityId: string | null = null
      if (providerIdentity?.auth_identity_id) {
        authIdentityId = providerIdentity.auth_identity_id
        const authIdentity = await authService.retrieveAuthIdentity(authIdentityId)
        identityCustomerId =
          ((authIdentity?.app_metadata as Record<string, unknown> | null)?.customer_id as
            | string
            | undefined) ?? null
      }

      const decision = decideClaim({
        imported: imported
          ? { id: imported.id, hasAccount: !!imported.has_account }
          : null,
        registered: registered
          ? { id: registered.id, hasAccount: !!registered.has_account }
          : null,
        identity: authIdentityId ? { authIdentityId, customerId: identityCustomerId } : null,
      })

      counts[decision.action]++

      if (decision.action === "conflict") {
        // Ohne Adresse im Log — die Odoo-ID genügt, um den Fall zu finden.
        logger.warn(
          `[odoo] Konflikt: zwei Kundendatensätze zur selben Adresse (odoo_partner_id=${
            id ?? "?"
          }). Manuell zusammenführen; dieser Datensatz wurde nicht angefasst.`,
        )
        continue
      }

      if (decision.action === "skip") continue

      if (dryRun) {
        anmeldefaehig.push(email)
        continue
      }

      if (decision.action === "link") {
        await setAuthAppMetadataWorkflow(container).run({
          input: {
            authIdentityId: decision.authIdentityId,
            actorType: "customer",
            value: decision.customerId,
          },
        })
        anmeldefaehig.push(email)
        continue
      }

      if (decision.action === "claim") {
        const { success, authIdentity, error } = await authService.register("emailpass", {
          body: { email, password: unguessablePassword() },
        } as never)
        if (!success || !authIdentity) {
          logger.warn(`[odoo] Identität nicht anlegbar (${error ?? "unbekannt"}).`)
          failed++
          continue
        }

        await setAuthAppMetadataWorkflow(container).run({
          input: {
            authIdentityId: authIdentity.id,
            actorType: "customer",
            value: decision.customerId,
          },
        })

        if (decision.setHasAccount) {
          // `has_account` ist ein echtes Feld des Customer-Models, steht aber
          // nicht in `UpdateCustomerDTO` — Medusa gibt es öffentlich nicht zum
          // Ändern frei. Deshalb dieser eng gefasste Umweg um die Typen und
          // deshalb im try: das Flag ist Kosmetik für Admin und Unique-Index,
          // anmeldefähig ist das Konto auch ohne. Ein Fehler hier darf den
          // Umzug nicht anhalten.
          try {
            const update = customerService.updateCustomers as unknown as (
              id: string,
              data: Record<string, unknown>,
            ) => Promise<unknown>
            await update(decision.customerId, { has_account: true })
          } catch {
            logger.warn(
              "[odoo] has_account liess sich nicht setzen — das Konto funktioniert trotzdem.",
            )
          }
        }

        anmeldefaehig.push(email)
        continue
      }

      // decision.action === "create"
      const { success, authIdentity, error } = await authService.register("emailpass", {
        body: { email, password: unguessablePassword() },
      } as never)
      if (!success || !authIdentity) {
        logger.warn(`[odoo] Identität nicht anlegbar (${error ?? "unbekannt"}).`)
        failed++
        continue
      }
      await createCustomerAccountWorkflow(container).run({
        input: { authIdentityId: authIdentity.id, customerData: toCustomerData(row) },
      })
      anmeldefaehig.push(email)
    } catch (err) {
      // Ohne Adresse im Log: eine fehlgeschlagene Zeile ist ein
      // Betriebsfehler, kein Grund, Personendaten dauerhaft abzulegen.
      failed++
      logger.error(
        `[odoo] Datensatz fehlgeschlagen: ${
          err instanceof Error ? err.message : "unbekannt"
        }`,
      )
    }
  }

  logger.info(
    `[odoo] ${counts.claim} übernommen, ${counts.link} verknüpft, ${counts.create} neu angelegt, ` +
      `${counts.skip} bereits anmeldefähig, ${counts.conflict} Konflikte, ` +
      `${ungueltig} ohne gültige Adresse, ${failed} fehlgeschlagen` +
      `${dryRun ? " (dry-run, nichts geschrieben)" : ""}.`,
  )

  if (counts.conflict > 0) {
    logger.warn(
      "[odoo] Konflikte gefunden: zu diesen Adressen gibt es zwei Kundendatensätze. " +
        "Bestellungen und Adressen hängen am importierten, das Konto am neu registrierten. " +
        "Vor dem Umzug im Admin zusammenführen.",
    )
  }

  if (invite && anmeldefaehig.length && !dryRun) {
    // Erst nach dem Durchlauf, damit ein Abbruch mittendrin keine E-Mails für
    // Konten erzeugt, die es am Ende gar nicht gibt.
    const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    for (const email of anmeldefaehig) {
      await generateResetPasswordTokenWorkflow(container).run({
        input: {
          entityId: email,
          actorType: "customer",
          provider: "emailpass",
          secret: config.projectConfig.http.jwtSecret as string,
        },
        throwOnError: false,
      })
    }
    // ACHTUNG: das Reset-Token gilt 15 Minuten. Wer 2000 Einladungen auf
    // einmal verschickt, verschickt 2000 Links, die eine Viertelstunde später
    // alle tot sind. Verkraftbar — auf der Anmeldeseite fordert man einen
    // neuen an —, aber es gehört in den Text der E-Mail und ins Wissen des
    // Supports. Die E-Mail sagt es (siehe lib/password-reset-email.ts).
    logger.info(
      `[odoo] ${anmeldefaehig.length} Einladungen zum Passwortsetzen angestossen.`,
    )
  }
}
