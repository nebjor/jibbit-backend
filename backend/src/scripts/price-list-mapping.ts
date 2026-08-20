/**
 * Zuordnung der Odoo-Shop-Preise (data/price-lists.json) zu den
 * Medusa-Produkten aus data/catalog.json — der Kern des Preislisten-Imports,
 * deshalb pur und ohne Medusa-Container, damit er unit-testbar ist.
 *
 * Das Problem: die Namen auf jibbit.ch weichen vom Katalog ab, und zwar auf
 * drei Arten gleichzeitig.
 *
 *   1. Gebinde sind in Odoo EIGENE Produkte, in Medusa aber VARIANTEN:
 *      "Display: 25x Smoking Brown kurz (double window)" (Odoo)
 *      → Produkt "Smoking Brown kurz (double window)",
 *        Variante "Display (25 Stk.)" (Medusa).
 *   2. Manche Produkte tragen in Odoo eine Artikelnummer im Namen:
 *      "[4] RAW Classic Rolls Slim" — die [4] steht im Katalog als `ref`.
 *   3. Namen wurden umformuliert: "Smoking Brown Double Window" vs.
 *      "Smoking Brown kurz (double window)", "Elements King Size Ultra Thin"
 *      vs. "Elements King Slim Size Ultra Thin".
 *
 * Strategie, in dieser Reihenfolge:
 *
 *   a) Gebinde-Präfix parsen ("Display: 25x …", "Box: 50x …") → bestimmt
 *      die Ziel-Variante (pack_type + units_per_pack), der Rest ist der
 *      Produktname.
 *   b) `ref`-Abgleich, wenn Odoo eine [Artikelnummer] im Namen führt.
 *   c) Exakter Abgleich nach Normalisierung (Kleinschreibung, Umlaute,
 *      ø→o, Satzzeichen weg).
 *   d) Unscharfer Abgleich (Dice-Koeffizient über Wort-Mengen) — aber nur
 *      gegen Produkte, deren Ziel-Variante nicht schon von einem sicheren
 *      Treffer (b/c) belegt ist, nur oberhalb einer Schwelle und nur, wenn
 *      der zweitbeste Kandidat klar dahinter liegt. Alles andere wird
 *      GEMELDET statt geraten.
 *
 * Unscharfe Treffer (Stufe "fuzzy") tauchen im Importbericht namentlich auf,
 * damit der Betreiber sie einmal gegenliest.
 */

import { PriceInput, collapseEqual, roundTo } from "./pricing-helpers"

// ─── Datenformen ─────────────────────────────────────────────────

/** Eine Zeile aus data/catalog.json (Vorbild: import-catalog.ts). */
export type CatalogTier = {
  min_quantity: number
  max_quantity: number | null
  price: number
}

export type CatalogVariant = {
  label: string
  pack_type: "single" | "display" | "box"
  units_per_pack: number
  tiers: CatalogTier[]
}

export type CatalogProduct = {
  product: string
  ref: string | number | null
  variants: CatalogVariant[]
}

/** Eine Zeile aus data/price-lists.json (erhoben von scripts/jibbit-shop-prices.mjs). */
export type ShopPrice = {
  odoo_template_id: number
  odoo_name: string
  regular_price: number
  promo_price: number
  has_discount: boolean
}

export type MatchLevel = "ref" | "exact" | "fuzzy"

export type Match = {
  entry: ShopPrice
  product: CatalogProduct
  variant: CatalogVariant
  level: MatchLevel
  /** Nur bei level "fuzzy": Dice-Ähnlichkeit 0..1. */
  score?: number
  /** Auffälligkeiten, die kein Abbruch sind (z.B. Preisabweichung). */
  warnings: string[]
}

export type Unmatched = {
  entry: ShopPrice
  reason: string
}

// ─── Normalisierung ──────────────────────────────────────────────

/** "PURIZE XTRA Slim XMAS ø 5,9mm" -> "purize xtra slim xmas o 5 9mm" */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export type ParsedOdooName = {
  /** Artikelnummer aus "[4] …", sonst null. */
  ref: string | null
  /** Gebinde aus "Display: 25x …" / "Box: 50x …", sonst "single". */
  pack_type: "single" | "display" | "box"
  units: number | null
  /** Produktname ohne Präfixe und ohne "(Einzel)"-Marker. */
  base: string
}

