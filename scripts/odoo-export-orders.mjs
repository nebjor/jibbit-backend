#!/usr/bin/env node
/**
 * Odoo → jibbit: Bestellungen (sale.order + sale.order.line) exportieren.
 *
 * ⚠ PERSONENDATEN. Siehe Kopf von odoo-export-customers.mjs und
 *   docs/odoo-datenmigration.md.
 *
 * ⚠ DIESER EXPORT WIRD NICHT NACH MEDUSA IMPORTIERT — mit Absicht.
 *
 *   Die historischen Bestellungen bleiben in Odoo. Das ist die Archivinstanz
 *   für Buchhaltung (OR 958f: 10 Jahre Aufbewahrung) und Gewährleistung.
 *
 *   Medusa v2 legt Bestellungen nicht als Datensatz an, sondern als Ergebnis
 *   von Workflows: createOrderWorkflow reserviert Bestand, erzeugt
 *   Payment Collections und Fulfillments und sendet Events. Ein Massenimport
 *   alter Bestellungen würde also Lagerbestände verschieben, Zahlungsaufträge
 *   für längst bezahlte Rechnungen anlegen und Bestätigungsmails auslösen.
 *   Schreibt man stattdessen direkt in die Tabellen, entstehen Bestellungen
 *   ohne Payment Collection und ohne Fulfillment — der Admin zeigt sie an,
 *   jede Aktion darauf läuft ins Leere.
 *
 *   Der Export ist deshalb: Sicherungskopie und Datengrundlage für
 *   Auswertungen (Wer hat wie oft was gekauft? Welche Artikel tragen den
 *   Umsatz?). Für Kundengruppen und Sortimentsentscheidungen im neuen Shop
 *   reicht das.
 *
 * Odoo-Eigenheiten, die hier zählen:
 *
 *  • `state` unterscheidet Angebot von Auftrag:
 *      draft  = Angebotsentwurf        sent  = Angebot verschickt
 *      sale   = bestätigter Auftrag    done  = abgeschlossen (gesperrt)
 *      cancel = storniert
 *    Nur `sale` und `done` sind echte Bestellungen. Angebote und stornierte
 *    Aufträge werden mitexportiert, aber als solche markiert — sonst zählt
 *    jede Auswertung Umsatz mit, den es nie gab.
 *
 *  • sale.order.line enthält auch Zwischenüberschriften und Notizzeilen
 *    (`display_type` = 'line_section' / 'line_note'). Die haben kein Produkt,
 *    keine Menge und keinen Preis — in einer Summe verfälschen sie die
 *    Positionszahl. Sie werden verworfen und nur gezählt. (Ihr Freitext kann
 *    zudem Personendaten enthalten, die nirgends sonst stehen.)
 *
 *  • `partner_id`, `partner_invoice_id` und `partner_shipping_id` sind drei
 *    verschiedene res.partner-Zeilen — der Kunde und seine beiden Adressen.
 *    Exportiert werden die IDs, damit sich die Bestellung gegen partners.json
 *    auflösen lässt.
 *
 * Nutzung:
 *   export ODOO_URL=…  ODOO_DB=…  ODOO_USER=…  ODOO_API_KEY=…
 *   node scripts/odoo-export-orders.mjs [ausgabe-verzeichnis] [optionen]
 *
 * Optionen (ohne Bindestrich):
 *   states=sale,done       nur diese Zustände (Default: alle)
 *   from=2020-01-01        nur Bestellungen ab diesem Datum
 *   confirmed-only         Kurzform für states=sale,done
 */

import { odooConfigFromEnv, createClient, idOf, nameOf, chunk, writeOut } from "./lib/odoo-rpc.mjs"

const KNOWN_FLAGS = new Set(["confirmed-only"])

const raw = process.argv.slice(2).map((a) => (a.startsWith("--") ? a.slice(2) : a))
const FLAGS = new Set(raw.filter((a) => KNOWN_FLAGS.has(a)))
const VALUES = new Map(
  raw.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)])
)
const positional = raw.filter((a) => !KNOWN_FLAGS.has(a) && !a.includes("="))
const OUT_DIR = positional[0] ?? "odoo-export"

