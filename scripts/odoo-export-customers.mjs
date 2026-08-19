#!/usr/bin/env node
/**
 * Odoo → jibbit: Kunden (res.partner) exportieren.
 *
 * ⚠ PERSONENDATEN. Die Ausgabe fällt unter das Schweizer DSG. Sie gehört
 *   nicht ins Repository (siehe .gitignore), nicht in ein Ticket und nicht in
 *   einen Chat. Aufbewahrung und Löschung: docs/odoo-datenmigration.md.
 *
 * Warum ein eigenes Script und nicht ein Zweig in odoo-export.mjs:
 * Der Preis-Export läuft mehrmals, während man Staffeln zurechtrückt. Kunden
 * zieht man einmal, kurz vor dem Umzug. Beides in einem Lauf zu bündeln hiesse,
 * bei jedem Preisexperiment eine Kopie der Kundendatei anzulegen.
 *
 * Was Odoo hier schwierig macht — und wie dieses Script damit umgeht:
 *
 *  • res.partner ist EIN Modell für alles: Firmen, Privatpersonen,
 *    Ansprechpartner, Rechnungs- und Lieferadressen, Lieferanten, Mitarbeiter.
 *    Unterschieden wird über `is_company`, `parent_id` und `type`.
 *    → Exportiert werden per Default nur Partner mit `customer_rank > 0`
 *      plus deren Unterkontakte (Adressen haben selbst Rang 0).
 *
 *  • `country_id` kommt als [17, "Switzerland"]. Der Name ist sprachabhängig
 *    und für Medusa wertlos — gebraucht wird der ISO-Code "CH". Deshalb wird
 *    res.country einmal gelesen und id → code aufgelöst. Dasselbe für
 *    res.country.state.
 *
 *  • Archivierte Partner (`active = false`) sind in Odoo unsichtbar, stehen
 *    aber noch an alten Bestellungen. Sie werden mitexportiert und markiert;
 *    der Import lässt sie standardmässig liegen.
 *
 * Die Zuordnung „welcher Partner wird ein Medusa-Kunde, welcher nur eine
 * Adresse" passiert NICHT hier, sondern beim Import
 * (backend/src/scripts/odoo-customer-mapping.ts) — dort ist sie testbar,
 * ohne dass eine Odoo-Instanz laufen muss.
 *
 * Voraussetzungen: Node 20+ (globales fetch). Keine npm-Abhängigkeiten.
 *
 * Nutzung:
 *   export ODOO_URL=https://jibbit.ch
 *   export ODOO_DB=jibbit
 *   export ODOO_USER=…
 *   export ODOO_API_KEY=…            # Odoo Online: API-Key, nicht das Passwort
 *   node scripts/odoo-export-customers.mjs [ausgabe-verzeichnis] [optionen]
 *
 * Optionen (ohne Bindestrich, wie bei den Medusa-Scripten):
 *   all-partners       auch Partner ohne customer_rank exportieren
 *                      (Lieferanten, Mitarbeiter — normalerweise unerwünscht)
 *   skip-archived      archivierte Partner gar nicht erst holen
 */

import {
  odooConfigFromEnv,
  createClient,
  idOf,
  nameOf,
  chunk,
  writeOut,
  loadCountryCodes,
  loadStateCodes,
} from "./lib/odoo-rpc.mjs"

const KNOWN_FLAGS = new Set(["all-partners", "skip-archived"])

const argv = process.argv.slice(2).map((a) => (a.startsWith("--") ? a.slice(2) : a))
const FLAGS = new Set(argv.filter((a) => KNOWN_FLAGS.has(a)))
const OUT_DIR = argv.find((a) => !KNOWN_FLAGS.has(a)) ?? "odoo-export"

const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a) && a !== OUT_DIR)
if (unknown.length) {
  console.error(`Unbekannte Argumente: ${unknown.join(", ")}`)
  process.exit(1)
}

const PARTNER_FIELDS = [
  "id",
  "name",
  "display_name",
  "is_company",
  "company_type",
  "parent_id",
  "type",
  "email",
  "phone",
  "mobile",
  "street",
  "street2",
  "city",
  "zip",
  "state_id",
  "country_id",
  "vat",
  "lang",
  "ref",
  "function",
  "title",
  "customer_rank",
  "supplier_rank",
  "active",
  "commercial_partner_id",
  "property_product_pricelist",
  "create_date",
  "write_date",
]

/**
 * Bewusst NICHT exportiert: `comment` (interne Notizen zum Kunden),
 * `website`, `image_*`, `bank_ids`. Freitextnotizen enthalten erfahrungsgemäss
 * Gesundheits- und Bonitätsangaben — Daten, die Medusa nicht braucht und die
 * nach DSG besonders heikel sind. Wer sie braucht, findet sie in Odoo.
 */

