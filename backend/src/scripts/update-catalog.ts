/**
 * Zieht BESTEHENDE Produkte nach — das Gegenstück zu import-catalog.ts, das
 * vorhandene Produkte bewusst überspringt. Ohne dieses Script kann der
 * Betreiber weder eine Beschreibung nachtragen noch einen Preis ändern noch
 * einen Bestand setzen, ohne die Datenbank zu leeren.
 *
 *   cd backend
 *   npx medusa exec ./src/scripts/update-catalog.ts ../data/catalog.json \
 *     extra=../data/catalog-extra.json \
 *     content=../data/product-content.json \
 *     inventory=../data/inventory.json \
 *     dry-run
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte Optionen
 * ab, siehe script-args.ts.
 *
 *   <pfad>.json      Pflicht: catalog.json (Preise/Staffeln, wie beim Import)
 *   extra=<pfad>     weiterer Katalog im selben Format; überschreibt je
 *                    Handle Einträge aus catalog.json (z.B. catalog-extra.json
 *                    mit dem vervollständigten OCB-Bio-Eintrag)
 *   content=<pfad>   product-content.json: Beschreibung + Untertitel je Handle
 *   inventory=<pfad> inventory.json: Bestand je SKU. quantity=null wird
 *                    übersprungen; eine Zahl (auch 0) schaltet
 *                    manage_inventory ein und setzt den Bestand am ersten
 *                    Lagerort.
 *   dry-run          nur anzeigen, nichts schreiben — Feld für Feld
 *   round=<step>     Rundung wie import-catalog.ts, Default 0.05
 *
 * Was das Script anfasst — und was nicht:
 *   - subtitle/description: nur wenn die Content-Datei einen Wert hat und er
 *     vom Bestand abweicht. Leere Content-Felder überschreiben nie.
 *   - ean/weight_g je Variante und brand je Produkt (Galaxus-Felder, siehe
 *     import-catalog.ts): nur wenn der Katalog einen Wert hat und er
 *     abweicht. Fehlende Katalogwerte löschen nie einen Wert in Medusa.
 *   - Meldebestand/Lieferanten (Nachschubsteuerung): NIE. Die pflegt der
 *     Betreiber laufend im Admin (Widget «Nachschub» an der Produktseite;
 *     Lieferanten je Produkt in product.metadata.suppliers, Meldebestand je
 *     Variante in variant.metadata.reorder_point) — alle metadata-Updates
 *     dieses Scripts werden gemerged geschrieben, damit ein Katalog-Lauf
 *     seine Eingaben nicht überschreiben kann.
 *   - Preise: die Basispreise (price_list_id=null) der Variante werden als
 *     Ganzes mit den Staffeln aus dem Katalog abgeglichen und bei Abweichung
 *     ersetzt. Preislisten-Preise (Aktionen) bleiben unberührt — der
 *     Pricing-Service ersetzt beim Update nur Preise mit price_list_id=null.
 *   - GTIN: trägt die Katalog-Variante ein `gtin`, wird variant.ean gesetzt
 *     — jede Länge (8/12/13/14), dieselbe Spalte wie das Katalogfeld `ean`
 *     oben, siehe gtin.ts — nur bei Abweichung. upc/barcode fasst das Script
 *     nie an. Ohne `gtin` und `ean` im Katalog bleibt variant.ean
 *     unangetastet: was im Admin gepflegt wurde, überschreibt ein leeres
 *     Katalogfeld nie. Ungültige oder doppelte Nummern brechen den Lauf ab,
 *     bevor etwas geschrieben wird; `gtin` und `ean` derselben Variante
 *     müssen gleich lauten.
 *   - Bestand: siehe inventory=. Varianten ohne Inventory-Item bekommen eines
 *     (samt Link), fehlende Levels werden angelegt, abweichende gesetzt.
 *   - Titel, Handle, Kategorien, Bilder: nie. Produkte, die in Medusa fehlen,
 *     werden gemeldet, aber nicht angelegt — dafür ist import-catalog.ts da.
 *
 * Idempotent: ein zweiter Lauf direkt nach dem ersten meldet "nichts zu tun".
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createInventoryItemsWorkflow,
  createInventoryLevelsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"

import { assertCatalogGtins, catalogEan } from "./gtin"
import { roundTo } from "./import-price-tiers"
import {
  CatalogProduct,
  skuFor,
  slugify,
  validateCatalogData,
} from "./import-catalog"
import { parseScriptArgs } from "./script-args"

const CURRENCY = "chf"
const ROUND_DEFAULT = 0.05

// ─── Eingabedateien ─────────────────────────────────────────────

export type ContentEntry = {
  handle: string
  subtitle?: string | null
  description?: string | null
}

export type InventoryEntry = {
  sku: string
  quantity: number | null
}

/** inventory.json trägt einen Kommentar-Schlüssel; nur items zählt. */
export type InventoryFile = { items: InventoryEntry[] }