if (positional.length > 1) {
  console.error(`Zu viele Argumente: ${positional.join(", ")}`)
  process.exit(1)
}

const CONFIRMED = new Set(["sale", "done"])

const ORDER_FIELDS = [
  "id",
  "name",
  "state",
  "date_order",
  "partner_id",
  "partner_invoice_id",
  "partner_shipping_id",
  "pricelist_id",
  "currency_id",
  "amount_untaxed",
  "amount_tax",
  "amount_total",
  "client_order_ref",
  "origin",
  "invoice_status",
  "delivery_status",
  "payment_term_id",
  "user_id",
  "team_id",
  "company_id",
  "create_date",
  "write_date",
]

const LINE_FIELDS = [
  "id",
  "order_id",
  "sequence",
  "display_type",
  "product_id",
  "product_template_id",
  "name",
  "product_uom_qty",
  "qty_delivered",
  "qty_invoiced",
  "product_uom",
  "price_unit",
  "discount",
  "price_subtotal",
  "price_total",
  "tax_id",
  "currency_id",
]

/**
 * Bewusst NICHT exportiert: `note` (Kundenbemerkung zur Bestellung),
 * `access_token` (Zugriffstoken für das Kundenportal — ein Geheimnis) und
 * alle Anhänge. Siehe DSG-Abschnitt in docs/odoo-datenmigration.md.
 */

async function main() {
  const config = odooConfigFromEnv()
  const client = createClient(config)

  console.log(`Verbinde mit ${config.url} (DB ${config.db}) …`)
  await client.login()
  console.log(`  angemeldet als uid=${client.uid}`)

  // ─── Domain zusammensetzen ────────────────────────────────────────────────
  const domain = []

  const statesArg = FLAGS.has("confirmed-only") ? "sale,done" : VALUES.get("states")
  if (statesArg) {
    const wanted = statesArg.split(",").map((s) => s.trim()).filter(Boolean)
    domain.push(["state", "in", wanted])
    console.log(`Zustände: ${wanted.join(", ")}`)
  }

  const from = VALUES.get("from")
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new Error(`from= erwartet JJJJ-MM-TT, bekam "${from}"`)
    }
    domain.push(["date_order", ">=", `${from} 00:00:00`])
  }

  // ─── Bestellungen ─────────────────────────────────────────────────────────
  const orderFields = await client.existingFields("sale.order", ORDER_FIELDS)
  const orders = await client.kw(
    "sale.order",
    "search_read",
    [domain, orderFields],
    { context: { active_test: false }, order: "date_order asc" }
  )
  console.log(`Bestellungen: ${orders.length}`)

  if (!orders.length) {
    console.warn("  ! Keine Bestellungen gefunden — stimmen states=/from=?")
  }

  // ─── Positionen ───────────────────────────────────────────────────────────
  const lineFields = await client.existingFields("sale.order.line", LINE_FIELDS)
  const orderIds = orders.map((o) => o.id)
  const rawLines = []
  for (const ids of chunk(orderIds, 200)) {
    const rows = await client.kw(
      "sale.order.line",
      "search_read",
      [[["order_id", "in", ids]], lineFields],
      { context: { active_test: false }, order: "order_id, sequence, id" }
    )
    rawLines.push(...rows)
  }

  const layoutLines = rawLines.filter((l) => l.display_type)
  const lines = rawLines.filter((l) => !l.display_type)
  console.log(
    `Positionen: ${lines.length}` +
      (layoutLines.length ? ` (${layoutLines.length} Abschnitts-/Notizzeilen verworfen)` : "")
  )

  const byOrder = new Map()
  for (const l of lines) {
    const oid = idOf(l.order_id)
    if (!byOrder.has(oid)) {
      byOrder.set(oid, [])
    }
    byOrder.get(oid).push({
      id: l.id,
      sequence: l.sequence ?? null,
      product_id: idOf(l.product_id),
      product_name: nameOf(l.product_id),
      product_tmpl_id: idOf(l.product_template_id),
      description: l.name || null,
      quantity: l.product_uom_qty ?? null,
      qty_delivered: l.qty_delivered ?? null,
      qty_invoiced: l.qty_invoiced ?? null,
      uom: nameOf(l.product_uom),
      price_unit: l.price_unit ?? null,
      discount_percent: l.discount ?? 0,
      price_subtotal: l.price_subtotal ?? null,
      price_total: l.price_total ?? null,
      taxes: Array.isArray(l.tax_id) ? l.tax_id : [],
      currency: nameOf(l.currency_id),
    })
  }

  const normalized = orders.map((o) => ({
    id: o.id,
    reference: o.name || null,
    state: o.state || null,
    // Der eine Wert, auf den es bei jeder Auswertung ankommt.
    is_confirmed: CONFIRMED.has(o.state),
    is_quotation: o.state === "draft" || o.state === "sent",
    is_cancelled: o.state === "cancel",
    date_order: o.date_order || null,
    partner_id: idOf(o.partner_id),
    partner_invoice_id: idOf(o.partner_invoice_id),
    partner_shipping_id: idOf(o.partner_shipping_id),
    pricelist_id: idOf(o.pricelist_id),
    pricelist: nameOf(o.pricelist_id),
    currency: nameOf(o.currency_id),
    amount_untaxed: o.amount_untaxed ?? null,
    amount_tax: o.amount_tax ?? null,
    amount_total: o.amount_total ?? null,
    client_order_ref: o.client_order_ref || null,
    origin: o.origin || null,
    invoice_status: o.invoice_status || null,
    delivery_status: o.delivery_status || null,
    payment_term: nameOf(o.payment_term_id),
    salesperson_id: idOf(o.user_id),
    company_id: idOf(o.company_id),
    create_date: o.create_date || null,
    write_date: o.write_date || null,
    lines: byOrder.get(o.id) ?? [],
  }))

  await writeOut(OUT_DIR, "orders.json", normalized, { personal: true })
  await writeOut(OUT_DIR, "orders-summary.json", summarize(normalized, layoutLines.length))

  const s = summarize(normalized, layoutLines.length)
  console.log("")
  console.log(`Fertig. ${s.total} Bestellungen, ${s.line_count} Positionen.`)
  console.log(`  bestätigt ${s.confirmed} · Angebote ${s.quotations} · storniert ${s.cancelled}`)
  console.log(`  Umsatz bestätigt: ${s.confirmed_revenue.toFixed(2)} (Summe amount_total)`)
  console.log(`  Zeitraum: ${s.first_order_date ?? "—"} … ${s.last_order_date ?? "—"}`)
  console.log("")
  console.log("Diese Daten werden NICHT nach Medusa importiert — siehe Kopf dieses Scripts.")
}

