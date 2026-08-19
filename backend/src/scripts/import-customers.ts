/**
 * Legt die aus Odoo exportierten Kunden in Medusa an — Kunde plus Adressen.
 *
 *   node scripts/odoo-export-customers.mjs ../odoo-export
 *   cd backend
 *   npx medusa exec ./src/scripts/import-customers.ts \
 *       ../odoo-export/partners.json country=ch dry-run
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte Optionen
 * ab, siehe script-args.ts.
 *
 * Optionen:
 *   dry-run             nur zählen, nichts schreiben
 *   country=<code>      Ländercode für Adressen, denen Odoo keines mitgibt
 *                       (für jibbit: ch). Ohne die Option fallen solche
 *                       Adressen weg — der Kunde wird trotzdem angelegt.
 *   include-inactive    archivierte Odoo-Partner ebenfalls anlegen
 *   include-non-customers   auch Partner mit customer_rank = 0
 *                       (Lieferanten, Mitarbeiter — normalerweise falsch)
 *   limit=<n>           höchstens n Kunden anlegen, für einen ersten Test
 *
 * ─── Idempotenz ─────────────────────────────────────────────────────────────
 *
 * Abgeglichen wird über die E-Mail-Adresse, kleingeschrieben und getrimmt.
 * Ein zweiter Lauf legt nichts doppelt an. Kunden, die es schon gibt, werden
 * NICHT überschrieben: nachträgliche Korrekturen im Medusa-Admin würden sonst
 * bei jedem Lauf wieder von den Odoo-Daten zugedeckt. Fehlen einem bereits
 * importierten Kunden alle Adressen (abgebrochener Lauf), werden nur diese
 * nachgetragen.
 *
 * ─── Passwörter ─────────────────────────────────────────────────────────────
 *
 * Passwörter werden NICHT migriert und können es auch nicht: Odoo hasht mit
 * PBKDF2 (passlib), Medusas emailpass-Provider mit scrypt. Ein Hash lässt sich
 * nicht umrechnen.
 *
 * Die Kunden entstehen deshalb mit `has_account = false` und ohne
 * auth_identity. ANNAHME, die ein anderer Agent umsetzt: der Shop bietet
 * „Passwort vergessen" so an, dass es auch für diese Kunden funktioniert.
 * Das ist NICHT der Standardablauf von Medusa —
 * generateResetPasswordTokenWorkflow verlangt eine bestehende
 * provider_identity und tut ohne sie stillschweigend nichts (die Route
 * antwortet trotzdem mit 201, damit sie keine Konten verrät). Ohne diesen
 * Umbau kommt ein importierter Kunde nicht an sein Konto.
 *
 * Achtung für den Betreiber: Medusas Unique-Index geht über
 * (email, has_account). Registriert sich ein importierter Kunde ganz normal
 * neu, entsteht eine ZWEITE Kundenzeile mit has_account = true — die
 * importierten Adressen hängen dann an der ersten. Zusammenführen lassen sich
 * die beiden über metadata.odoo_partner_id.
 *
 * ─── Datenschutz ────────────────────────────────────────────────────────────
 *
 * Dieses Script gibt keine Namen, E-Mail-Adressen oder Anschriften aus —
 * weder im Probelauf noch in der Zusammenfassung. Berichtet werden Zahlen und
 * Odoo-IDs; über die IDs findet der Betreiber den Datensatz in Odoo wieder.
 * Log-Dateien sind sonst schnell die unauffälligste Kopie der Kundendatenbank.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createCustomersWorkflow,
  createCustomerAddressesWorkflow,
} from "@medusajs/medusa/core-flows"

import { parseScriptArgs } from "./script-args"
import {
  OdooPartner,
  PlannedCustomer,
  planCustomerImport,
} from "./odoo-customer-mapping"

/** Medusa legt intern pro Kunde mehrere Zeilen an — kleine Häppchen. */
const BATCH = 50

