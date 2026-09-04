/**
 * Legt den Katalog aus catalog.json in Medusa an — Produkte, Varianten und
 * Staffelpreise in einem Durchgang.
 *
 *   node scripts/parse-price-rules.mjs preisregeln.txt
 *   cd backend
 *   npx medusa exec ./src/scripts/import-catalog.ts ../odoo-export/catalog.json dry-run
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte Optionen
 * ab, siehe script-args.ts.
 *
 * Optionen:
 *   dry-run        nur anzeigen, nichts schreiben
 *   round=<step>   Rundung, Default 0.05 (siehe import-price-tiers.ts)
 *   stock=<n>      Bestandsführung einschalten und mit n Stück starten.
 *                  Ohne die Option wird manage_inventory=false gesetzt,
 *                  damit die Artikel sofort bestellbar sind und der Bestand
 *                  später im Admin nachgepflegt werden kann.
 *
 * Was dieses Script NICHT liefert: Bilder und Beschreibungen. Die stehen
 * nicht in den Preisregeln — Beschreibungen kommen über update-catalog.ts,
 * Bilder über import-product-images.ts.
 *
 * Je Variante können ean (GTIN, 8–14 Ziffern) und weight_g (Gramm) gepflegt
 * sein, je Produkt brand (Marke). Alle drei braucht die Galaxus-Anbindung
 * (galaxus-export.ts); das Gewicht schaltet zusätzlich den Brieftarif des
 * swiss-shipping-Moduls frei, der ohne Gewichte nie greift.
 *
 * Idempotent über den Handle: bereits vorhandene Produkte werden übersprungen,
 * nicht überschrieben. Wer vorhandene Produkte nachziehen will (Beschreibung,
 * Preise, Bestand), nimmt update-catalog.ts.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows"

import { isValidGtin } from "./galaxus-common"
import { roundTo } from "./import-price-tiers"
import { parseScriptArgs } from "./script-args"
import {
  KatalogLieferant,
  REORDER_POINT_KEY,
  SUPPLIERS_KEY,
  validateLieferantenDaten,
} from "../lib/nachschub"

const CURRENCY = "chf"
const OPTION_TITLE = "Verpackungseinheit"
const ROUND_DEFAULT = 0.05

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
  /** GTIN/EAN, 8–14 Ziffern — Pflicht für Galaxus, sonst optional. */
  ean?: string | null
  /** Verpackungsgewicht in Gramm — schaltet den Brieftarif frei. */
  weight_g?: number | null
  /**
   * Meldebestand der Nachschubsteuerung: liegt der verfügbare Bestand auf
   * oder unter diesem Wert, erscheint die Variante auf der Admin-Seite
   * «Nachschub» und im nachschub-report.ts. Landet in
   * variant.metadata.reorder_point.
   */
  reorder_point?: number | null
  /**
   * Bezugsquellen des Betreibers, erster Eintrag = Hauptlieferant. Die url
   * muss eine absolute http(s)-Adresse der Produktseite beim Lieferanten
   * sein — alles andere bricht den Import ab (siehe lib/nachschub.ts).
   * Landet in variant.metadata.suppliers.
   */
  suppliers?: KatalogLieferant[] | null
}

export type CatalogProduct = {
  product: string
  ref: string | null
  variants: CatalogVariant[]
  /** Marke (Galaxus «BrandName») — landet in product.metadata.brand. */
  brand?: string | null
}

/**
 * EANs und Gewichte des ganzen Katalogs prüfen, BEVOR etwas geschrieben
 * wird. Eine falsche GTIN fällt sonst erst auf, wenn Galaxus die Datei
 * ablehnt; eine doppelte ordnet zwei Artikel demselben Produkt zu.
 *
 * Exportiert, weil update-catalog.ts dieselbe Prüfung braucht.
 */
export function validateCatalogData(catalog: CatalogProduct[]): string[] {
  const errors: string[] = []
  const seenEans = new Map<string, string>()

  for (const entry of catalog) {
    for (const v of entry.variants) {
      const where = `${entry.product} (${v.label})`
      if (v.ean != null) {
        if (!isValidGtin(v.ean)) {
          errors.push(`${where}: EAN «${v.ean}» ist keine GTIN (8–14 Ziffern)`)
        } else {
          const owner = seenEans.get(v.ean)
          if (owner) {
            errors.push(`${where}: EAN ${v.ean} bereits vergeben an ${owner}`)
          } else {
            seenEans.set(v.ean, where)
          }
        }
      }
      if (v.weight_g != null && !(v.weight_g > 0)) {
        errors.push(`${where}: weight_g muss über 0 liegen (ist ${v.weight_g})`)
      }
    }
  }

  // Nachschubsteuerung: Meldebestand und Lieferanten (insbesondere die
  // URL-Sperre auf http/https) — gleiche Abbruch-Mechanik wie oben.
  errors.push(...validateLieferantenDaten(catalog))

  return errors
}

