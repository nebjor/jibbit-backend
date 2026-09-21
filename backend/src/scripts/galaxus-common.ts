/**
 * Galaxus-Anbindung — gemeinsame, reine Bausteine.
 *
 * Quelle der Spaltennamen: Digitec Galaxus «Provider Data Interface User
 * Guide» v3.0.4 (Stand 21.10.2019), Kapitel 2. Formatregeln aus Kapitel 1.4:
 *
 *   - CSV, Zeichencodierung UTF-8, Trennzeichen Semikolon
 *   - Zeichenketten in doppelten Anführungszeichen; Anführungszeichen im
 *     Text werden verdoppelt («Kings of E-Commerce» → ""Kings of E-Commerce"")
 *   - Dezimalzahlen mit Punkt, ohne Tausendertrennzeichen
 *   - erste Zeile ist die Kopfzeile
 *   - Zeilenumbrüche im Text sind im Windows-Format (CRLF) erlaubt
 *   - die erste Spalte in allen Dateien ist die Artikelnummer des Providers
 *     (ProviderKey); nur im Spezifikationsfile heisst sie «ProductKey»
 *
 * Die Funktionen hier sind bewusst rein (keine Datenbank, kein Dateisystem),
 * damit die Unit-Tests sie direkt füttern können. Den Ist-Zustand aus Medusa
 * holt loadVariantSnapshots(); geschrieben wird in galaxus-export.ts bzw.
 * galaxus-report.ts.
 */

import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ─── GTIN ───────────────────────────────────────────────────────

/**
 * Gültige GTIN/EAN laut Handbuch: «Ganzzahl (8-14)» — also 8 bis 14 Ziffern,
 * nichts anderes. Eine Prüfziffern-Validierung verlangt das Handbuch nicht;
 * Galaxus prüft die Zuordnung selbst über seine Produktdatenbank.
 */
export function isValidGtin(gtin: unknown): gtin is string {
  return typeof gtin === "string" && /^[0-9]{8,14}$/.test(gtin)
}

// ─── CSV ────────────────────────────────────────────────────────

const SEP = ";"
const EOL = "\r\n"

/**
 * Eine Zelle:
 *   - string        → in Anführungszeichen, " verdoppelt, Umbrüche → CRLF
 *   - number        → unformatiert mit Dezimalpunkt (String(n))
 *   - { raw }       → wörtlich übernommen — für formatierte Dezimalzahlen
 *                     («0.0», «1.40») und für GTINs, deren führende Nullen
 *                     erhalten bleiben müssen, ohne als Text zu gelten
 *   - null/undefined → leer
 */
export type Cell = string | number | null | undefined | { raw: string }

/** n.toFixed(places) als unquotierte Zahl — z.B. Preise mit 2 Nachkommastellen. */
export function decimal(n: number, places: number): { raw: string } {
  return { raw: n.toFixed(places) }
}

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : ""
  }
  if (typeof value === "object") {
    return value.raw
  }
  const normalized = value.replace(/\r\n|\r|\n/g, EOL).replace(/"/g, '""')
  return `"${normalized}"`
}

export function toCsv(columns: string[], rows: Record<string, Cell>[]): string {
  const lines = [
    columns.join(SEP),
    ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(SEP)),
  ]
  return lines.join(EOL) + EOL
}

// ─── Ist-Zustand einer Variante ─────────────────────────────────

export type VariantSnapshot = {
  handle: string
  productTitle: string
  variantTitle: string
  status: string
  sku: string | null
  /** GTIN/EAN — Medusa-Feld `variant.ean`. */
  ean: string | null
  /** Verpackungsgewicht in Gramm — Medusa-Feld `variant.weight`. */
  weightG: number | null
  /** Marke — Produkt-Metadatum `brand`. */
  brand: string | null
  category: string | null
  subtitle: string | null
  description: string | null
  /** Erstes Bild wird MainImageURL, der Rest ImageURL_1..n. */
  imageUrls: string[]
  /** CHF-Basispreis für Menge 1 (Endpreis; keine Preislisten-Aktionen). */
  price: number | null
  /** Verfügbarer Bestand; null = unbekannt (manage_inventory aus / kein Level). */
  stock: number | null
  unitsPerPack: number | null
}