/**
 * Mehrere Katalogdateien zu einem Stand vereinen. Spätere Dateien gewinnen
 * je Handle — so überschreibt catalog-extra.json den unvollständigen
 * OCB-Bio-Eintrag aus catalog.json, statt neben ihm zu stehen.
 */
export function mergeCatalogs(...catalogs: CatalogProduct[][]): CatalogProduct[] {
  const byHandle = new Map<string, CatalogProduct>()
  for (const catalog of catalogs) {
    for (const entry of catalog) {
      byHandle.set(slugify(entry.product), entry)
    }
  }
  return [...byHandle.values()]
}

// ─── Ist-Zustand aus der Datenbank ──────────────────────────────

export type ExistingPrice = {
  amount: number
  currency_code: string
  min_quantity: number | null
  max_quantity: number | null
  price_list_id?: string | null
}

export type ExistingVariant = {
  id: string
  sku: string | null
  /** GTIN/EAN — optional, weil ältere Aufrufer das Feld nicht laden. */
  ean?: string | null
  /** Gramm — optional, weil ältere Aufrufer das Feld nicht laden. */
  weight?: number | null
  manage_inventory: boolean
  prices: ExistingPrice[]
  inventory_item_ids: string[]
}

export type ExistingProduct = {
  id: string
  handle: string
  title: string
  subtitle: string | null
  description: string | null
  /** Produkt-Metadaten; die Marke steht unter metadata.brand. */
  metadata?: Record<string, unknown> | null
  variants: ExistingVariant[]
}

export type DesiredPrice = {
  amount: number
  currency_code: string
  min_quantity: number
  max_quantity: number | null
}

// ─── Plan ───────────────────────────────────────────────────────

export type FieldChange = {
  /** z.B. "description" oder "ANG-SLI-FIL-6MM-120-EA preise" */
  field: string
  before: string
  after: string
}

export type VariantPricePlan = {
  variant_id: string
  sku: string
  prices: DesiredPrice[]
}

export type VariantDataPlan = {
  variant_id: string
  sku: string
  update: {
    ean?: string
    weight?: number
  }
}

export type ProductPlan = {
  id: string
  handle: string
  update: {
    subtitle?: string
    description?: string
    metadata?: Record<string, unknown>
  }
  variantPrices: VariantPricePlan[]
  variantData: VariantDataPlan[]
  changes: FieldChange[]
}

export type InventoryPlan = {
  sku: string
  variant_id: string
  set_manage_inventory: boolean
  /** true = zur Variante existiert noch kein Inventory-Item */
  create_item: boolean
  /** true = der Link Variante -> Inventory-Item fehlt noch */
  needs_link: boolean
  item_id: string | null
  level:
    | { action: "create"; quantity: number }
    | { action: "update"; level_id: string; from: number; to: number }
    | { action: "none"; quantity: number }
  changes: FieldChange[]
}