/**
 * Kategorie aus dem Produktnamen ableiten.
 *
 * Reihenfolge ist entscheidend: "OCB Premium KSS Papers mit Filter" enthält
 * beide Stichwörter und ist ein Blättchen, kein Filter. Deshalb greifen die
 * Papers-Begriffe vor den Filter-Begriffen.
 */
export function categoryFor(name: string): string {
  if (/aschenbecher|ashtray/i.test(name)) {
    return "Aschenbecher"
  }
  // Behälter und Werkzeug — vor den Papers-Begriffen, damit z.B. eine
  // "Dose für Rolls" nicht als Papers durchginge.
  if (/\bdose\b|silikon|grinder/i.test(name)) {
    return "Zubehör"
  }
  // Hülsen/Cones sind vorgerollte Papers, keine Filter.
  if (
    /\bpapers?\b|\brolls?\b|\bkurz\b|gizeh|heftchen|blättchen|hülsen|huelsen|cones?\b/i.test(
      name
    )
  ) {
    return "Papers"
  }
  if (/filter|aktivkohle|\btips?\b|purize|kailar|angel|zig\s*zag/i.test(name)) {
    return "Filter"
  }
  return "Papers"
}

/**
 * "PURIZE Aktivkohlefilter ø 9mm" -> "purize-aktivkohlefilter-o-9mm"
 *
 * Exportiert, weil import-price-lists.ts denselben Handle ableiten muss,
 * um die hier angelegten Produkte wiederzufinden.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Deterministische SKU aus dem Produktnamen und dem Gebinde.
 *
 * Der Name wird NICHT einfach abgeschnitten, sondern auf die ersten drei
 * Buchstaben je Wort verkürzt. Beim Abschneiden fällt sonst genau das Wort
 * weg, das die Artikel unterscheidet:
 *
 *   "RAW Kristallglas Aschenbecher Darkside" -> RAW-KRISTALLGLAS-ASCHENBECHE
 *   "RAW Kristallglas Aschenbecher Rainbow"  -> RAW-KRISTALLGLAS-ASCHENBECHE
 *
 * Beide Aschenbecher hätten dieselbe SKU bekommen. Mit der Wortkürzung wird
 * daraus RAW-KRI-ASC-DAR bzw. RAW-KRI-ASC-RAI.
 *
 * Echte Lieferanten-Artikelnummern kennt dieses Script nicht — im Admin
 * jederzeit überschreibbar.
 *
 * Exportiert, weil import-price-lists.ts die Varianten über genau diese
 * SKU wiederfinden muss.
 */
export function skuFor(
  name: string,
  variant: Pick<CatalogVariant, "pack_type" | "units_per_pack">
): string {
  const base = name
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/Ø/g, "O")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => word.slice(0, 3))
    .join("-")

  const suffix =
    variant.pack_type === "single"
      ? "EA"
      : `${variant.pack_type === "box" ? "BX" : "D"}${variant.units_per_pack}`

  return `${base}-${suffix}`
}

/** Ein fertig aufbereitetes Produkt, bereit für createProductsWorkflow. */
type PreparedVariant = {
  title: string
  sku: string
  ean?: string
  /** Gramm — so führt Medusa Gewichte im Admin (siehe swiss-shipping). */
  weight?: number
  manage_inventory: boolean
  options: Record<string, string>
  /** units_per_pack/pack_type, dazu reorder_point und suppliers (Nachschub). */
  metadata: Record<string, unknown>
  prices: {
    amount: number
    currency_code: string
    min_quantity: number
    max_quantity: number | null
  }[]
}

type PreparedProduct = {
  title: string
  handle: string
  category: string
  category_ids: string[]
  metadata?: Record<string, string>
  variants: PreparedVariant[]
  options: { title: string; values: string[] }[]
}

