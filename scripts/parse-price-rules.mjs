#!/usr/bin/env node
/**
 * Odoo-Preisregeln aus einem Copy-Paste einlesen.
 *
 * Wenn kein Export zur Verfügung steht (Odoo Online ohne API-Zugang, oder man
 * will einfach nicht), kann man die Listenansicht der Preisregeln markieren und
 * hier reinkopieren. Erwartetes Format, eine Regel pro Zeile:
 *
 *   Produkt: Gizeh DW Extra Fine        20.00    CHF 1.40
 *   Variante: RAW Black KSS Papers (50 Stk (Display))   5.00   CHF 42.50
 *
 * Trennung zwischen den Spalten: zwei oder mehr Leerzeichen bzw. ein Tab.
 *
 * Erzeugt dieselben Dateien wie scripts/odoo-export.mjs, sodass
 * `medusa exec ./src/scripts/import-price-tiers.ts` beides frisst.
 *
 * Nutzung:
 *   node scripts/parse-price-rules.mjs preisregeln.txt [ausgabe-verzeichnis]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, isAbsolute } from "node:path"

const INPUT = process.argv[2]
const OUT_DIR = process.argv[3] ?? "odoo-export"

if (!INPUT) {
  console.error("Nutzung: node scripts/parse-price-rules.mjs <datei.txt> [ausgabe]")
  process.exit(1)
}

/**
 * Zeilen, die keine Katalogartikel sind. Versandprodukte tauchen in Odoo als
 * ganz normales Produkt mit Preisregel auf — in den Shop gehören sie nicht.
 */
const NOT_A_PRODUCT = [/^PostPac/i, /^Versand/i, /^Porto/i, /^Shipping/i]

// ─── Zeilen zerlegen ─────────────────────────────────────────────────────────

/** "Produkt: Name    20.00    CHF 1.40" -> { kind, rawName, minQty, price } */
function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }

  const parts = trimmed.split(/\s{2,}|\t+/).filter(Boolean)
  if (parts.length < 3) {
    return { error: "weniger als drei Spalten", line: trimmed }
  }

  const head = parts[0]
  const m = head.match(/^(Variante|Produkt)\s*:\s*(.+)$/i)
  if (!m) {
    return { error: "kein 'Produkt:' oder 'Variante:' am Zeilenanfang", line: trimmed }
  }

  const minQty = Number(parts[1].replace(/'/g, "").replace(",", "."))
  const priceRaw = parts[2].replace(/CHF/i, "").replace(/'/g, "").replace(",", ".")
  const price = Number(priceRaw)

  if (!Number.isFinite(minQty) || !Number.isFinite(price)) {
    return { error: "Menge oder Preis nicht lesbar", line: trimmed }
  }

  return {
    kind: m[1].toLowerCase() === "variante" ? "variant" : "product",
    rawName: m[2].trim(),
    minQty: Math.max(1, Math.round(minQty)),
    price,
  }
}

// ─── Namen deuten ────────────────────────────────────────────────────────────

/**
 * In den Odoo-Daten stecken drei Schreibweisen für dasselbe Konzept:
 *
 *   "Display: 24x Greengo Unbleached Slim Rolls"     eigenes Produkt
 *   "Box: 50x Elements King Slim Size Ultra Thin"    eigenes Produkt
 *   "RAW Black KSS Papers (50 Stk (Display))"        Variante des Produkts
 *
 * Alle drei landen hier als Display-Variante des jeweiligen Basisprodukts,
 * damit der Shop eine einzige, einheitliche Struktur bekommt.
 */
function interpret(entry) {
  const { rawName, kind } = entry

  // "Display: 24x Foo" / "Box: 50x Foo"
  const asPack = rawName.match(/^(Display|Box|Karton)\s*:\s*(\d+)\s*x\s*(.+)$/i)
  if (asPack) {
    return {
      product: cleanName(asPack[3]),
      ref: refOf(asPack[3]),
      packType: asPack[1].toLowerCase() === "box" ? "box" : "display",
      unitsPerPack: Number(asPack[2]),
    }
  }

  // "Foo (50 Stk (Display))" / "Foo (Display (34 Stk))"
  if (kind === "variant") {
    const paren = rawName.match(/^(.+?)\s*\((.+)\)\s*$/)
    if (paren) {
      const label = paren[2]
      const units = label.match(/(\d+)\s*Stk/i)
      const isPack = /display|box|karton/i.test(label)
      return {
        product: cleanName(paren[1]),
        ref: refOf(paren[1]),
        packType: isPack ? "display" : "single",
        unitsPerPack: units ? Number(units[1]) : 1,
      }
    }
  }

  return {
    product: cleanName(rawName),
    ref: refOf(rawName),
    packType: "single",
    unitsPerPack: 1,
  }
}

/** "[3] OCB Premium ..." -> "OCB Premium ..." */
const cleanName = (s) => s.replace(/^\[\d+\]\s*/, "").trim()
/** "[3] OCB Premium ..." -> "3" */
const refOf = (s) => (s.match(/^\[(\d+)\]/) ?? [])[1] ?? null

// ─── Staffeln bauen ──────────────────────────────────────────────────────────

function buildTiers(rules) {
  const byQty = new Map()
  for (const r of rules) {
    // Bei doppelten Mengen gewinnt der zuletzt gelesene Eintrag.
    byQty.set(r.minQty, r.price)
  }

  const steps = [...byQty.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([min_quantity, price]) => ({ min_quantity, max_quantity: null, price }))

  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].max_quantity = steps[i + 1].min_quantity - 1
  }
  return steps
}