export type CatalogUpdatePlan = {
  products: ProductPlan[]
  inventory: InventoryPlan[]
  /** Handles aus dem Katalog, die es in Medusa (noch) nicht gibt. */
  missingInMedusa: string[]
  /** Medusa-Produkte ohne Katalogeintrag — werden nie angetastet. */
  notInCatalog: string[]
  /** SKUs aus inventory.json, zu denen keine Variante existiert. */
  unknownSkus: string[]
  /**
   * Varianten, deren Katalog-Staffeln nicht bei Menge 1 beginnen — deren
   * Preise werden NIE angefasst. Ohne diese Sperre würde ein Lauf ohne
   * extra=catalog-extra.json dem OCB-Bio-Eintrag den Menge-1-Preis löschen
   * und das Produkt unbestellbar machen.
   */
  noBasePrice: string[]
}

function fmtTiers(prices: DesiredPrice[] | ExistingPrice[]): string {
  const rows = [...prices].sort(
    (a, b) => (a.min_quantity ?? 1) - (b.min_quantity ?? 1)
  )
  return rows
    .map(
      (p) =>
        `${p.min_quantity ?? 1}${p.max_quantity ? `–${p.max_quantity}` : "+"}: ` +
        p.amount.toFixed(2)
    )
    .join("  ")
}

function fmtText(value: string | null | undefined): string {
  if (!value) {
    return "(leer)"
  }
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > 60 ? `"${oneLine.slice(0, 57)}…"` : `"${oneLine}"`
}

/** Basispreise (ohne Preislisten) vergleichbar machen. */
function priceKey(p: { amount: number; min_quantity: number | null; max_quantity: number | null }): string {
  return `${(p.min_quantity ?? 1)}|${p.max_quantity ?? ""}|${p.amount.toFixed(2)}`
}

export function pricesEqual(
  existing: ExistingPrice[],
  desired: DesiredPrice[]
): boolean {
  const base = existing.filter(
    (p) => !p.price_list_id && p.currency_code === CURRENCY
  )
  if (base.length !== desired.length) {
    return false
  }
  const have = new Set(base.map(priceKey))
  return desired.every((p) => have.has(priceKey(p)))
}

/**
 * Den kompletten Abgleich planen — reine Funktion, damit die Tests sie ohne
 * Datenbank füttern können und der Trockenlauf garantiert dasselbe zeigt,
 * was der Schreiblauf täte.
 */
