#!/usr/bin/env node
/**
 * Odoo → jibbit: Preisregeln und Staffelpreise exportieren.
 *
 * Warum ein Script und kein CSV-Export aus dem Odoo-UI:
 * Odoo-Preisregeln sind oft Formeln ("−15 % auf Kategorie Papers ab 24 Stk.").
 * Medusa kennt keine Formeln, sondern nur konkrete Preiszeilen pro Variante.
 * Wir müssen die Regeln also *auflösen*. Statt Odoos Formel-Logik nachzubauen
 * (Basis-Preisliste, Marge-Klemmung, Rundung, Datumsfenster …) fragen wir
 * Odoo selbst: das Feld product.product.price ist ein Compute-Feld, das den
 * Kontext `pricelist` und `quantity` auswertet. Wir lesen es einmal pro
 * Mengenstufe — was rauskommt, ist per Definition genau das, was Odoo im
 * Verkauf berechnen würde.
 *
 * Zusätzlich werden die Rohregeln exportiert, damit man nachvollziehen kann,
 * warum ein Preis so ist wie er ist.
 *
 * Voraussetzungen: Node 20+ (globales fetch). Keine npm-Abhängigkeiten.
 *
 * Nutzung:
 *   export ODOO_URL=https://meinefirma.odoo.com
 *   export ODOO_DB=meinefirma
 *   export ODOO_USER=demo@example.com
 *   export ODOO_API_KEY=xxxxxxxx        # Odoo Online: API-Key, nicht das Passwort
 *   node scripts/odoo-export.mjs [ausgabe-verzeichnis]
 *
 * Der API-Key kommt aus Odoo unter: Profil → Konto-Sicherheit → Neuer API-Schlüssel.
 *
 * Kunden und Bestellungen liegen bewusst in eigenen Scripten:
 * odoo-export-customers.mjs und odoo-export-orders.mjs. Sie enthalten
 * Personendaten und sollen nicht bei jedem Preislauf mitgezogen werden.
 */

import {
  odooConfigFromEnv,
  createClient,
  nameOf,
  chunk,
  toCsv,
  writeOut,
} from "./lib/odoo-rpc.mjs"

const OUT_DIR = process.argv[2] ?? "odoo-export"