/**
 * Odoo-Produktnamen zerlegen. Beispiele von der Live-Seite:
 *   "[4] RAW Classic Rolls Slim"                      → ref "4", single
 *   "Display: 25x Smoking Brown kurz (double window)" → display, 25 Stk.
 *   "Box: 50x Elements King Slim Size Ultra Thin"     → box, 50 Stk.
 *   "Angel Slim Filters (Einzel)"                     → single, "(Einzel)" fällt weg
 */
export function parseOdooName(name: string): ParsedOdooName {
  let rest = name.trim()

  let ref: string | null = null
  const refMatch = rest.match(/^\[([^\]]+)\]\s*/)
  if (refMatch) {
    ref = refMatch[1]
    rest = rest.slice(refMatch[0].length)
  }

  let pack_type: ParsedOdooName["pack_type"] = "single"
  let units: number | null = null
  const packMatch = rest.match(/^(display|box)\s*:\s*(\d+)\s*x\s*/i)
  if (packMatch) {
    pack_type = packMatch[1].toLowerCase() as "display" | "box"
    units = Number(packMatch[2])
    rest = rest.slice(packMatch[0].length)
  }

  // "(Einzel)" ist ein Gebinde-Marker, kein Namensbestandteil.
  rest = rest.replace(/\(\s*einzeln?\s*\)/i, "").trim()

  return { ref, pack_type, units, base: rest }
}

// ─── Ähnlichkeit ─────────────────────────────────────────────────

/** Dice-Koeffizient über Wort-Mengen: 2·|A∩B| / (|A|+|B|). */
export function diceSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean))
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean))
  if (!ta.size || !tb.size) {
    return 0
  }
  let shared = 0
  for (const t of ta) {
    if (tb.has(t)) shared++
  }
  return (2 * shared) / (ta.size + tb.size)
}

/**
 * Unter dieser Ähnlichkeit wird nicht mehr zugeordnet. 0.65 lässt die real
 * beobachteten Umformulierungen durch (0.75–0.91), hält aber Produkte
 * verschiedener Serien auseinander (< 0.5).
 */
export const FUZZY_THRESHOLD = 0.65

/** Der zweitbeste Kandidat muss mindestens so weit dahinter liegen. */
export const FUZZY_MARGIN = 0.15

// ─── Zuordnung ───────────────────────────────────────────────────

/**
 * Die Ziel-Variante innerhalb des Produkts bestimmen.
 *
 * Gebinde werden über die Stückzahl gefunden, nicht über das Wort
 * Display/Box — Odoo und Katalog benutzen die Wörter nicht deckungsgleich.
 * Stimmt das Wort nicht überein, gibt es eine Warnung, aber die Stückzahl
 * entscheidet.
 */
export function resolveVariant(
  product: CatalogProduct,
  parsed: ParsedOdooName
): { variant: CatalogVariant | null; warning?: string; reason?: string } {
  if (parsed.pack_type === "single") {
    const singles = product.variants.filter((v) => v.pack_type === "single")
    if (singles.length !== 1) {
      return {
        variant: null,
        reason: `${singles.length} Einzel-Varianten in "${product.product}"`,
      }
    }
    return { variant: singles[0] }
  }

  const packs = product.variants.filter(
    (v) => v.pack_type !== "single" && v.units_per_pack === parsed.units
  )
  if (packs.length !== 1) {
    return {
      variant: null,
      reason:
        `kein eindeutiges Gebinde mit ${parsed.units} Stk. in ` +
        `"${product.product}" (${packs.length} Kandidaten)`,
    }
  }
  const variant = packs[0]
  const warning =
    variant.pack_type !== parsed.pack_type
      ? `Gebinde-Wort weicht ab: Odoo "${parsed.pack_type}", ` +
        `Katalog "${variant.pack_type}" — Stückzahl ${parsed.units} passt`
      : undefined
  return { variant, warning }
}

export type MatchResult = {
  matched: Match[]
  unmatched: Unmatched[]
}

