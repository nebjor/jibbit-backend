/**
 * update-catalog.ts — Planung, Datenkonsistenz und Trockenlauf.
 *
 * Die Workflows aus core-flows sind gemockt: die Tests prüfen, WAS geschrieben
 * würde, ohne eine Datenbank zu brauchen — und dass der Trockenlauf gar nichts
 * schreibt. Der Trockenlauf ist der Normalfall: geschrieben wird nur mit dem
 * ausdrücklichen Argument `schreiben` (siehe script-args.ts).
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readFileSync } from "node:fs"

const runMock = jest.fn(async () => ({ result: [] as any[] }))

jest.mock("@medusajs/medusa/core-flows", () => ({
  // import-catalog.ts (mit-importiert) braucht diese Namen ebenfalls.
  createProductCategoriesWorkflow: jest.fn(() => ({ run: runMock })),
  createProductsWorkflow: jest.fn(() => ({ run: runMock })),
  createInventoryItemsWorkflow: jest.fn(() => ({ run: runMock })),
  createInventoryLevelsWorkflow: jest.fn(() => ({ run: runMock })),
  updateInventoryLevelsWorkflow: jest.fn(() => ({ run: runMock })),
  updateProductsWorkflow: jest.fn(() => ({ run: runMock })),
  updateProductVariantsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import {
  createInventoryItemsWorkflow,
  createInventoryLevelsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"

import updateCatalog, {
  ExistingProduct,
  mergeCatalogs,
  parseScope,
  planCatalogUpdate,
  pricesEqual,
} from "../scripts/update-catalog"
import { validateCatalogGtins } from "../scripts/gtin"
import {
  CatalogProduct,
  categoryFor,
  skuFor,
  slugify,
} from "../scripts/import-catalog"

const DATA_DIR = resolve(__dirname, "../../../data")

const readData = (name: string) =>
  JSON.parse(readFileSync(join(DATA_DIR, name), "utf8"))

// ─── Bausteine ──────────────────────────────────────────────────

const angel: CatalogProduct = {
  product: "Angel Slim Filters 6mm 120stk",
  ref: null,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: [
        { min_quantity: 1, max_quantity: 9, price: 1.4 },
        { min_quantity: 10, max_quantity: null, price: 1.3 },
      ],
    },
    {
      label: "Display (34 Stk.)",
      pack_type: "display",
      units_per_pack: 34,
      tiers: [{ min_quantity: 1, max_quantity: null, price: 40.8 }],
    },
  ],
}

const angelHandle = slugify(angel.product)
const angelSkuEA = skuFor(angel.product, angel.variants[0])
const angelSkuD = skuFor(angel.product, angel.variants[1])

function existingAngel(overrides: Partial<ExistingProduct> = {}): ExistingProduct {
  return {
    id: "prod_1",
    handle: angelHandle,
    title: angel.product,
    subtitle: null,
    description: null,
    variants: [
      {
        id: "var_1",
        sku: angelSkuEA,
        manage_inventory: false,
        inventory_item_ids: [],
        prices: [
          { amount: 1.4, currency_code: "chf", min_quantity: 1, max_quantity: 9, price_list_id: null },
          { amount: 1.3, currency_code: "chf", min_quantity: 10, max_quantity: null, price_list_id: null },
        ],
      },
      {
        id: "var_2",
        sku: angelSkuD,
        manage_inventory: false,
        inventory_item_ids: [],
        prices: [
          { amount: 40.8, currency_code: "chf", min_quantity: 1, max_quantity: null, price_list_id: null },
        ],
      },
    ],
    ...overrides,
  }
}

// ─── mergeCatalogs ──────────────────────────────────────────────

describe("mergeCatalogs", () => {
  it("überschreibt Einträge mit gleichem Handle durch die spätere Datei", () => {
    const stale: CatalogProduct = {
      ...angel,
      variants: [angel.variants[0]],
    }
    const merged = mergeCatalogs([stale], [angel])
    expect(merged).toHaveLength(1)
    expect(merged[0].variants).toHaveLength(2)
  })

  it("nimmt neue Produkte einfach dazu", () => {
    const dose: CatalogProduct = {
      product: "Silikon Dose ø 22mm hellgrün",
      ref: null,
      variants: [
        {
          label: "Einzeln",
          pack_type: "single",
          units_per_pack: 1,
          tiers: [{ min_quantity: 1, max_quantity: null, price: 1.1 }],
        },
      ],
    }
    expect(mergeCatalogs([angel], [dose])).toHaveLength(2)
  })
})

// ─── Planung ────────────────────────────────────────────────────

describe("planCatalogUpdate", () => {
  const base = {
    catalog: [angel],
    content: [],
    inventory: [],
    step: 0.05,
  }

  it("ist idempotent: identischer Zustand ergibt keinen Plan", () => {
    const plan = planCatalogUpdate({ ...base, existing: [existingAngel()] })
    expect(plan.products).toHaveLength(0)
    expect(plan.inventory).toHaveLength(0)
  })

  it("setzt Beschreibung und Untertitel nur, wenn Inhalt da ist und abweicht", () => {
    const content = [
      { handle: angelHandle, subtitle: "6mm Slim Filter", description: "Text." },
    ]
    const plan = planCatalogUpdate({
      ...base,
      content,
      existing: [existingAngel()],
    })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0].update).toEqual({
      subtitle: "6mm Slim Filter",
      description: "Text.",
    })

    // Danach ist der Zustand gleich — zweiter Lauf plant nichts mehr.
    const after = existingAngel({
      subtitle: "6mm Slim Filter",
      description: "Text.",
    })
    const second = planCatalogUpdate({ ...base, content, existing: [after] })
    expect(second.products).toHaveLength(0)
  })

  it("überschreibt vorhandene Texte nie mit leeren Content-Feldern", () => {
    const existing = existingAngel({
      subtitle: "Vorhanden",
      description: "Vorhanden",
    })
    const plan = planCatalogUpdate({
      ...base,
      content: [{ handle: angelHandle, subtitle: null, description: undefined }],
      existing: [existing],
    })
    expect(plan.products).toHaveLength(0)
  })

  it("erkennt Preisabweichungen je Variante und plant den kompletten Staffelsatz", () => {
    const existing = existingAngel()
    existing.variants[0].prices[1].amount = 1.35 // Odoo sagt 1.30
    const plan = planCatalogUpdate({ ...base, existing: [existing] })
    expect(plan.products).toHaveLength(1)
    const vp = plan.products[0].variantPrices
    expect(vp).toHaveLength(1)
    expect(vp[0].sku).toBe(angelSkuEA)
    expect(vp[0].prices).toEqual([
      { amount: 1.4, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
      { amount: 1.3, currency_code: "chf", min_quantity: 10, max_quantity: null },
    ])
    // Die Display-Variante stimmt und bleibt unangetastet.
    expect(plan.products[0].changes.map((c) => c.field)).toEqual([
      `${angelSkuEA} preise`,
    ])
  })

  it("ignoriert Preislisten-Preise beim Vergleich", () => {
    const existing = existingAngel()
    existing.variants[0].prices.push({
      amount: 0.99,
      currency_code: "chf",
      min_quantity: 1,
      max_quantity: null,
      price_list_id: "plist_aktion",
    })
    expect(
      pricesEqual(existing.variants[0].prices, [
        { amount: 1.4, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
        { amount: 1.3, currency_code: "chf", min_quantity: 10, max_quantity: null },
      ])
    ).toBe(true)
  })

  it("meldet Produkte, die in Medusa fehlen, statt sie anzulegen", () => {
    const plan = planCatalogUpdate({ ...base, existing: [] })
    expect(plan.missingInMedusa).toEqual([angelHandle])
    expect(plan.products).toHaveLength(0)
  })

  it("meldet fehlende Varianten, plant für sie aber keine Preise", () => {
    const existing = existingAngel()
    existing.variants = [existing.variants[0]] // Display fehlt
    const plan = planCatalogUpdate({ ...base, existing: [existing] })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0].variantPrices).toHaveLength(0)
    expect(plan.products[0].changes[0].field).toBe(angelSkuD)
  })

  it("fasst Preise nie an, wenn die Katalog-Staffel nicht bei Menge 1 beginnt", () => {
    // Der rohe OCB-Bio-Eintrag aus catalog.json: nur ein 24+-Preis. Ohne
    // Sperre würde ein Lauf ohne extra= den Menge-1-Preis löschen.
    const broken: CatalogProduct = {
      ...angel,
      variants: [
        {
          ...angel.variants[0],
          tiers: [{ min_quantity: 24, max_quantity: null, price: 1.6 }],
        },
      ],
    }
    const plan = planCatalogUpdate({
      ...base,
      catalog: [broken],
      existing: [existingAngel()],
    })
    expect(plan.products).toHaveLength(0)
    expect(plan.noBasePrice).toEqual([`${angelHandle} (${angelSkuEA})`])
  })

  it("plant EAN, Gewicht und Marke, wenn der Katalog sie neu liefert", () => {
    const catalog: CatalogProduct[] = [
      {
        ...angel,
        brand: "Angel",
        variants: [
          { ...angel.variants[0], ean: "4012345678901", weight_g: 30 },
          angel.variants[1],
        ],
      },
    ]
    const plan = planCatalogUpdate({
      ...base,
      catalog,
      existing: [existingAngel()],
    })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0].update.metadata).toEqual({ brand: "Angel" })
    expect(plan.products[0].variantData).toEqual([
      {
        variant_id: "var_1",
        sku: angelSkuEA,
        update: { ean: "4012345678901", weight: 30 },
      },
    ])

    // Zweiter Lauf mit nachgezogenem Ist-Zustand: nichts mehr zu tun.
    const after = existingAngel({ metadata: { brand: "Angel" } })
    after.variants[0].ean = "4012345678901"
    after.variants[0].weight = 30
    const second = planCatalogUpdate({ ...base, catalog, existing: [after] })
    expect(second.products).toHaveLength(0)
  })

  it("löscht nie EAN/Gewicht/Marke, wenn der Katalog keine Werte hat", () => {
    const existing = existingAngel({ metadata: { brand: "Angel" } })
    existing.variants[0].ean = "4012345678901"
    existing.variants[0].weight = 30
    const plan = planCatalogUpdate({ ...base, existing: [existing] })
    expect(plan.products).toHaveLength(0)
  })

  it("plant jede GTIN nach variant.ean — auch GTIN-8 und GTIN-12, und nur bei Abweichung", () => {
    const withGtin: CatalogProduct = {
      ...angel,
      variants: [
        { ...angel.variants[0], gtin: "85966789" }, // GTIN-8
        { ...angel.variants[1], gtin: "716165280293" }, // GTIN-12
      ],
    }
    const plan = planCatalogUpdate({
      ...base,
      catalog: [withGtin],
      existing: [existingAngel()],
    })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0].variantPrices).toHaveLength(0)
    // Dieselbe Spalte, die galaxus-common.ts liest — nie upc/barcode.
    expect(plan.products[0].variantData).toEqual([
      { variant_id: "var_1", sku: angelSkuEA, update: { ean: "85966789" } },
      { variant_id: "var_2", sku: angelSkuD, update: { ean: "716165280293" } },
    ])
    expect(plan.products[0].changes.map((c) => c.field)).toEqual([
      `${angelSkuEA} ean`,
      `${angelSkuD} ean`,
    ])

    // Danach ist der Zustand gleich — zweiter Lauf plant nichts mehr.
    const after = existingAngel()
    after.variants[0].ean = "85966789"
    after.variants[1].ean = "716165280293"
    const second = planCatalogUpdate({
      ...base,
      catalog: [withGtin],
      existing: [after],
    })
    expect(second.products).toHaveLength(0)
  })

  it("plant eine Nummer nur einmal, wenn gtin und ean dasselbe sagen", () => {
    const both: CatalogProduct = {
      ...angel,
      variants: [
        { ...angel.variants[0], gtin: "8595134501285", ean: "8595134501285" },
        angel.variants[1],
      ],
    }
    const plan = planCatalogUpdate({
      ...base,
      catalog: [both],
      existing: [existingAngel()],
    })
    expect(plan.products[0].variantData).toEqual([
      { variant_id: "var_1", sku: angelSkuEA, update: { ean: "8595134501285" } },
    ])
    expect(plan.products[0].changes).toHaveLength(1)
  })

  it("lässt im Admin gepflegte Nummern stehen, wenn der Katalog keine GTIN hat", () => {
    const existing = existingAngel()
    existing.variants[0].ean = "8595134501285"
    const plan = planCatalogUpdate({ ...base, existing: [existing] })
    expect(plan.products).toHaveLength(0)
  })

  it("erhält beim Setzen der Marke vorhandene Metadaten", () => {
    const existing = existingAngel({ metadata: { seo_title: "Angel Filter" } })
    const plan = planCatalogUpdate({
      ...base,
      catalog: [{ ...angel, brand: "Angel" }],
      existing: [existing],
    })
    expect(plan.products[0].update.metadata).toEqual({
      seo_title: "Angel Filter",
      brand: "Angel",
    })
  })

  it("überspringt Inventar mit quantity=null und meldet unbekannte SKUs", () => {
    const plan = planCatalogUpdate({
      ...base,
      existing: [existingAngel()],
      inventory: [
        { sku: angelSkuEA, quantity: null },
        { sku: "GIBTS-NICHT-EA", quantity: 5 },
        { sku: angelSkuD, quantity: 3 },
      ],
    })
    expect(plan.unknownSkus).toEqual(["GIBTS-NICHT-EA"])
    expect(plan.inventory).toHaveLength(1)
    expect(plan.inventory[0].sku).toBe(angelSkuD)
    expect(plan.inventory[0].set_manage_inventory).toBe(true)
  })

  // ── Bereich nur= ──────────────────────────────────────────────

  /** Alles weicht ab: Text, Marke, GTIN, Gewicht, Preis und Bestand. */
  const allesAnders = () => {
    const existing = existingAngel()
    existing.variants[0].prices[1].amount = 1.35
    return {
      ...base,
      catalog: [
        {
          ...angel,
          brand: "Angel",
          variants: [
            { ...angel.variants[0], gtin: "85966789", weight_g: 30 },
            angel.variants[1],
          ],
        },
      ],
      content: [{ handle: angelHandle, subtitle: "Neu", description: "Text." }],
      inventory: [{ sku: angelSkuEA, quantity: 7 }],
      existing: [existing],
    }
  }

  it("nur=gtin plant ausschliesslich die GTIN — keine Preise, Texte, Marke, Gewicht, Bestand", () => {
    const plan = planCatalogUpdate({ ...allesAnders(), scope: "gtin" })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0].update).toEqual({})
    expect(plan.products[0].variantPrices).toEqual([])
    expect(plan.products[0].variantData).toEqual([
      { variant_id: "var_1", sku: angelSkuEA, update: { ean: "85966789" } },
    ])
    expect(plan.products[0].changes.map((c) => c.field)).toEqual([
      `${angelSkuEA} ean`,
    ])
    expect(plan.inventory).toEqual([])
  })

  it("ohne nur= läuft weiterhin alles", () => {
    const plan = planCatalogUpdate(allesAnders())
    expect(Object.keys(plan.products[0].update).sort()).toEqual([
      "description",
      "metadata",
      "subtitle",
    ])
    expect(plan.products[0].variantPrices).toHaveLength(1)
    expect(plan.products[0].variantData[0].update).toEqual({
      ean: "85966789",
      weight: 30,
    })
    expect(plan.inventory).toHaveLength(1)
  })

  it("nur=preise / nur=inhalt / nur=bestand fassen je nur ihren Bereich an", () => {
    const preise = planCatalogUpdate({ ...allesAnders(), scope: "preise" })
    expect(preise.products[0].variantPrices).toHaveLength(1)
    expect(preise.products[0].variantData).toEqual([])
    expect(preise.products[0].update).toEqual({})
    expect(preise.inventory).toEqual([])

    const inhalt = planCatalogUpdate({ ...allesAnders(), scope: "inhalt" })
    expect(inhalt.products[0].update).toEqual({
      subtitle: "Neu",
      description: "Text.",
    })
    expect(inhalt.products[0].variantPrices).toEqual([])
    expect(inhalt.products[0].variantData).toEqual([])

    const bestand = planCatalogUpdate({ ...allesAnders(), scope: "bestand" })
    expect(bestand.products).toEqual([])
    expect(bestand.inventory).toHaveLength(1)
  })

  it("nur=gtin meldet keine fehlenden Menge-1-Preise — Preise sind nicht im Bereich", () => {
    const ohneBasis: CatalogProduct = {
      ...angel,
      variants: [
        {
          ...angel.variants[0],
          tiers: [{ min_quantity: 10, max_quantity: null, price: 1.3 }],
        },
        angel.variants[1],
      ],
    }
    const input = { ...base, catalog: [ohneBasis], existing: [existingAngel()] }
    expect(planCatalogUpdate(input).noBasePrice).toHaveLength(1)
    expect(planCatalogUpdate({ ...input, scope: "gtin" }).noBasePrice).toEqual([])
  })

  it("parseScope kennt genau die vier Bereiche", () => {
    expect(parseScope(undefined)).toEqual({ scope: null })
    expect(parseScope("gtin")).toEqual({ scope: "gtin" })
    expect(parseScope("bestand")).toEqual({ scope: "bestand" })
    expect(parseScope("gtins")).toEqual({
      error: expect.stringContaining("nur=gtins"),
    })
    expect(parseScope("")).toHaveProperty("error")
  })

  // ── Verirrte Codes in upc/barcode ─────────────────────────────

  const mitGtins: CatalogProduct = {
    ...angel,
    variants: [
      { ...angel.variants[0], gtin: "85966789" }, // GTIN-8
      { ...angel.variants[1], gtin: "716165280293" }, // GTIN-12
    ],
  }

  it("leert upc/barcode, wenn dort exakt die Katalog-GTIN steht, und setzt ean", () => {
    // Stand nach dem alten Script: GTIN-8 in barcode, GTIN-12 in upc.
    const existing = existingAngel()
    existing.variants[0].barcode = "85966789"
    existing.variants[1].upc = "716165280293"

    const plan = planCatalogUpdate({
      ...base,
      catalog: [mitGtins],
      existing: [existing],
      scope: "gtin",
    })
    expect(plan.products[0].variantData).toEqual([
      {
        variant_id: "var_1",
        sku: angelSkuEA,
        update: { ean: "85966789", barcode: null },
      },
      {
        variant_id: "var_2",
        sku: angelSkuD,
        update: { ean: "716165280293", upc: null },
      },
    ])
    expect(plan.products[0].changes).toEqual([
      { field: `${angelSkuEA} ean`, before: "(leer)", after: "85966789" },
      {
        field: `${angelSkuEA} barcode`,
        before: "85966789",
        after: "(leer, steht jetzt in ean)",
      },
      { field: `${angelSkuD} ean`, before: "(leer)", after: "716165280293" },
      {
        field: `${angelSkuD} upc`,
        before: "716165280293",
        after: "(leer, steht jetzt in ean)",
      },
    ])
  })

  it("leert den verirrten Code auch, wenn ean schon stimmt — und ist danach idempotent", () => {
    const existing = existingAngel()
    existing.variants[1].ean = "716165280293"
    existing.variants[1].upc = "716165280293"
    existing.variants[0].ean = "85966789"

    const plan = planCatalogUpdate({
      ...base,
      catalog: [mitGtins],
      existing: [existing],
    })
    expect(plan.products[0].variantData).toEqual([
      { variant_id: "var_2", sku: angelSkuD, update: { upc: null } },
    ])

    existing.variants[1].upc = null
    expect(
      planCatalogUpdate({ ...base, catalog: [mitGtins], existing: [existing] })
        .products
    ).toEqual([])
  })

  it("lässt einen ANDEREN Wert in upc/barcode stehen — Hauscodes gehören dem Betreiber", () => {
    const existing = existingAngel()
    existing.variants[0].barcode = "LAGER-0042"
    existing.variants[0].upc = "85966790" // fast die GTIN, aber nicht identisch
    existing.variants[1].barcode = "85966789" // GTIN einer ANDEREN Variante

    const plan = planCatalogUpdate({
      ...base,
      catalog: [mitGtins],
      existing: [existing],
    })
    for (const v of plan.products[0].variantData) {
      expect(v.update).not.toHaveProperty("upc")
      expect(v.update).not.toHaveProperty("barcode")
    }
  })

  it("räumt nie auf, wenn der Katalog für die Variante keine GTIN hat oder GTIN nicht im Bereich ist", () => {
    const existing = existingAngel()
    existing.variants[0].upc = "716165280293"
    expect(planCatalogUpdate({ ...base, existing: [existing] }).products).toEqual([])

    const verirrt = existingAngel()
    verirrt.variants[0].barcode = "85966789"
    const plan = planCatalogUpdate({
      ...base,
      catalog: [mitGtins],
      existing: [verirrt],
      scope: "preise",
    })
    expect(plan.products).toEqual([])
  })
})