export default async function importCatalog({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT)
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL)

  const opts = parseScriptArgs(args)

  const file = opts.file(".json")
  if (!file) {
    logger.error("Pfad zu catalog.json fehlt.")
    return
  }

  const dryRun = opts.flag("dry-run")
  const step = Number(opts.value("round") ?? String(ROUND_DEFAULT))
  const stockRaw = opts.value("stock")
  const manageInventory = stockRaw !== undefined
  const initialStock = Number(stockRaw ?? "0")

  const catalog: CatalogProduct[] = JSON.parse(readFileSync(resolve(file), "utf8"))

  if (!catalog.length) {
    logger.warn("catalog.json ist leer.")
    return
  }

  // EANs/Gewichte des ganzen Katalogs prüfen, bevor irgendetwas passiert.
  const dataErrors = validateCatalogData(catalog)
  if (dataErrors.length) {
    logger.error("Ungültige Katalogdaten — nichts wurde angelegt:")
    dataErrors.forEach((e) => logger.error(`  ${e}`))
    return
  }

  // ─── Kategorien sicherstellen ─────────────────────────────────
  const wanted = [...new Set(catalog.map((p) => categoryFor(p.product)))]

  const { data: existingCategories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name"],
  })

  const categories: { id: string; name: string }[] = existingCategories.map(
    (c: { id: string; name: string }) => ({ id: c.id, name: c.name })
  )

  const missing = wanted.filter((w) => !categories.some((c) => c.name === w))

  if (missing.length && !dryRun) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: { product_categories: missing.map((name) => ({ name, is_active: true })) },
    })
    categories.push(...result.map((c) => ({ id: c.id, name: c.name })))
    logger.info(`Kategorien angelegt: ${missing.join(", ")}`)
  }

  // ─── Vorhandene Produkte überspringen ─────────────────────────
  const { data: allProducts } = await query.graph({
    entity: "product",
    fields: ["id", "handle"],
  })
  const existingHandles = new Set(
    allProducts.map((p: { handle: string }) => p.handle)
  )

  const [shippingProfile] = await fulfillmentModuleService.listShippingProfiles({
    type: "default",
  })
  const [salesChannel] = await salesChannelModuleService.listSalesChannels({})

  if (!dryRun && (!shippingProfile || !salesChannel)) {
    logger.error(
      "Shipping Profile oder Sales Channel fehlt — bitte zuerst seed.ts laufen lassen."
    )
    return
  }

  // ─── Produkte bauen ───────────────────────────────────────────
  const skipped: string[] = []
  const noBasePrice: string[] = []
  const toCreate: PreparedProduct[] = []

  for (const entry of catalog) {
    const handle = slugify(entry.product)

    if (existingHandles.has(handle)) {
      skipped.push(entry.product)
      continue
    }

    // Eine Variante ohne Preis für Menge 1 lässt den Warenkorb später
    // abbrechen. Lieber hier auffallen als bei der ersten Bestellung.
    const broken = entry.variants.filter((v) => v.tiers[0]?.min_quantity !== 1)
    if (broken.length) {
      noBasePrice.push(
        `${entry.product} (${broken.map((b) => b.label).join(", ")})`
      )
      continue
    }

    const category = categoryFor(entry.product)
    const categoryEntry = categories.find((c) => c.name === category)

    toCreate.push({
      title: entry.product,
      handle,
      category,
      category_ids: categoryEntry ? [categoryEntry.id] : [],
      metadata: entry.brand ? { brand: entry.brand } : undefined,
      variants: entry.variants.map((v) => ({
        title: v.label,
        sku: skuFor(entry.product, v),
        ean: v.ean ?? undefined,
        weight: v.weight_g ?? undefined,
        manage_inventory: manageInventory,
        options: { [OPTION_TITLE]: v.label },
        metadata: {
          // Für den Grundpreis "CHF 0.98 / Stk." auf der Produktseite.
          units_per_pack: v.units_per_pack,
          pack_type: v.pack_type,
          // Nachschubsteuerung — nur setzen, wenn gepflegt (validiert oben).
          ...(v.reorder_point != null
            ? { [REORDER_POINT_KEY]: v.reorder_point }
            : {}),
          ...(v.suppliers?.length
            ? {
                [SUPPLIERS_KEY]: v.suppliers.map((s) => ({
                  name: s.name.trim(),
                  url: s.url.trim(),
                  article_number: s.article_number?.trim() || null,
                })),
              }
            : {}),
        },
        prices: v.tiers.map((t) => ({
          amount: roundTo(t.price, step),
          currency_code: CURRENCY,
          min_quantity: t.min_quantity,
          max_quantity: t.max_quantity,
        })),
      })),
      options: [
        { title: OPTION_TITLE, values: entry.variants.map((v) => v.label) },
      ],
    })
  }

  // SKUs müssen shopweit eindeutig sein. Lieber hier abbrechen als beim
  // Anlegen auf einen Unique-Constraint laufen und halb importiert dastehen.
  const seenSkus = new Map<string, string>()
  const collisions: string[] = []
  for (const p of toCreate) {
    for (const v of p.variants) {
      const owner = seenSkus.get(v.sku)
      if (owner) {
        collisions.push(`${v.sku}: "${owner}" und "${p.title}"`)
        continue
      }
      seenSkus.set(v.sku, p.title)
    }
  }

  if (collisions.length) {
    logger.error(`SKU-Kollisionen — nichts wurde angelegt:`)
    collisions.forEach((c) => logger.error(`  ${c}`))
    return
  }

  // ─── Bericht ──────────────────────────────────────────────────
  if (skipped.length) {
    logger.info(`${skipped.length} Produkte existieren bereits — übersprungen.`)
  }

  if (noBasePrice.length) {
    logger.warn(
      `${noBasePrice.length} Produkte ohne Preis für Menge 1 — nicht angelegt:`
    )
    noBasePrice.forEach((n) => logger.warn(`  ${n}`))
  }

  if (!toCreate.length) {
    logger.info("Nichts anzulegen.")
    return
  }

  if (dryRun) {
    logger.info("— Probelauf, es wird nichts geschrieben —")
    for (const p of toCreate) {
      logger.info(`  ${p.title}  [${p.category}]`)
      for (const v of p.variants) {
        const staffeln = v.prices
          .map(
            (pr) =>
              `${pr.min_quantity}${pr.max_quantity ? `–${pr.max_quantity}` : "+"}:` +
              pr.amount.toFixed(2)
          )
          .join("  ")
        logger.info(`     ${v.sku.padEnd(34)} ${v.title.padEnd(20)} ${staffeln}`)
      }
    }
    logger.info(
      `Würde ${toCreate.length} Produkte mit ` +
        `${toCreate.reduce((n, p) => n + p.variants.length, 0)} Varianten anlegen.`
    )
    return
  }

  await createProductsWorkflow(container).run({
    input: {
      products: toCreate.map((p) => ({
        title: p.title,
        handle: p.handle,
        status: ProductStatus.PUBLISHED,
        category_ids: p.category_ids,
        metadata: p.metadata,
        shipping_profile_id: shippingProfile.id,
        options: p.options,
        variants: p.variants,
        sales_channels: [{ id: salesChannel.id }],
      })),
    },
  })

  logger.info(
    `${toCreate.length} Produkte angelegt ` +
      `(${toCreate.reduce((n, p) => n + p.variants.length, 0)} Varianten).`
  )

  // ─── Bestand ──────────────────────────────────────────────────
  if (manageInventory) {
    const { data: stockLocations } = await query.graph({
      entity: "stock_location",
      fields: ["id"],
    })
    const { data: inventoryItems } = await query.graph({
      entity: "inventory_item",
      fields: ["id"],
    })
    const { data: levels } = await query.graph({
      entity: "inventory_level",
      fields: ["inventory_item_id", "location_id"],
    })

    if (!stockLocations.length) {
      logger.warn("Kein Lager gefunden — Bestände wurden nicht gesetzt.")
      return
    }

    const location = stockLocations[0].id
    const have = new Set(
      levels.map(
        (l: { inventory_item_id: string; location_id: string }) =>
          `${l.inventory_item_id}::${l.location_id}`
      )
    )

    const missingLevels = inventoryItems
      .filter((i: { id: string }) => !have.has(`${i.id}::${location}`))
      .map((i: { id: string }) => ({
        location_id: location,
        stocked_quantity: initialStock,
        inventory_item_id: i.id,
      }))

    if (missingLevels.length) {
      await createInventoryLevelsWorkflow(container).run({
        input: { inventory_levels: missingLevels },
      })
      logger.info(
        `${missingLevels.length} Bestände auf ${initialStock} Stück gesetzt.`
      )
    }
  } else {
    logger.info(
      "Bestandsführung aus (manage_inventory=false) — Artikel sind sofort " +
        "bestellbar. Mit stock=<n> stattdessen Bestände führen."
    )
  }
}