/**
 * Alle Shop-Preise den Katalog-Varianten zuordnen.
 *
 * Zwei Durchgänge: erst die sicheren Treffer (ref, exakt), dann die
 * unscharfen — letztere sehen nur noch Produkte, deren Ziel-Variante frei
 * ist. Das verhindert, dass z.B. "PURIZE XTRA Slim XMAS ø 5,9mm" auf die
 * bereits vergebene "Purize Xtra SLIM White, 50er Pack" rutscht.
 */
export function matchShopPrices(
  catalog: CatalogProduct[],
  entries: ShopPrice[]
): MatchResult {
  const matched: Match[] = []
  const unmatched: Unmatched[] = []
  /** Belegte Varianten: `${produkt}::${label}` */
  const claimed = new Set<string>()
  const keyOf = (p: CatalogProduct, v: CatalogVariant) =>
    `${p.product}::${v.label}`

  const finish = (
    entry: ShopPrice,
    parsed: ParsedOdooName,
    product: CatalogProduct,
    level: MatchLevel,
    score?: number
  ) => {
    const { variant, warning, reason } = resolveVariant(product, parsed)
    if (!variant) {
      unmatched.push({
        entry,
        reason: `Produkt "${product.product}" gefunden, aber ${reason}`,
      })
      return
    }
    const key = keyOf(product, variant)
    if (claimed.has(key)) {
      unmatched.push({
        entry,
        reason: `Variante "${variant.label}" von "${product.product}" ist schon einem anderen Odoo-Produkt zugeordnet`,
      })
      return
    }
    claimed.add(key)

    const warnings: string[] = []
    if (warning) {
      warnings.push(warning)
    }
    // Kreuzprüfung: der Aktionspreis der Website muss dem bereits
    // importierten Staffelpreis für Menge 1 entsprechen — sonst sind
    // catalog.json und die Live-Seite auseinandergelaufen.
    const tier1 = variant.tiers[0]?.price
    if (entry.has_discount && tier1 !== undefined && tier1 !== entry.promo_price) {
      warnings.push(
        `Aktionspreis auf jibbit.ch (${entry.promo_price}) weicht von ` +
          `catalog.json (${tier1}) ab — catalog.json neu erheben?`
      )
    }

    matched.push({ entry, product, variant, level, score, warnings })
  }

  type Pending = { entry: ShopPrice; parsed: ParsedOdooName }
  const pending: Pending[] = []

  // ─── Durchgang 1: ref und exakt ───────────────────────────────
  for (const entry of entries) {
    const parsed = parseOdooName(entry.odoo_name)

    if (parsed.ref !== null) {
      const byRef = catalog.filter(
        (p) => p.ref !== null && String(p.ref) === parsed.ref
      )
      if (byRef.length === 1) {
        finish(entry, parsed, byRef[0], "ref")
        continue
      }
      if (byRef.length > 1) {
        unmatched.push({
          entry,
          reason: `Artikelnummer [${parsed.ref}] ist im Katalog mehrfach vergeben`,
        })
        continue
      }
      // ref unbekannt → normal weiter über den Namen.
    }

    const norm = normalizeName(parsed.base)
    const exact = catalog.filter((p) => normalizeName(p.product) === norm)
    if (exact.length === 1) {
      finish(entry, parsed, exact[0], "exact")
      continue
    }
    if (exact.length > 1) {
      unmatched.push({
        entry,
        reason: `Name "${parsed.base}" passt exakt auf mehrere Katalogprodukte`,
      })
      continue
    }

    pending.push({ entry, parsed })
  }

  // ─── Durchgang 2: unscharf, nur auf freie Varianten ───────────
  for (const { entry, parsed } of pending) {
    const candidates = catalog
      .map((p) => ({ p, score: diceSimilarity(parsed.base, p.product) }))
      .filter(({ p }) => {
        const { variant } = resolveVariant(p, parsed)
        return variant !== null && !claimed.has(keyOf(p, variant))
      })
      .sort((a, b) => b.score - a.score)

    const best = candidates[0]
    const second = candidates[1]

    if (!best || best.score < FUZZY_THRESHOLD) {
      unmatched.push({
        entry,
        reason:
          `kein Katalogprodukt ähnlich genug` +
          (best
            ? ` (bester Kandidat: "${best.p.product}", ${best.score.toFixed(2)})`
            : ""),
      })
      continue
    }
    if (second && best.score - second.score < FUZZY_MARGIN) {
      unmatched.push({
        entry,
        reason:
          `mehrdeutig: "${best.p.product}" (${best.score.toFixed(2)}) vs. ` +
          `"${second.p.product}" (${second.score.toFixed(2)})`,
      })
      continue
    }

    finish(entry, parsed, best.p, "fuzzy", best.score)
  }

  return { matched, unmatched }
}