/** Zusammenfassung ohne Personendaten. */
function summarize(orders, droppedLayoutLines) {
  const byState = {}
  for (const o of orders) {
    byState[o.state ?? "—"] = (byState[o.state ?? "—"] ?? 0) + 1
  }

  const confirmed = orders.filter((o) => o.is_confirmed)
  const dates = orders.map((o) => o.date_order).filter(Boolean).sort()

  const perPartner = new Map()
  for (const o of confirmed) {
    perPartner.set(o.partner_id, (perPartner.get(o.partner_id) ?? 0) + 1)
  }

  return {
    generated_at: new Date().toISOString(),
    total: orders.length,
    by_state: byState,
    confirmed: confirmed.length,
    quotations: orders.filter((o) => o.is_quotation).length,
    cancelled: orders.filter((o) => o.is_cancelled).length,
    line_count: orders.reduce((n, o) => n + o.lines.length, 0),
    dropped_layout_lines: droppedLayoutLines,
    // Nur über bestätigte Bestellungen — Angebote sind kein Umsatz.
    confirmed_revenue: confirmed.reduce((n, o) => n + (o.amount_total ?? 0), 0),
    distinct_confirmed_customers: perPartner.size,
    repeat_customers: [...perPartner.values()].filter((n) => n > 1).length,
    orders_without_partner: orders.filter((o) => !o.partner_id).map((o) => o.id),
    first_order_date: dates[0] ?? null,
    last_order_date: dates[dates.length - 1] ?? null,
  }
}

main().catch((e) => {
  console.error(`\nAbbruch: ${e.message}`)
  process.exit(1)
})