/**
 * Pflichtangaben je Variante, ohne die Galaxus die Zeile nicht annimmt.
 * Rückgabe: menschenlesbare Liste dessen, was fehlt — leer heisst lieferfähig.
 *
 * Grundlage (Handbuch v3.0.4): Gtin, BrandName, ProductCategory, WeightG,
 * ProductTitle, LongDescription (Stammdaten); MainImageURL (Medien);
 * SalesPrice inkl./exkl. MwSt (Preisdaten, Händler);
 * QuantityOnStock (Bestandesdaten).
 */
export function fehlendeFelder(s: VariantSnapshot): string[] {
  const fehlt: string[] = []
  if (s.status !== "published") {
    fehlt.push("nicht veröffentlicht")
  }
  if (!s.sku) {
    fehlt.push("sku")
  }
  if (!s.ean) {
    fehlt.push("ean")
  } else if (!isValidGtin(s.ean)) {
    fehlt.push(`ean ungültig («${s.ean}»)`)
  }
  if (!s.brand) {
    fehlt.push("marke")
  }
  if (!s.category) {
    fehlt.push("kategorie")
  }
  if (!s.description?.trim()) {
    fehlt.push("beschreibung")
  }
  if (s.price === null || !(s.price > 0)) {
    fehlt.push("preis")
  }
  if (s.stock === null) {
    fehlt.push("bestand")
  }
  if (s.weightG === null || !(s.weightG > 0)) {
    fehlt.push("gewicht")
  }
  if (!s.imageUrls.length) {
    fehlt.push("bild")
  }
  return fehlt
}

// ─── Export-Dateien bauen ───────────────────────────────────────

/**
 * Galaxus «Brief» (ShipmentType 1) geht laut Handbuch Anhang 3.1.1 bis
 * 1000 g. Deckt sich mit `letterMaxWeight` des swiss-shipping-Moduls.
 * Ohne Gewicht gilt Paket — dieselbe konservative Vorgabe wie im Versand.
 */
export const LETTER_MAX_WEIGHT_G = 1000

export type AusgeschlosseneVariante = {
  sku: string | null
  produkt: string
  variante: string
  fehlt: string[]
}

export type GalaxusExport = {
  /** Stammdaten + Medien in einer Datei (Datenaufteilung Option 2, Kap. 1.3.2). */
  productData: string
  priceData: string
  stockData: string
  specificationData: string
  /** Varianten, die NICHT in den Dateien stehen, samt Begründung. */
  ausgeschlossen: AusgeschlosseneVariante[]
  /** Anzahl exportierter Varianten (Zeilen in ProductData). */
  exportiert: number
}

export type GalaxusExportOptions = {
  /**
   * Auch unvollständige Varianten aufnehmen (leere Pflichtzellen) — nur zum
   * Sichten des Formats, nicht zum Hochladen. Varianten ohne SKU bleiben
   * immer draussen: ohne ProviderKey ist keine Zeile referenzierbar.
   */
  mitLuecken?: boolean
}