// ─── Importplan ──────────────────────────────────────────────────

/** Eine Variante, für die geschrieben werden soll. */
export type PlannedVariant = {
  product: string
  variantLabel: string
  packType: CatalogVariant["pack_type"]
  unitsPerPack: number
  level: MatchLevel
  score?: number
  /** Regulärer Preis, gerundet — wird der Standardpreis der Variante. */
  regular: number
  /** Aktions-Staffeln, gerundet und verschmolzen — wandern in die Price List. */
  tiers: PriceInput[]
  warnings: string[]
}

export type ImportPlan = {
  planned: PlannedVariant[]
  /** Zugeordnet, aber bewusst nicht geschrieben (kein Rabatt o.ä.). */
  skipped: { odooName: string; product: string; reason: string }[]
  /** Katalog-Varianten ohne Gegenstück auf jibbit.ch — bleiben unangetastet. */
  noRegular: { product: string; variantLabel: string }[]
  unmatched: Unmatched[]
}

/**
 * Aus Katalog + Shop-Preisen den vollständigen Importplan rechnen — pur,
 * damit Rundung, Zuordnung und die Auslassungen testbar sind. Alles, was
 * Datenbank ist (SKU-Auflösung, Schreiben), macht import-price-lists.ts.
 */
export function buildImportPlan(
  catalog: CatalogProduct[],
  entries: ShopPrice[],
  step: number,
  currency = "chf"
): ImportPlan {
  const { matched, unmatched } = matchShopPrices(catalog, entries)

  const planned: PlannedVariant[] = []
  const skipped: ImportPlan["skipped"] = []
  const covered = new Set<string>()

  for (const m of matched) {
    const regular = roundTo(m.entry.regular_price, step)
    const tiers = collapseEqual(
      m.variant.tiers.map((t) => ({
        amount: roundTo(t.price, step),
        currency_code: currency,
        min_quantity: t.min_quantity,
        max_quantity: t.max_quantity,
      }))
    )

    // Auch übersprungene Treffer sind "abgedeckt" — sie sollen nicht
    // zusätzlich als "ohne Gegenstück" gemeldet werden.
    covered.add(`${m.product.product}::${m.variant.label}`)

    if (!m.entry.has_discount) {
      skipped.push({
        odooName: m.entry.odoo_name,
        product: m.product.product,
        reason: "kein Rabatt auf jibbit.ch — es gibt nichts durchzustreichen",
      })
      continue
    }
    // Ein "regulärer" Preis unter der Aktion ergäbe einen negativen Rabatt —
    // das ist ein Datenfehler, kein Importfall.
    if (!tiers.length || regular <= tiers[0].amount) {
      skipped.push({
        odooName: m.entry.odoo_name,
        product: m.product.product,
        reason:
          `regulärer Preis (${regular.toFixed(2)}) liegt nicht über dem ` +
          `Aktionspreis (${tiers[0]?.amount.toFixed(2) ?? "—"})`,
      })
      continue
    }

    planned.push({
      product: m.product.product,
      variantLabel: m.variant.label,
      packType: m.variant.pack_type,
      unitsPerPack: m.variant.units_per_pack,
      level: m.level,
      score: m.score,
      regular,
      tiers,
      warnings: m.warnings,
    })
  }

  const noRegular: ImportPlan["noRegular"] = []
  for (const p of catalog) {
    for (const v of p.variants) {
      if (!covered.has(`${p.product}::${v.label}`)) {
        noRegular.push({ product: p.product, variantLabel: v.label })
      }
    }
  }

  return { planned, skipped, noRegular, unmatched }
}