export function planCatalogUpdate(input: {
  existing: ExistingProduct[]
  catalog: CatalogProduct[]
  content: ContentEntry[]
  inventory: InventoryEntry[]
  step: number
}): CatalogUpdatePlan {
  const { existing, catalog, content, inventory, step } = input

  const contentByHandle = new Map(content.map((c) => [c.handle, c]))
  const existingByHandle = new Map(existing.map((p) => [p.handle, p]))

  const plan: CatalogUpdatePlan = {
    products: [],
    inventory: [],
    missingInMedusa: [],
    notInCatalog: [],
    unknownSkus: [],
    noBasePrice: [],
  }

  const catalogHandles = new Set<string>()
  const variantBySku = new Map<string, { product: ExistingProduct; variant: ExistingVariant }>()
  for (const p of existing) {
    for (const v of p.variants) {
      if (v.sku) {
        variantBySku.set(v.sku, { product: p, variant: v })
      }
    }
  }

  for (const entry of catalog) {
    const handle = slugify(entry.product)
    catalogHandles.add(handle)

    const product = existingByHandle.get(handle)
    if (!product) {
      plan.missingInMedusa.push(handle)
      continue
    }

    const productPlan: ProductPlan = {
      id: product.id,
      handle,
      update: {},
      variantPrices: [],
      variantData: [],
      changes: [],
    }

    // Beschreibung & Untertitel — nur setzen, wenn die Content-Datei etwas
    // hat und es abweicht. Nie einen vorhandenen Text mit leer überschreiben.
    const c = contentByHandle.get(handle)
    for (const field of ["subtitle", "description"] as const) {
      const want = c?.[field]
      if (want && want !== (product[field] ?? "")) {
        productPlan.update[field] = want
        productPlan.changes.push({
          field,
          before: fmtText(product[field]),
          after: fmtText(want),
        })
      }
    }

    // Marke — nur setzen, wenn der Katalog eine hat und sie abweicht.
    // metadata wird gemerged geschrieben, damit andere Schlüssel überleben.
    const haveBrand =
      typeof product.metadata?.brand === "string" ? product.metadata.brand : ""
    if (entry.brand && entry.brand !== haveBrand) {
      productPlan.update.metadata = {
        ...(product.metadata ?? {}),
        brand: entry.brand,
      }
      productPlan.changes.push({
        field: "brand",
        before: fmtText(haveBrand || null),
        after: fmtText(entry.brand),
      })
    }

    // Preise je Variante, Zuordnung über die deterministische SKU.
    for (const variant of entry.variants) {
      const sku = skuFor(entry.product, variant)
      const existingVariant = product.variants.find((v) => v.sku === sku)
      if (!existingVariant) {
        productPlan.changes.push({
          field: `${sku}`,
          before: "Variante fehlt in Medusa",
          after: "wird NICHT angelegt (import-catalog.ts verwenden)",
        })
        continue
      }

      // EAN und Gewicht — unabhängig vom Preisproblem weiter unten, damit
      // Galaxus-Daten auch dann ankommen, wenn eine Staffel klemmt. Die
      // Katalogfelder `gtin` und `ean` zielen beide auf variant.ean (jede
      // Länge, siehe gtin.ts); die Validierung garantiert, dass sie gleich
      // lauten, wenn beide dastehen.
      const dataUpdate: VariantDataPlan["update"] = {}
      const wantEan = catalogEan(variant)
      if (wantEan != null && wantEan !== (existingVariant.ean ?? null)) {
        dataUpdate.ean = wantEan
        productPlan.changes.push({
          field: `${sku} ean`,
          before: existingVariant.ean ?? "(leer)",
          after: wantEan,
        })
      }
      if (
        variant.weight_g != null &&
        variant.weight_g !== (existingVariant.weight ?? null)
      ) {
        dataUpdate.weight = variant.weight_g
        productPlan.changes.push({
          field: `${sku} gewicht`,
          before:
            existingVariant.weight != null
              ? `${existingVariant.weight} g`
              : "(leer)",
          after: `${variant.weight_g} g`,
        })
      }
      if (Object.keys(dataUpdate).length) {
        productPlan.variantData.push({
          variant_id: existingVariant.id,
          sku,
          update: dataUpdate,
        })
      }

      // Wie import-catalog.ts: eine Staffel, die nicht bei 1 beginnt, lässt
      // den Warenkorb für kleine Mengen ohne Preis dastehen. Nie schreiben.
      if (variant.tiers[0]?.min_quantity !== 1) {
        plan.noBasePrice.push(`${handle} (${sku})`)
        continue
      }

      const desired: DesiredPrice[] = variant.tiers.map((t) => ({
        amount: roundTo(t.price, step),
        currency_code: CURRENCY,
        min_quantity: t.min_quantity,
        max_quantity: t.max_quantity,
      }))

      if (!pricesEqual(existingVariant.prices, desired)) {
        productPlan.variantPrices.push({
          variant_id: existingVariant.id,
          sku,
          prices: desired,
        })
        productPlan.changes.push({
          field: `${sku} preise`,
          before: fmtTiers(
            existingVariant.prices.filter(
              (p) => !p.price_list_id && p.currency_code === CURRENCY
            )
          ),
          after: fmtTiers(desired),
        })
      }
    }

    if (productPlan.changes.length) {
      plan.products.push(productPlan)
    }
  }

  for (const p of existing) {
    if (!catalogHandles.has(p.handle)) {
      plan.notInCatalog.push(p.handle)
    }
  }

  // Bestand: quantity=null heisst "noch nicht gezählt" — Variante bleibt
  // unangetastet. Eine Zahl schaltet die Bestandsführung ein.
  for (const item of inventory) {
    if (item.quantity === null || item.quantity === undefined) {
      continue
    }
    const hit = variantBySku.get(item.sku)
    if (!hit) {
      plan.unknownSkus.push(item.sku)
      continue
    }

    const invPlan: InventoryPlan = {
      sku: item.sku,
      variant_id: hit.variant.id,
      set_manage_inventory: !hit.variant.manage_inventory,
      create_item: hit.variant.inventory_item_ids.length === 0,
      needs_link: hit.variant.inventory_item_ids.length === 0,
      item_id: hit.variant.inventory_item_ids[0] ?? null,
      level: { action: "create", quantity: item.quantity },
      changes: [],
    }
    if (invPlan.set_manage_inventory) {
      invPlan.changes.push({
        field: `${item.sku} manage_inventory`,
        before: "false",
        after: "true",
      })
    }
    plan.inventory.push(invPlan)
  }

  return plan
}