export function buildGalaxusExport(
  snapshots: VariantSnapshot[],
  opts: GalaxusExportOptions = {}
): GalaxusExport {
  const ausgeschlossen: AusgeschlosseneVariante[] = []
  const rows: VariantSnapshot[] = []

  for (const s of snapshots) {
    const fehlt = fehlendeFelder(s)
    if (!s.sku || (fehlt.length && !opts.mitLuecken)) {
      ausgeschlossen.push({
        sku: s.sku,
        produkt: s.productTitle,
        variante: s.variantTitle,
        fehlt,
      })
      continue
    }
    rows.push(s)
  }

  rows.sort((a, b) => (a.sku ?? "").localeCompare(b.sku ?? ""))

  // ── Stammdaten (inkl. Medienspalten) ──────────────────────────
  // Optionale Spalten, die wir nie füllen könnten, werden laut Kap. 1.5
  // weggelassen statt leer mitgeliefert.
  const maxExtraImages = Math.max(
    0,
    ...rows.map((s) => Math.max(0, s.imageUrls.length - 1))
  )
  const imageColumns = Array.from(
    { length: maxExtraImages },
    (_, i) => `ImageURL_${i + 1}`
  )
  const productColumns = [
    "ProviderKey",
    "Gtin",
    "BrandName",
    "ProductCategory",
    "WeightG",
    "ProductSuperType",
    "ProductTitle_de",
    "ShortDescription_de",
    "LongDescription_de",
    "MainImageURL",
    ...imageColumns,
  ]
  const productRows = rows.map((s) => {
    const row: Record<string, Cell> = {
      ProviderKey: s.sku,
      // GTIN ist laut Handbuch eine Ganzzahl — unquotiert, führende Nullen
      // bleiben über den Roh-Wert erhalten.
      Gtin: isValidGtin(s.ean) ? { raw: s.ean } : null,
      BrandName: s.brand,
      ProductCategory: s.category,
      WeightG: s.weightG,
      // Gruppiert die Verpackungsvarianten desselben Produkts.
      ProductSuperType: s.handle,
      ProductTitle_de: s.productTitle,
      ShortDescription_de: s.subtitle,
      LongDescription_de: s.description,
      MainImageURL: s.imageUrls[0] ?? null,
    }
    s.imageUrls.slice(1).forEach((url, i) => {
      row[`ImageURL_${i + 1}`] = url
    })
    return row
  })

  // ── Preisdaten ────────────────────────────────────────────────
  // Der Betreiber ist nicht mehrwertsteuerpflichtig: die gepflegten Preise
  // sind Endpreise ohne ausgewiesene MwSt. Deshalb VatRatePercentage 0.0
  // und SalesPriceExcludingVat == SalesPriceIncludingVat. Ob Galaxus das
  // für Händler so akzeptiert, muss der Betreiber schriftlich klären —
  // siehe docs/galaxus-marktplatz.md.
  const priceColumns = [
    "ProviderKey",
    "VatRatePercentage",
    "SalesPriceExcludingVat",
    "SalesPriceIncludingVat",
    "Currency",
  ]
  const priceRows = rows.map((s) => ({
    ProviderKey: s.sku,
    VatRatePercentage: { raw: "0.0" },
    SalesPriceExcludingVat: s.price !== null ? decimal(s.price, 2) : null,
    SalesPriceIncludingVat: s.price !== null ? decimal(s.price, 2) : null,
    Currency: "CHF",
  }))

  // ── Bestandesdaten ────────────────────────────────────────────
  const stockColumns = [
    "ProviderKey",
    "QuantityOnStock",
    "MinimumOrderQuantity_dd",
    "RetailUnitQuantity",
    "ShipmentType",
  ]
  const stockRows = rows.map((s) => ({
    ProviderKey: s.sku,
    QuantityOnStock: s.stock,
    MinimumOrderQuantity_dd: 1,
    RetailUnitQuantity: s.unitsPerPack,
    ShipmentType:
      s.weightG !== null && s.weightG > 0 && s.weightG <= LETTER_MAX_WEIGHT_G
        ? 1
        : 2,
  }))

  // ── Spezifikationen ───────────────────────────────────────────
  // Laut Kap. 2.5 müssen ALLE Spalten (auch die leeren Sprachspalten)
  // vorhanden sein, die Datei ist nach ProductKey sortiert, und die
  // Artikelnummer heisst hier «ProductKey».
  const specColumns = [
    "ProductKey",
    "SpecificationKey",
    "SpecificationGroup_DE",
    "SpecificationGroup_FR",
    "SpecificationGroup_EN",
    "SpecificationGroup_IT",
    "SpecificationKey_DE",
    "SpecificationKey_FR",
    "SpecificationKey_EN",
    "SpecificationKey_IT",
    "SpecificationValue_DE",
    "SpecificationValue_FR",
    "SpecificationValue_EN",
    "SpecificationValue_IT",
  ]
  const specRows: Record<string, Cell>[] = []
  for (const s of rows) {
    const push = (key: string, nameDe: string, valueDe: string) =>
      specRows.push({
        ProductKey: s.sku,
        SpecificationKey: key,
        SpecificationKey_DE: nameDe,
        SpecificationValue_DE: valueDe,
      })
    push("verpackungseinheit", "Verpackungseinheit", s.variantTitle)
    if (s.unitsPerPack !== null && s.unitsPerPack > 1) {
      push(
        "anzahl_einzelpackungen",
        "Anzahl Einzelpackungen",
        String(s.unitsPerPack)
      )
    }
  }

  return {
    productData: toCsv(productColumns, productRows),
    priceData: toCsv(priceColumns, priceRows),
    stockData: toCsv(stockColumns, stockRows),
    specificationData: toCsv(specColumns, specRows),
    ausgeschlossen,
    exportiert: rows.length,
  }
}