// ─── Hauptlauf ───────────────────────────────────────────────────────────────

const lines = readFileSync(INPUT, "utf8").split(/\r?\n/)

const parsed = []
const failed = []
const ignored = []

for (const line of lines) {
  const entry = parseLine(line)
  if (!entry) {
    continue
  }
  if (entry.error) {
    failed.push(entry)
    continue
  }
  if (NOT_A_PRODUCT.some((re) => re.test(entry.rawName))) {
    ignored.push(entry.rawName)
    continue
  }
  parsed.push({ ...entry, ...interpret(entry) })
}

// product -> packKey -> Regeln
const catalog = new Map()

for (const e of parsed) {
  if (!catalog.has(e.product)) {
    catalog.set(e.product, { product: e.product, ref: e.ref, packs: new Map() })
  }
  const p = catalog.get(e.product)
  p.ref ??= e.ref

  const key = e.packType === "single" ? "single" : `${e.packType}:${e.unitsPerPack}`
  if (!p.packs.has(key)) {
    p.packs.set(key, {
      pack_type: e.packType,
      units_per_pack: e.unitsPerPack,
      rules: [],
    })
  }
  p.packs.get(key).rules.push(e)
}

const products = []
const missingBase = []
const inconsistent = []

for (const p of [...catalog.values()].sort((a, b) => a.product.localeCompare(b.product))) {
  const variants = []
  const single = p.packs.get("single")
  const singleTiers = single ? buildTiers(single.rules) : []

  for (const [, pack] of [...p.packs].sort((a, b) =>
    a[1].units_per_pack - b[1].units_per_pack
  )) {
    const tiers = buildTiers(pack.rules)

    if (tiers[0]?.min_quantity !== 1) {
      missingBase.push(
        `${p.product}${pack.pack_type === "single" ? "" : ` (${pack.units_per_pack}er)`}` +
        ` — günstigste Regel beginnt erst bei ${tiers[0]?.min_quantity}`
      )
    }

    // Für Gebinde: stimmt der Stückpreis mit der Einzelstaffel überein?
    // Wenn nicht, ist das kein Fehler, aber es lohnt sich ein Blick.
    if (pack.pack_type !== "single" && singleTiers.length) {
      const perUnit = tiers[0].price / pack.units_per_pack
      const singleAtSameCount =
        [...singleTiers].reverse().find((t) => t.min_quantity <= pack.units_per_pack)
          ?.price ?? null
      if (singleAtSameCount !== null) {
        const delta = Math.abs(perUnit - singleAtSameCount) / singleAtSameCount
        if (delta > 0.1) {
          inconsistent.push(
            `${p.product}: ${pack.units_per_pack}er-Gebinde kostet ` +
            `${perUnit.toFixed(2)}/Stk., einzeln ab ${pack.units_per_pack} Stk. ` +
            `aber ${singleAtSameCount.toFixed(2)}/Stk. ` +
            `(${(delta * 100).toFixed(0)} % Unterschied)`
          )
        }
      }
    }

    variants.push({
      label:
        pack.pack_type === "single"
          ? "Einzeln"
          : `${pack.pack_type === "box" ? "Box" : "Display"} (${pack.units_per_pack} Stk.)`,
      pack_type: pack.pack_type,
      units_per_pack: pack.units_per_pack,
      tiers,
    })
  }

  products.push({ product: p.product, ref: p.ref, variants })
}