// ─── Ausführung ─────────────────────────────────────────────────

export default async function updateCatalog({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  const opts = parseScriptArgs(args)

  const file = opts.file(".json")
  if (!file) {
    logger.error("Pfad zu catalog.json fehlt.")
    return
  }

  const dryRun = opts.flag("dry-run")
  const step = Number(opts.value("round") ?? String(ROUND_DEFAULT))

  const readJson = <T>(path: string): T =>
    JSON.parse(readFileSync(resolve(path), "utf8"))

  const catalogs: CatalogProduct[][] = [readJson<CatalogProduct[]>(file)]
  const extraPath = opts.value("extra")
  if (extraPath) {
    catalogs.push(readJson<CatalogProduct[]>(extraPath))
  }
  const catalog = mergeCatalogs(...catalogs)

  // Wirft bei einer ungültigen oder doppelten GTIN — auch im Probelauf.
  assertCatalogGtins(catalog)

  // Dieselbe Prüfung wie import-catalog.ts: kaputte EANs oder Gewichte
  // sollen auffallen, bevor irgendetwas geschrieben wird.
  const dataErrors = validateCatalogData(catalog)
  if (dataErrors.length) {
    logger.error("Ungültige Katalogdaten — nichts wurde geändert:")
    dataErrors.forEach((e) => logger.error(`  ${e}`))
    return
  }

  const contentPath = opts.value("content")
  const content = contentPath ? readJson<ContentEntry[]>(contentPath) : []

  const inventoryPath = opts.value("inventory")
  const inventory = inventoryPath
    ? readJson<InventoryFile>(inventoryPath).items
    : []

  // ── Ist-Zustand laden ──────────────────────────────────────────
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "subtitle",
      "description",
      "metadata",
      "variants.id",
      "variants.sku",
      "variants.ean",
      "variants.weight",
      "variants.manage_inventory",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.prices.min_quantity",
      "variants.prices.max_quantity",
      "variants.prices.price_list_id",
      "variants.inventory_items.inventory_item_id",
    ],
  })

  const existing: ExistingProduct[] = products.map((p: any) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    subtitle: p.subtitle ?? null,
    description: p.description ?? null,
    metadata: p.metadata ?? null,
    variants: (p.variants ?? []).map((v: any) => ({
      id: v.id,
      sku: v.sku ?? null,
      ean: v.ean ?? null,
      weight: v.weight == null ? null : Number(v.weight),
      manage_inventory: !!v.manage_inventory,
      prices: (v.prices ?? []).map((pr: any) => ({
        amount: Number(pr.amount),
        currency_code: pr.currency_code,
        min_quantity: pr.min_quantity === null ? null : Number(pr.min_quantity),
        max_quantity: pr.max_quantity === null ? null : Number(pr.max_quantity),
        price_list_id: pr.price_list_id ?? null,
      })),
      inventory_item_ids: (v.inventory_items ?? [])
        .map((l: any) => l.inventory_item_id)
        .filter(Boolean),
    })),
  }))

  const plan = planCatalogUpdate({ existing, catalog, content, inventory, step })

  // Bestand: Ist-Levels nachschlagen, um create/update/none zu entscheiden.
  let locationId: string | null = null
  if (plan.inventory.length) {
    const { data: locations } = await query.graph({
      entity: "stock_location",
      fields: ["id", "name"],
    })
    locationId = locations[0]?.id ?? null
    if (!locationId) {
      logger.error(
        "Kein Lagerort vorhanden — Bestände können nicht gesetzt werden. " +
          "Zuerst seed.ts laufen lassen."
      )
      plan.inventory = []
    }
  }

  if (plan.inventory.length && locationId) {
    const { data: items } = await query.graph({
      entity: "inventory_item",
      fields: ["id", "sku"],
    })
    const itemBySku = new Map<string, string>(
      items.filter((i: any) => i.sku).map((i: any) => [i.sku, i.id])
    )
    const { data: levels } = await query.graph({
      entity: "inventory_level",
      fields: ["id", "inventory_item_id", "location_id", "stocked_quantity"],
    })
    const levelByItem = new Map<string, { id: string; stocked_quantity: number }>(
      levels
        .filter((l: any) => l.location_id === locationId)
        .map((l: any) => [
          l.inventory_item_id,
          { id: l.id, stocked_quantity: Number(l.stocked_quantity) },
        ])
    )

    for (const inv of plan.inventory) {
      const want = (inv.level as { quantity: number }).quantity
      // Item kann auch ohne Variantenlink schon existieren (z.B. von einem
      // früheren Lauf) — dann nur den Link nachziehen, nicht doppelt anlegen.
      const itemId = inv.item_id ?? itemBySku.get(inv.sku) ?? null
      inv.item_id = itemId
      inv.create_item = itemId === null

      const existingLevel = itemId ? levelByItem.get(itemId) : undefined
      if (!existingLevel) {
        inv.level = { action: "create", quantity: want }
        inv.changes.push({
          field: `${inv.sku} bestand`,
          before: "(kein Level)",
          after: String(want),
        })
      } else if (existingLevel.stocked_quantity !== want) {
        inv.level = {
          action: "update",
          level_id: existingLevel.id,
          from: existingLevel.stocked_quantity,
          to: want,
        }
        inv.changes.push({
          field: `${inv.sku} bestand`,
          before: String(existingLevel.stocked_quantity),
          after: String(want),
        })
      } else {
        inv.level = { action: "none", quantity: want }
      }
    }
    plan.inventory = plan.inventory.filter((inv) => inv.changes.length)
  }

  // ── Bericht ────────────────────────────────────────────────────
  if (plan.missingInMedusa.length) {
    logger.warn(
      `${plan.missingInMedusa.length} Katalog-Produkte fehlen in Medusa ` +
        `(mit import-catalog.ts anlegen): ${plan.missingInMedusa.join(", ")}`
    )
  }
  if (plan.notInCatalog.length) {
    logger.info(
      `${plan.notInCatalog.length} Medusa-Produkte ohne Katalogeintrag — ` +
        `unangetastet: ${plan.notInCatalog.join(", ")}`
    )
  }
  if (plan.unknownSkus.length) {
    logger.warn(
      `inventory.json nennt SKUs ohne Variante: ${plan.unknownSkus.join(", ")}`
    )
  }
  if (plan.noBasePrice.length) {
    logger.warn(
      `Katalog-Staffeln ohne Preis ab Menge 1 — Preise unangetastet ` +
        `(fehlt extra=catalog-extra.json?): ${plan.noBasePrice.join(", ")}`
    )
  }

  const fieldCount =
    plan.products.reduce((n, p) => n + p.changes.length, 0) +
    plan.inventory.reduce((n, i) => n + i.changes.length, 0)

  if (!plan.products.length && !plan.inventory.length) {
    logger.info("Alles auf Stand — nichts zu tun.")
    return
  }

  for (const p of plan.products) {
    logger.info(`${p.handle}`)
    for (const ch of p.changes) {
      logger.info(`    ${ch.field}: ${ch.before} -> ${ch.after}`)
    }
  }
  for (const inv of plan.inventory) {
    for (const ch of inv.changes) {
      logger.info(`    ${ch.field}: ${ch.before} -> ${ch.after}`)
    }
  }
  logger.info(
    `${plan.products.length} Produkte, ${plan.inventory.length} Bestände — ` +
      `${fieldCount} Feldänderungen.`
  )

  if (dryRun) {
    logger.info("— Probelauf, es wurde nichts geschrieben —")
    return
  }

  // ── Schreiben ──────────────────────────────────────────────────
  const productUpdates = plan.products
    .filter((p) => Object.keys(p.update).length)
    .map((p) => ({ id: p.id, ...p.update }))
  if (productUpdates.length) {
    await updateProductsWorkflow(container).run({
      input: { products: productUpdates },
    })
    logger.info(`${productUpdates.length} Produkttexte aktualisiert.`)
  }

  const priceUpdates = plan.products.flatMap((p) => p.variantPrices)
  if (priceUpdates.length) {
    await updateProductVariantsWorkflow(container).run({
      input: {
        product_variants: priceUpdates.map((v) => ({
          id: v.variant_id,
          prices: v.prices,
        })),
      },
    })
    logger.info(`${priceUpdates.length} Varianten-Preise ersetzt.`)
  }

  const dataUpdates = plan.products.flatMap((p) => p.variantData)
  if (dataUpdates.length) {
    await updateProductVariantsWorkflow(container).run({
      input: {
        product_variants: dataUpdates.map((v) => ({
          id: v.variant_id,
          ...v.update,
        })),
      },
    })
    logger.info(`${dataUpdates.length} Varianten-Stammdaten (EAN/Gewicht) gesetzt.`)
  }

  const manageUpdates = plan.inventory.filter((i) => i.set_manage_inventory)
  if (manageUpdates.length) {
    await updateProductVariantsWorkflow(container).run({
      input: {
        product_variants: manageUpdates.map((i) => ({
          id: i.variant_id,
          manage_inventory: true,
        })),
      },
    })
  }

  const itemsToCreate = plan.inventory.filter((i) => i.create_item)
  if (itemsToCreate.length) {
    const { result: createdItems } = await createInventoryItemsWorkflow(
      container
    ).run({
      input: { items: itemsToCreate.map((i) => ({ sku: i.sku })) },
    })
    const createdBySku = new Map(createdItems.map((i: any) => [i.sku, i.id]))
    for (const inv of itemsToCreate) {
      inv.item_id = createdBySku.get(inv.sku) ?? null
    }
  }

  // Varianten ohne Inventory-Link verknüpfen — sonst zählt der Bestand nicht.
  const linksToCreate = plan.inventory.filter((i) => i.item_id && i.needs_link)
  if (linksToCreate.length) {
    await link.create(
      linksToCreate.map((i) => ({
        [Modules.PRODUCT]: { variant_id: i.variant_id },
        [Modules.INVENTORY]: { inventory_item_id: i.item_id! },
      }))
    )
  }

  const levelCreates = plan.inventory.filter(
    (i) => i.level.action === "create" && i.item_id
  )
  if (levelCreates.length && locationId) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: levelCreates.map((i) => ({
          inventory_item_id: i.item_id!,
          location_id: locationId!,
          stocked_quantity: (i.level as { quantity: number }).quantity,
        })),
      },
    })
  }

  const levelUpdates = plan.inventory.filter((i) => i.level.action === "update")
  if (levelUpdates.length && locationId) {
    await updateInventoryLevelsWorkflow(container).run({
      input: {
        updates: levelUpdates.map((i) => ({
          inventory_item_id: i.item_id!,
          location_id: locationId!,
          stocked_quantity: (i.level as { to: number }).to,
        })),
      },
    })
  }

  if (plan.inventory.length) {
    logger.info(`${plan.inventory.length} Bestände gesetzt.`)
  }

  logger.info("Fertig.")
}