async function main() {
  const config = odooConfigFromEnv()
  const client = createClient(config)

  console.log(`Verbinde mit ${config.url} (DB ${config.db}) …`)
  await client.login()
  console.log(`  angemeldet als uid=${client.uid}`)

  const fields = await client.existingFields("res.partner", PARTNER_FIELDS)
  const hasRank = fields.includes("customer_rank")

  // ─── 1) Wer ist Kunde? ────────────────────────────────────────────────────
  // Odoo 13+ markiert Kunden über customer_rank (> 0 = hat schon bestellt oder
  // wurde als Kunde angelegt). Ohne das Feld — oder mit all-partners — bleibt
  // nur „alles nehmen".
  const activeTest = { active_test: false }
  const domain =
    FLAGS.has("all-partners") || !hasRank ? [] : [["customer_rank", ">", 0]]

  if (!hasRank && !FLAGS.has("all-partners")) {
    console.warn(
      "  ! Feld customer_rank fehlt — es werden ALLE Partner exportiert.\n" +
        "    Bitte die Ausgabe vor dem Import durchsehen."
    )
  }

  let partners = await client.kw(
    "res.partner",
    "search_read",
    [domain, fields],
    { context: activeTest }
  )
  console.log(`Kundenpartner: ${partners.length}`)

  // ─── 2) Unterkontakte nachladen ───────────────────────────────────────────
  // Rechnungs- und Lieferadressen hängen als eigene res.partner-Zeilen unter
  // dem Kunden und haben selbst customer_rank = 0. Ohne diesen zweiten Zug
  // fehlen im Export genau die Adressen, die wir eigentlich wollen.
  if (domain.length) {
    const ids = new Set(partners.map((p) => p.id))
    const children = []
    for (const ids_ of chunk([...ids], 200)) {
      const rows = await client.kw(
        "res.partner",
        "search_read",
        [[["parent_id", "in", ids_]], fields],
        { context: activeTest }
      )
      children.push(...rows)
    }
    const added = children.filter((c) => !ids.has(c.id))
    partners = partners.concat(added)
    console.log(`Unterkontakte/Adressen: ${added.length}`)
  }

  if (FLAGS.has("skip-archived")) {
    const before = partners.length
    partners = partners.filter((p) => p.active !== false)
    console.log(`Archivierte übersprungen: ${before - partners.length}`)
  }

  // ─── 3) Länder- und Kantonscodes auflösen ─────────────────────────────────
  const countries = await loadCountryCodes(client)
  const states = await loadStateCodes(client)

  const normalized = partners.map((p) => ({
    id: p.id,
    name: p.name || null,
    display_name: p.display_name || null,
    is_company: p.is_company === true,
    company_type: p.company_type ?? null,
    parent_id: idOf(p.parent_id),
    parent_name: nameOf(p.parent_id),
    type: p.type || null,
    email: p.email || null,
    phone: p.phone || null,
    mobile: p.mobile || null,
    street: p.street || null,
    street2: p.street2 || null,
    city: p.city || null,
    zip: p.zip || null,
    state_code: states.get(idOf(p.state_id)) ?? null,
    state_name: nameOf(p.state_id),
    country_code: countries.get(idOf(p.country_id)) ?? null,
    country_name: nameOf(p.country_id),
    vat: p.vat || null,
    lang: p.lang || null,
    ref: p.ref || null,
    function: p.function || null,
    title: nameOf(p.title) ?? (p.title || null),
    customer_rank: p.customer_rank ?? null,
    supplier_rank: p.supplier_rank ?? null,
    active: p.active !== false,
    commercial_partner_id: idOf(p.commercial_partner_id),
    commercial_partner_name: nameOf(p.commercial_partner_id),
    pricelist_id: idOf(p.property_product_pricelist),
    pricelist: nameOf(p.property_product_pricelist),
    create_date: p.create_date || null,
    write_date: p.write_date || null,
  }))

  // ─── 4) Schreiben ─────────────────────────────────────────────────────────
  await writeOut(OUT_DIR, "partners.json", normalized, { personal: true })
  await writeOut(OUT_DIR, "partners-summary.json", summarize(normalized))

  const s = summarize(normalized)
  console.log("")
  console.log(`Fertig. ${s.total} Partner exportiert.`)
  console.log(`  Firmen ${s.companies} · Privat ${s.private_persons}`)
  console.log(`  mit E-Mail ${s.with_email} · ohne E-Mail ${s.without_email}`)
  console.log(`  Unteradressen: ${JSON.stringify(s.by_type)}`)
  console.log(`  doppelte E-Mail-Adressen: ${s.duplicate_email_groups}`)
  if (s.without_country) {
    console.log(
      `  ! ${s.without_country} Adressen ohne Land — Medusa braucht einen ` +
        `Ländercode, diese Adressen fallen beim Import weg.`
    )
  }
}

/**
 * Zusammenfassung OHNE Personendaten — nur Zahlen und Odoo-IDs.
 * Diese Datei darf man gefahrlos anschauen, weiterreichen und aufheben.
 */
function summarize(rows) {
  const byType = {}
  for (const r of rows) {
    const key = r.parent_id ? (r.type ?? "unbekannt") : "eigenständig"
    byType[key] = (byType[key] ?? 0) + 1
  }

  const emails = new Map()
  for (const r of rows) {
    const e = (r.email ?? "").trim().toLowerCase()
    if (!e) {
      continue
    }
    emails.set(e, (emails.get(e) ?? 0) + 1)
  }

  const byCountry = {}
  for (const r of rows) {
    const c = r.country_code ?? "—"
    byCountry[c] = (byCountry[c] ?? 0) + 1
  }

  return {
    generated_at: new Date().toISOString(),
    total: rows.length,
    companies: rows.filter((r) => r.is_company).length,
    private_persons: rows.filter((r) => !r.is_company).length,
    archived: rows.filter((r) => !r.active).length,
    with_email: rows.filter((r) => r.email).length,
    without_email: rows.filter((r) => !r.email).length,
    with_multiple_emails: rows.filter((r) => /[,;]/.test(r.email ?? "")).length,
    duplicate_email_groups: [...emails.values()].filter((n) => n > 1).length,
    without_country: rows.filter((r) => (r.street || r.city || r.zip) && !r.country_code)
      .length,
    by_type: byType,
    by_country: byCountry,
    // IDs sind für sich genommen keine Personendaten, helfen aber beim
    // Nachschlagen in Odoo, wenn beim Import etwas auffällt.
    archived_ids: rows.filter((r) => !r.active).map((r) => r.id),
  }
}

main().catch((e) => {
  console.error(`\nAbbruch: ${e.message}`)
  process.exit(1)
})