// ─── Ausgabe ─────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true })

const write = (name, data) => {
  const path = join(OUT_DIR, name)
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2))
  console.log(`  → ${path}`)
}

// Flache Form, die import-price-tiers.ts direkt lesen kann.
const flat = []
for (const p of products) {
  for (const v of p.variants) {
    flat.push({
      sku: null, // muss noch zugeordnet werden, siehe sku-map.csv
      name: `${p.product} — ${v.label}`,
      product: p.product,
      variant_label: v.label,
      pack_type: v.pack_type,
      units_per_pack: v.units_per_pack,
      pricelist: "Odoo (Copy-Paste)",
      currency: "CHF",
      has_discount: v.tiers.length > 1,
      tiers: v.tiers,
    })
  }
}

write("catalog.json", products)
write("tiers.json", flat)

const csv = [
  "Produkt;Variante;Gebinde;Stk. pro Gebinde;Staffeln",
  ...flat.map((f) =>
    [
      f.product,
      f.variant_label,
      f.pack_type,
      f.units_per_pack,
      f.tiers
        .map(
          (t) =>
            `${t.min_quantity}${t.max_quantity ? `-${t.max_quantity}` : "+"}:` +
            t.price.toFixed(2)
        )
        .join(" | "),
    ]
      .map((c) => (/[";\n]/.test(String(c)) ? `"${c}"` : c))
      .join(";")
  ),
].join("\n")
write("review.csv", csv)

write(
  "sku-map.csv",
  ["Produkt;Variante;SKU", ...flat.map((f) => `${f.product};${f.variant_label};`)].join("\n")
)

// ─── Bericht ─────────────────────────────────────────────────────────────────

console.log("")
console.log(`${parsed.length} Regeln gelesen → ${products.length} Produkte, ${flat.length} Varianten.`)
console.log(`Davon mit Mengenstaffel: ${flat.filter((f) => f.has_discount).length}`)

if (ignored.length) {
  console.log(`\nÜbersprungen (kein Katalogartikel): ${[...new Set(ignored)].join(", ")}`)
}

if (failed.length) {
  console.log(`\n! ${failed.length} Zeilen nicht lesbar:`)
  failed.slice(0, 5).forEach((f) => console.log(`    ${f.error}: ${f.line.slice(0, 70)}`))
}

if (missingBase.length) {
  console.log(`\n! Ohne Preis für Menge 1 — der Warenkorb bricht sonst ab:`)
  missingBase.forEach((m) => console.log(`    ${m}`))
}

if (inconsistent.length) {
  console.log(`\n? Auffällige Gebindepreise (nur zur Kontrolle, kein Fehler):`)
  inconsistent.forEach((m) => console.log(`    ${m}`))
}

// Der Importer läuft aus backend/, deshalb der Sprung eine Ebene hoch —
// ausser bei einem absoluten Pfad, der schon von überall stimmt.
const tiersPath = isAbsolute(OUT_DIR)
  ? join(OUT_DIR, "tiers.json")
  : join("..", OUT_DIR, "tiers.json")

const catalogPath = tiersPath.replace(/tiers\.json$/, "catalog.json")

console.log("\nNächster Schritt — Produkte anlegen (aus backend/):")
console.log(`  npx medusa exec ./src/scripts/import-catalog.ts ${catalogPath} dry-run`)
console.log("\nPreise später aktualisieren:")
console.log(`  npx medusa exec ./src/scripts/import-price-tiers.ts ${tiersPath} dry-run`)
console.log("\n(Argumente ohne '--' — medusa exec lehnt unbekannte Optionen ab.)")