// ─── Datenkonsistenz der eingecheckten Dateien ──────────────────

describe("data/*.json", () => {
  const catalog: CatalogProduct[] = readData("catalog.json")
  const extra: CatalogProduct[] = readData("catalog-extra.json")
  const content: { handle: string }[] = readData("product-content.json")
  const inventory: { items: { sku: string }[] } = readData("inventory.json")
  const redirects: {
    redirects: {
      odoo_id: number
      new_path: string
      variant_sku: string | null
      old_paths: string[]
    }[]
  } = readData("odoo-redirects.json")

  const merged = mergeCatalogs(catalog, extra)
  const byHandle = new Map(merged.map((p) => [slugify(p.product), p]))

  it("alle GTINs im Katalog sind gültig und eindeutig", () => {
    expect(validateCatalogGtins(merged)).toEqual([])
  })

  it("catalog-extra.json hat für jede Variante einen Preis ab Menge 1", () => {
    for (const p of extra) {
      for (const v of p.variants) {
        expect(v.tiers[0].min_quantity).toBe(1)
      }
    }
  })

  it("product-content.json deckt exakt die Katalog-Handles ab", () => {
    const contentHandles = new Set(content.map((c) => c.handle))
    const catalogHandles = new Set(byHandle.keys())
    expect([...contentHandles].sort()).toEqual([...catalogHandles].sort())
  })

  it("inventory.json führt exakt die SKUs aller Varianten", () => {
    const want = merged
      .flatMap((p) => p.variants.map((v) => skuFor(p.product, v)))
      .sort()
    const have = inventory.items.map((i) => i.sku).sort()
    expect(have).toEqual(want)
  })

  it("jede Weiterleitung zeigt auf ein Katalogprodukt", () => {
    for (const r of redirects.redirects) {
      const handle = r.new_path.replace("/products/", "")
      expect(byHandle.has(handle)).toBe(true)
      for (const old of r.old_paths) {
        // Odoo-URLs enden auf die numerische ID.
        expect(old).toMatch(new RegExp(`^/shop/.*-${r.odoo_id}$`))
      }
    }
  })

  it("Display-/Box-Seiten zeigen auf die passende Variante", () => {
    const withVariant = redirects.redirects.filter((r) => r.variant_sku)
    // 5 Odoo-Seiten sind in Medusa Varianten: 31, 33, 34, 57, 59.
    expect(withVariant.map((r) => r.odoo_id).sort((a, b) => a - b)).toEqual([
      31, 33, 34, 57, 59,
    ])
    for (const r of withVariant) {
      const p = byHandle.get(r.new_path.replace("/products/", ""))!
      const packVariants = p.variants.filter(
        (v) => v.pack_type === "display" || v.pack_type === "box"
      )
      expect(packVariants.map((v) => skuFor(p.product, v))).toContain(
        r.variant_sku
      )
    }
  })

  it("neue Produkte bekommen sinnvolle Kategorien", () => {
    expect(categoryFor("Silikon Dose ø 22mm hellgrün")).toBe("Zubehör")
    expect(categoryFor("Black Leaf El Humeros Konische Hülsen KS 100x")).toBe(
      "Papers"
    )
    // Regression: die alten Zuordnungen bleiben.
    expect(categoryFor("OCB Premium KSS Papers mit Filter")).toBe("Papers")
    expect(categoryFor("PURIZE Aktivkohlefilter ø 9mm")).toBe("Filter")
    expect(categoryFor("RAW Kristallglas Aschenbecher Ruby")).toBe("Aschenbecher")
  })
})