let CONFIG
try {
  CONFIG = odooConfigFromEnv()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const client = createClient(CONFIG)
const { login, kw, existingFields } = client

// ─── Export ──────────────────────────────────────────────────────────────────

const PRICELIST_FIELDS = [
  "id", "name", "currency_id", "company_id", "active", "sequence",
  "country_group_ids", "discount_policy",
]

const ITEM_FIELDS = [
  "id", "pricelist_id", "applied_on", "product_tmpl_id", "product_id", "categ_id",
  "min_quantity", "compute_price", "fixed_price", "percent_price",
  "base", "base_pricelist_id", "price_discount", "price_surcharge",
  "price_round", "price_min_margin", "price_max_margin",
  "date_start", "date_end", "currency_id", "company_id",
]

const PRODUCT_FIELDS = [
  "id", "default_code", "barcode", "name", "display_name", "list_price",
  "standard_price", "product_tmpl_id", "categ_id", "uom_id", "active", "type",
]

async function main() {
  console.log(`Verbinde mit ${CONFIG.url} (DB ${CONFIG.db}) …`)
  await login()
  console.log(`  angemeldet als uid=${client.uid}`)

  // 1) Preislisten
  const plFields = await existingFields("product.pricelist", PRICELIST_FIELDS)
  const pricelists = await kw(
    "product.pricelist", "search_read", [[], plFields],
    { context: { active_test: false } }
  )
  console.log(`Preislisten: ${pricelists.length}`)

  // 2) Rohregeln — alle auf einmal, ohne Domain-Filter
  const itemFields = await existingFields("product.pricelist.item", ITEM_FIELDS)
  const items = await kw(
    "product.pricelist.item", "search_read", [[], itemFields],
    { context: { active_test: false } }
  )
  console.log(`Preisregeln: ${items.length}`)

  // 3) Produktvarianten
  const prodFields = await existingFields("product.product", PRODUCT_FIELDS)
  const products = await kw(
    "product.product", "search_read", [[["type", "!=", "service"]], prodFields],
    { context: { active_test: false } }
  )
  console.log(`Produktvarianten: ${products.length}`)

  // 4) Mengenstufen bestimmen.
  //    Jede min_quantity aus den Regeln ist eine Stufe, dazu immer die 1.
  //    Auch Regeln ohne min_quantity zählen als Stufe 1.
  const breakpoints = [
    ...new Set([1, ...items.map((i) => Math.max(1, Math.round(i.min_quantity || 1)))]),
  ].sort((a, b) => a - b)
  console.log(`Mengenstufen: ${breakpoints.join(", ")}`)

  // 5) Preise auflösen: Odoo selbst rechnen lassen.
  //    Ein read() pro Preisliste × Mengenstufe über alle Produkte.
  const productIds = products.map((p) => p.id)
  const resolved = {} // pricelistId -> qty -> productId -> price
  let probeFailed = null

  for (const pl of pricelists) {
    resolved[pl.id] = {}
    for (const qty of breakpoints) {
      const byProduct = {}
      try {
        for (const ids of chunk(productIds, 400)) {
          const rows = await kw(
            "product.product", "read", [ids, ["price"]],
            { context: { pricelist: pl.id, quantity: qty, active_test: false } }
          )
          for (const r of rows) {
            byProduct[r.id] = r.price
          }
        }
      } catch (e) {
        // Sollte das Compute-Feld in dieser Odoo-Version anders heissen,
        // brechen wir nicht ab — die Rohregeln sind trotzdem exportiert.
        probeFailed = e.message
        break
      }
      resolved[pl.id][qty] = byProduct
      process.stdout.write(`  ${pl.name} @ ${qty} Stk. ✓\r`)
    }
    if (probeFailed) break
  }
  console.log("")

  if (probeFailed) {
    console.warn(
      `  ! Preisauflösung fehlgeschlagen (${probeFailed}).\n` +
      `    Rohregeln werden trotzdem geschrieben, tiers.json bleibt leer.`
    )
  }

  // 6) Zu Staffeln verdichten: aufeinanderfolgende gleiche Preise zusammenfassen.
  const tiers = []
  if (!probeFailed) {
    for (const pl of pricelists) {
      const currency = nameOf(pl.currency_id) ?? "CHF"
      for (const p of products) {
        const steps = []
        for (const qty of breakpoints) {
          const price = resolved[pl.id]?.[qty]?.[p.id]
          if (price === undefined || price === null) {
            continue
          }
          const last = steps[steps.length - 1]
          // Nur eine neue Staffel anfangen, wenn sich der Preis wirklich ändert.
          if (last && Math.abs(last.price - price) < 1e-6) {
            continue
          }
          steps.push({ min_quantity: qty, max_quantity: null, price })
        }
        if (!steps.length) {
          continue
        }
        // max_quantity ergibt sich aus der nächsten Stufe; die letzte bleibt offen.
        for (let i = 0; i < steps.length - 1; i++) {
          steps[i].max_quantity = steps[i + 1].min_quantity - 1
        }

        tiers.push({
          sku: p.default_code || null,
          barcode: p.barcode || null,
          odoo_product_id: p.id,
          name: p.display_name ?? p.name,
          pricelist: pl.name,
          pricelist_id: pl.id,
          currency,
          list_price: p.list_price,
          has_discount: steps.length > 1,
          tiers: steps,
        })
      }
    }
  }

  // 7) Schreiben
  const write = (name, data) => writeOut(OUT_DIR, name, data)

  await write("pricelists.json", pricelists)
  await write("pricelist-items.json", items)
  await write("products.json", products)
  await write("tiers.json", tiers)
  await write("price-rules.csv", toCsv(items, itemFields))

  const withDiscount = tiers.filter((t) => t.has_discount)
  const withoutSku = tiers.filter((t) => t.has_discount && !t.sku)

  console.log("")
  console.log(`Fertig. ${tiers.length} Produkt/Preislisten-Kombinationen,`)
  console.log(`davon ${withDiscount.length} mit echten Mengenstaffeln.`)
  if (withoutSku.length) {
    console.log(
      `\n! ${withoutSku.length} Artikel mit Staffelpreis haben keine Artikelnummer ` +
      `(default_code) und lassen sich nicht gegen Medusa-SKUs abgleichen.`
    )
  }
}

main().catch((e) => {
  console.error(`\nAbbruch: ${e.message}`)
  process.exit(1)
})
