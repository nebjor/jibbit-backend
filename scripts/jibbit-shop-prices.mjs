#!/usr/bin/env node
/**
 * jibbit.ch (Odoo) → data/price-lists.json: reguläre Preise und Aktionspreise
 * aus dem ÖFFENTLICHEN Shop lesen — ohne Zugangsdaten.
 *
 * Warum nicht JSON-RPC wie odoo-export.mjs? Der braucht ODOO_URL, ODOO_DB,
 * ODOO_USER und ODOO_API_KEY. Die öffentliche Website zeigt aber genau die
 * Zahlen, die übernommen werden sollen — durchgestrichener Listenpreis und
 * Aktionspreis — und Odoo liefert sie auch strukturiert: die Website-Route
 * `/website_sale/get_combination_info` ist eine öffentliche JSON-Route und
 * antwortet mit `list_price` (regulär), `price` (reduziert, Menge 1) und
 * `has_discounted_price`. HTML wird hier NICHT zerlegt; aus den Shopseiten
 * werden nur die Produkt-IDs aus den Links eingesammelt.
 *
 * Grenzen dieses Wegs (bewusst in Kauf genommen):
 *   - Nur veröffentlichte Produkte. Was im Shop nicht (mehr) gelistet ist,
 *     bekommt keinen regulären Preis (Kailar, RAW Black KSS, …).
 *   - Nur der Preis für Menge 1. Die Mengenstaffeln der Aktion stehen
 *     bereits in data/catalog.json — der Preis für Menge 1 dient beim Import
 *     als Kreuzprüfung, dass beide Datenstände zusammenpassen.
 *   - Die Preise kommen so, wie die Website sie anzeigt (inkl. MwSt.-Sicht
 *     der Website). Da die Aktionspreise in Medusa aus derselben Sicht
 *     stammen (catalog.json), ist das Verhältnis regulär/Aktion konsistent.
 *
 * Wer die Odoo-Schlüssel hat, kann stattdessen `product.template.list_price`
 * über scripts/odoo-export.mjs ziehen — die Anbindung existiert schon. Für
 * den hier gebrauchten Zweck (ein Listenpreis pro Produkt) ist die
 * öffentliche Route aber vollständig.
 *
 * Voraussetzungen: Node 20+ (globales fetch). Keine npm-Abhängigkeiten.
 *
 * Nutzung:
 *   node scripts/jibbit-shop-prices.mjs [https://jibbit.ch] [data/price-lists.json]
 */

import { writeFile } from "node:fs/promises"

const BASE = (process.argv[2] ?? "https://jibbit.ch").replace(/\/+$/, "")
const OUT = process.argv[3] ?? "data/price-lists.json"

/** Odoo setzt eine Session-Cookie; ohne sie liefern Folgeseiten teils 303. */
let cookies = ""

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "jibbit-price-export/1.0", Cookie: cookies },
    redirect: "follow",
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length) {
    cookies = setCookie.map((c) => c.split(";")[0]).join("; ")
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} für ${url}`)
  }
  return res.text()
}

/**
 * Öffentliche Odoo-Website-Route, gleiche Maschinerie wie der "In den
 * Warenkorb"-Dialog: liefert die Preisfelder als JSON, kein HTML-Parsen.
 */
async function combinationInfo(templateId) {
  const res = await fetch(`${BASE}/website_sale/get_combination_info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "jibbit-price-export/1.0",
      Cookie: cookies,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        product_template_id: templateId,
        product_id: false,
        combination: [],
        add_qty: 1,
        parent_combination: [],
      },
    }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} für get_combination_info(${templateId})`)
  }
  const body = await res.json()
  if (body.error) {
    throw new Error(
      `Odoo-Fehler für Template ${templateId}: ${JSON.stringify(body.error.data?.message ?? body.error)}`
    )
  }
  return body.result
}

async function main() {
  // ─── 1. Produkt-IDs von den Shopseiten einsammeln ────────────
  // Die Produkt-URL endet auf die Odoo-Template-ID (…/shop/<slug>-<id>).
  // Mehr braucht es aus dem HTML nicht.
  const seen = new Set()
  const queue = [`${BASE}/shop`]
  const templates = new Map() // id -> slug

  while (queue.length) {
    const url = queue.pop()
    if (seen.has(url)) continue
    seen.add(url)

    const html = await get(url)

    for (const m of html.matchAll(/href="([^"]*\/shop\/page\/\d+)"/g)) {
      const next = new URL(m[1], BASE).href
      if (!seen.has(next)) queue.push(next)
    }
    for (const m of html.matchAll(/href="[^"]*\/shop\/([a-z0-9-]+?)-(\d+)"/g)) {
      templates.set(Number(m[2]), m[1])
    }
  }

  console.log(`${seen.size} Shopseiten gelesen, ${templates.size} Produkte gefunden.`)
  if (!templates.size) {
    console.error("Keine Produkte gefunden — hat sich die Shop-URL geändert?")
    process.exit(1)
  }

  // ─── 2. Preise strukturiert abfragen ─────────────────────────
  // Odoo rechnet in Binär-Floats (40.800000000000004). Auf zwei Nachkomma-
  // stellen festklopfen — die 5-Rappen-Rundung ist Sache des Imports.
  const round2 = (n) => Number(Number(n).toFixed(2))

  const prices = []
  for (const id of [...templates.keys()].sort((a, b) => a - b)) {
    const info = await combinationInfo(id)
    prices.push({
      odoo_template_id: id,
      odoo_name: info.display_name,
      regular_price: round2(info.list_price),
      promo_price: round2(info.price),
      has_discount: info.has_discounted_price,
    })
    const tag = info.has_discounted_price ? "" : "  (kein Rabatt)"
    console.log(
      `  ${String(id).padStart(4)}  ${info.display_name.padEnd(50)} ` +
        `regulär ${String(info.list_price).padStart(7)}  ` +
        `Aktion ${String(info.price).padStart(7)}${tag}`
    )
  }

  // ─── 3. Versionierbar ablegen ────────────────────────────────
  const out = {
    source: {
      url: `${BASE}/shop`,
      method: "website_sale/get_combination_info (öffentliche JSON-Route, ohne Login)",
      fetched_at: new Date().toISOString(),
    },
    currency: "chf",
    prices,
  }

  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n")
  console.log(`\n${prices.length} Preise nach ${OUT} geschrieben.`)
  console.log(
    "Zuordnung zu Medusa-Produkten und Import: " +
      "backend/src/scripts/import-price-lists.ts (siehe docs/preislisten.md)."
  )
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