// ─── Trockenlauf schreibt nichts ────────────────────────────────

describe("updateCatalog (exec)", () => {
  const graphMock = jest.fn()
  const linkCreateMock = jest.fn()
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container = {
    resolve: (key: string) => {
      if (key === "logger") {
        return logger
      }
      if (key === "query") {
        return { graph: graphMock }
      }
      if (key === "link" || key === "remoteLink") {
        return { create: linkCreateMock }
      }
      throw new Error(`unerwartetes resolve(${key})`)
    },
  } as any

  let dir: string
  let catalogPath: string
  let contentPath: string
  let inventoryPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "update-catalog-"))
    catalogPath = join(dir, "catalog.json")
    contentPath = join(dir, "content.json")
    inventoryPath = join(dir, "inventory.json")
    writeFileSync(catalogPath, JSON.stringify([angel]))
    writeFileSync(
      contentPath,
      JSON.stringify([
        { handle: angelHandle, subtitle: "Neu", description: "Neuer Text." },
      ])
    )
    writeFileSync(
      inventoryPath,
      JSON.stringify({ items: [{ sku: angelSkuEA, quantity: 7 }] })
    )
  })

  beforeEach(() => {
    jest.clearAllMocks()
    graphMock.mockImplementation(async ({ entity }: { entity: string }) => {
      if (entity === "product") {
        const p = existingAngel()
        return {
          data: [
            {
              ...p,
              variants: p.variants.map((v) => ({
                ...v,
                inventory_items: [],
              })),
            },
          ],
        }
      }
      if (entity === "stock_location") {
        return { data: [{ id: "loc_1", name: "Lager" }] }
      }
      if (entity === "inventory_item") {
        return { data: [] }
      }
      if (entity === "inventory_level") {
        return { data: [] }
      }
      throw new Error(`unerwartete Entity ${entity}`)
    })
  })

  const expectNichtsGeschrieben = () => {
    expect(updateProductsWorkflow).not.toHaveBeenCalled()
    expect(updateProductVariantsWorkflow).not.toHaveBeenCalled()
    expect(createInventoryItemsWorkflow).not.toHaveBeenCalled()
    expect(createInventoryLevelsWorkflow).not.toHaveBeenCalled()
    expect(updateInventoryLevelsWorkflow).not.toHaveBeenCalled()
    expect(linkCreateMock).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
  }

  it("OHNE Modus-Argument ist Trockenlauf: plant, ruft aber keinen einzigen Workflow auf", async () => {
    const args = [
      catalogPath,
      `content=${contentPath}`,
      `inventory=${inventoryPath}`,
    ]
    await updateCatalog({ container, args } as any)

    expectNichtsGeschrieben()
    // Geplant wurde trotzdem — der Probelauf hat die Datenbank gelesen.
    expect(graphMock).toHaveBeenCalled()
    // Erste Zeile nennt den Modus laut, die letzte sagt, wie man anwendet.
    expect(logger.info.mock.calls[0][0]).toMatch(/^MODUS: PROBELAUF/)
    expect(logger.info.mock.calls[0][0]).toContain('"schreiben"')
    expect(logger.info.mock.calls[1][0]).toMatch(/^BEREICH: alles/)
    const last = logger.info.mock.calls.at(-1)![0]
    expect(last).toContain(`schreiben ${args.join(" ")}`)
  })

  it("`dry-run` bleibt erlaubt und bleibt trocken — an jeder Stelle", async () => {
    for (const args of [
      [catalogPath, `content=${contentPath}`, "dry-run"],
      ["dry-run", catalogPath, `content=${contentPath}`],
    ]) {
      await updateCatalog({ container, args } as any)
    }
    expectNichtsGeschrieben()
    // Der Hinweis wiederholt dry-run nicht.
    expect(logger.info.mock.calls.at(-1)![0]).not.toContain("dry-run")
  })

  it("der Vorfall: die abgeschnittene Zeile OHNE das Schlusswort schreibt nicht mehr", async () => {
    // bash führte nur `… update-catalog.js /app/data/catalog.json` aus; der
    // Rest (`extra=… dry-run`) landete in einem zweiten Befehl.
    await updateCatalog({ container, args: [catalogPath] } as any)
    expectNichtsGeschrieben()
  })

  it("unbekannte Argumente brechen ab — vor jeder Abfrage, auch mit `schreiben`", async () => {
    for (const args of [
      ["schreiben", catalogPath, "dryrun"],
      ["schreiben", catalogPath, "schreibe"],
      ["schreiben", catalogPath, `extr=${contentPath}`],
      ["schreiben", catalogPath, contentPath], // zweiter Pfad ohne name=
      ["schreiben", catalogPath, "content="],
      ["schreiben", "dry-run", catalogPath], // Widerspruch
      ["schreiben", catalogPath, "nur=gtins"],
      ["schreiben", catalogPath, "nur=inhalt"], // ohne content=
    ]) {
      jest.clearAllMocks()
      await updateCatalog({ container, args } as any)
      expect(logger.error.mock.calls[0][0]).toMatch(/^ABBRUCH/)
      expect(graphMock).not.toHaveBeenCalled()
      expectNichtsGeschrieben()
    }
  })

  it("Schreiblauf: `schreiben` wird an jeder Stelle angenommen", async () => {
    await updateCatalog({
      container,
      args: [catalogPath, `content=${contentPath}`, "schreiben"],
    } as any)
    expect(updateProductsWorkflow).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][0]).toBe("MODUS: SCHREIBEN")
  })

  it("Schreiblauf: aktualisiert Texte über den Produkt-Workflow", async () => {
    await updateCatalog({
      container,
      args: ["schreiben", catalogPath, `content=${contentPath}`],
    } as any)

    expect(updateProductsWorkflow).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          products: [
            { id: "prod_1", subtitle: "Neu", description: "Neuer Text." },
          ],
        },
      })
    )
    // Preise stimmen bereits — kein Varianten-Update.
    expect(updateProductVariantsWorkflow).not.toHaveBeenCalled()
  })

  it("Schreiblauf: setzt die GTIN über den Varianten-Workflow", async () => {
    const gtinPath = join(dir, "catalog-gtin.json")
    writeFileSync(
      gtinPath,
      JSON.stringify([
        {
          ...angel,
          variants: [{ ...angel.variants[0], gtin: "716165280293" }, angel.variants[1]],
        },
      ])
    )

    await updateCatalog({ container, args: ["schreiben", gtinPath] } as any)

    expect(updateProductVariantsWorkflow).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({
      input: { product_variants: [{ id: "var_1", ean: "716165280293" }] },
    })
  })

  it("nur=gtin: schreibt die GTIN, leert das verirrte upc mit null — und sonst nichts", async () => {
    const gtinPath = join(dir, "catalog-gtin-scope.json")
    writeFileSync(
      gtinPath,
      JSON.stringify([
        {
          ...angel,
          brand: "Angel",
          variants: [
            { ...angel.variants[0], gtin: "716165280293", weight_g: 30 },
            angel.variants[1],
          ],
        },
      ])
    )
    // Medusa-Stand nach dem Vorfall: Nummer in upc, Preis weicht ab.
    graphMock.mockImplementation(async ({ entity }: { entity: string }) => {
      if (entity !== "product") {
        throw new Error(`nur=gtin darf ${entity} nicht abfragen`)
      }
      const p = existingAngel()
      p.variants[0].upc = "716165280293"
      p.variants[0].prices[1].amount = 1.35
      return {
        data: [
          { ...p, variants: p.variants.map((v) => ({ ...v, inventory_items: [] })) },
        ],
      }
    })

    const args = [
      gtinPath,
      "nur=gtin",
      `content=${contentPath}`,
      `inventory=${inventoryPath}`,
    ]

    // Probelauf nennt den Bereich und die Feldänderungen.
    await updateCatalog({ container, args } as any)
    expectNichtsGeschrieben()
    const lines = logger.info.mock.calls.map((c) => c[0])
    expect(lines[1]).toMatch(/^BEREICH: nur gtin/)
    expect(lines).toContain(`    ${angelSkuEA} ean: (leer) -> 716165280293`)
    expect(lines).toContain(
      `    ${angelSkuEA} upc: 716165280293 -> (leer, steht jetzt in ean)`
    )
    expect(lines.some((l) => l.includes("preise"))).toBe(false)

    // Schreiblauf: genau EIN Varianten-Update, null leert die Spalte.
    jest.clearAllMocks()
    await updateCatalog({ container, args: ["schreiben", ...args] } as any)
    expect(updateProductsWorkflow).not.toHaveBeenCalled()
    expect(updateProductVariantsWorkflow).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({
      input: {
        product_variants: [{ id: "var_1", ean: "716165280293", upc: null }],
      },
    })
    expect(createInventoryItemsWorkflow).not.toHaveBeenCalled()
    expect(linkCreateMock).not.toHaveBeenCalled()
  })

  it("bricht bei einer ungültigen GTIN laut ab — auch im Trockenlauf, vor jeder Abfrage", async () => {
    const brokenPath = join(dir, "catalog-broken.json")
    writeFileSync(
      brokenPath,
      JSON.stringify([
        {
          ...angel,
          variants: [{ ...angel.variants[0], gtin: "85966780" }, angel.variants[1]],
        },
      ])
    )

    await expect(
      updateCatalog({ container, args: [brokenPath, "dry-run"] } as any)
    ).rejects.toThrow(/Ungültige GTIN/)
    expect(graphMock).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
  })
})