export default async function importCustomers({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const opts = parseScriptArgs(args)

  const file = opts.file(".json")
  if (!file) {
    logger.error(
      "Pfad zu partners.json fehlt. Beispiel:\n" +
        "  npx medusa exec ./src/scripts/import-customers.ts ../odoo-export/partners.json country=ch dry-run"
    )
    return
  }

  const dryRun = opts.flag("dry-run")
  const country = opts.value("country")?.toLowerCase()
  const limitRaw = opts.value("limit")
  const limit = limitRaw ? Number(limitRaw) : undefined

  if (limitRaw && (!Number.isFinite(limit) || (limit as number) < 1)) {
    logger.error(`limit=${limitRaw} ist keine Zahl > 0.`)
    return
  }

  let partners: OdooPartner[]
  try {
    partners = JSON.parse(readFileSync(resolve(file), "utf8"))
  } catch (e) {
    logger.error(`${file} liess sich nicht lesen: ${(e as Error).message}`)
    return
  }

  if (!Array.isArray(partners)) {
    logger.error(`${file} enthält keine Liste von Partnern.`)
    return
  }

  if (!partners.length) {
    logger.warn("Der Export enthält keine Partner.")
    return
  }

  // ─── Bestand in Medusa ────────────────────────────────────────────────────
  const { data: existingCustomers } = await query.graph({
    entity: "customer",
    fields: ["id", "email", "metadata", "addresses.id"],
  })

  type ExistingCustomer = {
    id: string
    email: string | null
    metadata: Record<string, unknown> | null
    addresses: { id: string }[]
  }

  const byEmail = new Map<string, ExistingCustomer>()
  for (const c of existingCustomers as ExistingCustomer[]) {
    const key = (c.email ?? "").trim().toLowerCase()
    if (!key) {
      continue
    }
    // Bei (email, has_account)-Dubletten gewinnt die erste Zeile; für den
    // Abgleich reicht „diese E-Mail ist schon vergeben".
    if (!byEmail.has(key)) {
      byEmail.set(key, c)
    }
  }

  // ─── Plan rechnen ─────────────────────────────────────────────────────────
  const plan = planCustomerImport(partners, {
    existingEmails: byEmail.keys(),
    includeInactive: opts.flag("include-inactive"),
    includeNonCustomers: opts.flag("include-non-customers"),
    defaultCountryCode: country,
  })

  const s = plan.stats

  logger.info(`Odoo-Partner in der Datei:        ${s.partners_in}`)
  logger.info(`daraus geplante Medusa-Kunden:    ${s.customers_planned}`)
  logger.info(`  davon neu anzulegen:            ${s.to_create}`)
  logger.info(`  davon schon in Medusa:          ${s.already_in_medusa}`)
  logger.info(`Adressen zu den neuen Kunden:     ${s.addresses_planned}`)
  logger.info(
    `Zusammengeführte Dubletten:       ${s.merged_duplicate_groups} Gruppen ` +
      `(${s.merged_partners} Partner weniger)`
  )
  logger.info(`Übersprungen — ohne E-Mail:       ${s.skipped_no_email}`)
  logger.info(`Übersprungen — E-Mail unbrauchbar: ${s.skipped_unusable_email}`)
  logger.info(`Übersprungen — kein Kunde:        ${s.skipped_not_a_customer}`)
  logger.info(`Übersprungen — archiviert:        ${s.skipped_archived}`)

  if (s.addresses_without_country) {
    logger.warn(
      `${s.addresses_without_country} Adressen ohne Ländercode — nicht übernommen. ` +
        `Mit country=ch lässt sich die Schweiz unterstellen.`
    )
  }

  if (s.addresses_orphaned) {
    logger.warn(
      `${s.addresses_orphaned} Adressen gehören zu keinem importierbaren Kunden — ` +
        `der Partner selbst hat keine brauchbare E-Mail und auch keine ` +
        `Ansprechperson, an die sich die Adresse hängen liesse.`
    )
  }

  if (s.skipped_no_email || s.skipped_unusable_email) {
    // IDs statt Namen: damit der Betreiber die Fälle in Odoo nachschlagen kann,
    // ohne dass Personendaten im Log landen.
    const ids = plan.skipped
      .filter((x) => x.reason === "ohne-email" || x.reason === "email-unbrauchbar")
      .map((x) => x.odoo_partner_id)
    logger.warn(
      `Ohne E-Mail lässt sich in Medusa kein Kunde anlegen. Betroffene ` +
        `Odoo-Partner-IDs: ${formatIds(ids)}`
    )
  }

  let toCreate: PlannedCustomer[] = plan.create
  if (limit !== undefined && toCreate.length > limit) {
    logger.info(`limit=${limit}: nur die ersten ${limit} Kunden.`)
    toCreate = toCreate.slice(0, limit)
  }

  // ─── Nachzügler: Adressen für bereits importierte Kunden ──────────────────
  // Ein abgebrochener Lauf kann Kunden ohne Adressen hinterlassen haben.
  // Nur solche werden ergänzt — und nur, wenn sie aus diesem Import stammen.
  const addressBacklog: { customerId: string; customer: PlannedCustomer }[] = []
  for (const planned of plan.existing) {
    const found = byEmail.get(planned.email)
    if (!found || found.addresses?.length || !planned.addresses.length) {
      continue
    }
    if (found.metadata?.source !== "odoo") {
      continue
    }
    addressBacklog.push({ customerId: found.id, customer: planned })
  }

  if (addressBacklog.length) {
    logger.info(
      `${addressBacklog.length} bereits importierte Kunden haben keine Adresse — ` +
        `wird nachgetragen.`
    )
  }

  if (!toCreate.length && !addressBacklog.length) {
    logger.info("Nichts zu tun.")
    return
  }

  if (dryRun) {
    logger.info("— Probelauf, es wird nichts geschrieben —")
    logger.info(
      `Würde ${toCreate.length} Kunden mit ` +
        `${toCreate.reduce((n, c) => n + c.addresses.length, 0)} Adressen anlegen ` +
        `und bei ${addressBacklog.length} bestehenden Kunden Adressen nachtragen.`
    )
    logger.info(
      `Verteilung der Adressen nach Land: ${JSON.stringify(countryHistogram(toCreate))}`
    )
    logger.info(
      "Alle importierten Kunden erhalten KEIN Passwort (has_account = false) " +
        "und müssen beim ersten Login über „Passwort vergessen“ gehen."
    )
    return
  }

  // ─── Schreiben ────────────────────────────────────────────────────────────
  let created = 0
  let createdAddresses = 0

  for (const batch of chunk(toCreate, BATCH)) {
    const { result } = await createCustomersWorkflow(container).run({
      input: {
        customersData: batch.map((c) => ({
          email: c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          company_name: c.company_name,
          phone: c.phone,
          // has_account bleibt false — es gibt keine auth_identity, siehe Kopf.
          metadata: c.metadata,
          addresses: c.addresses.map(toAddressInput),
        })),
      },
    })

    created += result.length
    createdAddresses += batch.reduce((n, c) => n + c.addresses.length, 0)
    logger.info(`  ${created}/${toCreate.length} Kunden angelegt`)
  }

  for (const batch of chunk(addressBacklog, BATCH)) {
    const addresses = batch.flatMap((entry) =>
      entry.customer.addresses.map((a) => ({
        ...toAddressInput(a),
        customer_id: entry.customerId,
      }))
    )
    if (!addresses.length) {
      continue
    }
    await createCustomerAddressesWorkflow(container).run({ input: { addresses } })
    createdAddresses += addresses.length
  }

  logger.info("")
  logger.info(`Fertig. ${created} Kunden und ${createdAddresses} Adressen angelegt.`)
  logger.info(
    "Keiner dieser Kunden hat ein Passwort. Vor dem Umzug muss der " +
      "„Passwort vergessen“-Ablauf auch für Kunden ohne auth_identity greifen — " +
      "siehe docs/odoo-datenmigration.md."
  )
}

function toAddressInput(a: PlannedCustomer["addresses"][number]) {
  return {
    address_name: a.address_name,
    company: a.company,
    first_name: a.first_name,
    last_name: a.last_name,
    address_1: a.address_1,
    address_2: a.address_2,
    city: a.city,
    postal_code: a.postal_code,
    province: a.province,
    country_code: a.country_code,
    phone: a.phone,
    is_default_billing: a.is_default_billing,
    is_default_shipping: a.is_default_shipping,
    metadata: { odoo_partner_id: a.odoo_partner_id },
  }
}

function countryHistogram(customers: PlannedCustomer[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of customers) {
    for (const a of c.addresses) {
      out[a.country_code] = (out[a.country_code] ?? 0) + 1
    }
  }
  return out
}

/** Lange ID-Listen kürzen, damit das Log lesbar bleibt. */
function formatIds(ids: number[], max = 40): string {
  if (ids.length <= max) {
    return ids.join(", ")
  }
  return `${ids.slice(0, max).join(", ")} … (+${ids.length - max})`
}

function chunk<T>(arr: T[], n: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n)
  )
}