// ─── Ist-Zustand aus Medusa laden ───────────────────────────────

const CURRENCY = "chf"

/**
 * Alle Varianten mit dem, was Galaxus braucht, aus der Datenbank lesen —
 * die Exporte entstehen aus den echten Medusa-Daten.
 */
export async function loadVariantSnapshots(
  container: MedusaContainer
): Promise<VariantSnapshot[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "subtitle",
      "description",
      "status",
      "metadata",
      "thumbnail",
      "images.url",
      "categories.name",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.ean",
      "variants.weight",
      "variants.manage_inventory",
      "variants.metadata",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.prices.min_quantity",
      "variants.prices.price_list_id",
      "variants.inventory_items.inventory_item_id",
    ],
  })

  const { data: levels } = await query.graph({
    entity: "inventory_level",
    fields: ["inventory_item_id", "stocked_quantity", "reserved_quantity"],
  })

  const stockByItem = new Map<string, number>()
  for (const level of levels as any[]) {
    const have = stockByItem.get(level.inventory_item_id) ?? 0
    const free =
      Number(level.stocked_quantity ?? 0) - Number(level.reserved_quantity ?? 0)
    stockByItem.set(level.inventory_item_id, have + free)
  }

  const snapshots: VariantSnapshot[] = []

  for (const p of products as any[]) {
    // Bilderreihenfolge: Thumbnail zuerst (freigestellte Frontalansicht als
    // MainImage), danach die übrigen Bilder ohne Duplikat.
    const urls: string[] = (p.images ?? [])
      .map((i: any) => i?.url)
      .filter(Boolean)
    const imageUrls = p.thumbnail
      ? [p.thumbnail, ...urls.filter((u) => u !== p.thumbnail)]
      : urls

    const brandRaw = p.metadata?.brand
    const brand =
      typeof brandRaw === "string" && brandRaw.trim() ? brandRaw.trim() : null

    for (const v of p.variants ?? []) {
      const basePrices = (v.prices ?? []).filter(
        (pr: any) => !pr.price_list_id && pr.currency_code === CURRENCY
      )
      const q1 = basePrices.find(
        (pr: any) => Number(pr.min_quantity ?? 1) === 1
      )
      const price = q1 ? Number(q1.amount) : null

      let stock: number | null = null
      if (v.manage_inventory) {
        const itemIds: string[] = (v.inventory_items ?? [])
          .map((l: any) => l.inventory_item_id)
          .filter(Boolean)
        if (itemIds.length) {
          const sum = itemIds.reduce(
            (n, id) => n + (stockByItem.get(id) ?? 0),
            0
          )
          stock = Math.max(0, sum)
        }
      }

      const unitsRaw = v.metadata?.units_per_pack
      const unitsPerPack = Number.isFinite(Number(unitsRaw))
        ? Number(unitsRaw)
        : null

      const weight = Number(v.weight)
      snapshots.push({
        handle: p.handle,
        productTitle: p.title,
        variantTitle: v.title ?? "",
        status: p.status,
        sku: v.sku ?? null,
        ean: v.ean ?? null,
        weightG: Number.isFinite(weight) && weight > 0 ? weight : null,
        brand,
        category: p.categories?.[0]?.name ?? null,
        subtitle: p.subtitle ?? null,
        description: p.description ?? null,
        imageUrls,
        price,
        stock,
        unitsPerPack,
      })
    }
  }

  return snapshots
}
