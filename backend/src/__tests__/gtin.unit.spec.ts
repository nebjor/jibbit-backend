/**
 * gtin.ts — GS1-Prüfziffer, Ablage in variant.ean (jede Länge, damit der
 * Galaxus-Export die Nummer sieht), und dass import-catalog.ts an einer
 * falschen Nummer laut scheitert, statt sie anzulegen.
 *
 * Die Workflows aus core-flows sind gemockt, wie in update-catalog.unit.spec.ts.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runMock = jest.fn(async () => ({ result: [] as any[] }))

jest.mock("@medusajs/medusa/core-flows", () => ({
  createProductCategoriesWorkflow: jest.fn(() => ({ run: runMock })),
  createProductsWorkflow: jest.fn(() => ({ run: runMock })),
  createInventoryLevelsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

import { buildGalaxusExport, VariantSnapshot } from "../scripts/galaxus-common"
import {
  assertCatalogGtins,
  catalogEan,
  isValidGtin,
  validateCatalogGtins,
} from "../scripts/gtin"
import importCatalog, {
  CatalogProduct,
  validateCatalogData,
} from "../scripts/import-catalog"

const GTIN8 = "85966789"
const GTIN12 = "716165280293"
const GTIN13 = "8595134501285"
const GTIN14 = "18595134501282"

const product = (
  name: string,
  gtins: (string | undefined)[]
): CatalogProduct => ({
  product: name,
  ref: null,
  variants: gtins.map((gtin, i) => ({
    label: i === 0 ? "Einzeln" : `Display (${i * 24} Stk.)`,
    pack_type: i === 0 ? "single" : "display",
    units_per_pack: i === 0 ? 1 : i * 24,
    ...(gtin === undefined ? {} : { gtin }),
    tiers: [{ min_quantity: 1, max_quantity: null, price: 2 }],
  })),
})

// ─── Prüfziffer ─────────────────────────────────────────────────

describe("isValidGtin", () => {
  it("akzeptiert gültige GTIN-8, -12, -13 und -14", () => {
    for (const gtin of [GTIN8, GTIN12, GTIN13, GTIN14, "036000291452"]) {
      expect(isValidGtin(gtin)).toBe(true)
    }
  })

  it("lehnt eine falsche Prüfziffer ab", () => {
    expect(isValidGtin("85966780")).toBe(false)
    expect(isValidGtin("716165280294")).toBe(false)
    expect(isValidGtin("8595134501286")).toBe(false)
  })

  it("lehnt alles ab, was nicht nur aus Ziffern besteht", () => {
    expect(isValidGtin("8595-134501285")).toBe(false)
    expect(isValidGtin(" 8595134501285")).toBe(false)
    expect(isValidGtin("85966A89")).toBe(false)
    expect(isValidGtin("")).toBe(false)
  })

  it("lehnt falsche Längen ab — auch wenn die Prüfziffer aufginge", () => {
    // Führende Nullen ändern die Prüfziffer nicht — die Länge schon.
    expect(isValidGtin("085966789")).toBe(false)
    expect(isValidGtin("0085966789")).toBe(false)
    expect(isValidGtin("008595134501285")).toBe(false)
    expect(isValidGtin("8596678")).toBe(false)
  })

  it("lehnt Zahlen, null und undefined ab — JSON-Zahlen verlieren führende Nullen", () => {
    expect(isValidGtin(85966789)).toBe(false)
    expect(isValidGtin(null)).toBe(false)
    expect(isValidGtin(undefined)).toBe(false)
  })

  it("lehnt den Nullen-Platzhalter ab", () => {
    expect(isValidGtin("0000000000000")).toBe(false)
  })
})

// ─── Zuordnung ──────────────────────────────────────────────────

describe("catalogEan", () => {
  it("jede Länge geht nach variant.ean — gtin und ean zielen auf dieselbe Spalte", () => {
    for (const gtin of [GTIN8, GTIN12, GTIN13, GTIN14]) {
      expect(catalogEan({ gtin })).toBe(gtin)
      expect(catalogEan({ ean: gtin })).toBe(gtin)
      expect(catalogEan({ gtin, ean: gtin })).toBe(gtin)
    }
  })

  it("ohne Nummer wird nichts gesetzt", () => {
    expect(catalogEan({})).toBeUndefined()
    expect(catalogEan({ gtin: null, ean: null })).toBeUndefined()
  })
})

// ─── Katalogprüfung ─────────────────────────────────────────────

describe("validateCatalogGtins", () => {
  it("fehlende GTINs sind kein Fehler", () => {
    expect(validateCatalogGtins([product("Ohne", [undefined, undefined])])).toEqual([])
  })

  it("gültige, verschiedene GTINs gehen durch", () => {
    expect(validateCatalogGtins([product("Greengo", [GTIN8, GTIN13])])).toEqual([])
  })

  it("nennt Produkt und Variante zur ungültigen Nummer", () => {
    const errors = validateCatalogGtins([product("Greengo", [GTIN8, "8595134501286"])])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Greengo / Display (24 Stk.)")
    expect(errors[0]).toContain("8595134501286")
  })

  it("meldet eine Zahl statt eines Strings", () => {
    const broken = product("Greengo", [GTIN8])
    ;(broken.variants[0] as any).gtin = 85966789
    expect(validateCatalogGtins([broken])).toHaveLength(1)
  })

  it("meldet doppelt vergebene Nummern — die Spalte ist unique", () => {
    const errors = validateCatalogGtins([
      product("Greengo", [GTIN13]),
      product("Anderes", [GTIN13]),
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Greengo / Einzeln")
  })

  it("gtin und das Galaxus-Feld ean dürfen sich nicht widersprechen", () => {
    const same = product("Greengo", [GTIN13])
    same.variants[0].ean = GTIN13
    expect(validateCatalogGtins([same])).toEqual([])

    const clash = product("Greengo", [GTIN13])
    clash.variants[0].ean = "4012345678901"
    const errors = validateCatalogGtins([clash])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("widersprechen")
  })

  it("meldet eine GTIN, die als ean schon an einer anderen Variante steht", () => {
    const other = product("Anderes", [undefined])
    other.variants[0].ean = GTIN13
    const errors = validateCatalogGtins([other, product("Greengo", [GTIN13])])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Anderes / Einzeln")
  })

  it("das Galaxus-Feld ean wird genauso streng geprüft wie gtin", () => {
    const withEan = (ean: string) => {
      const p = product("Greengo", [undefined])
      p.variants[0].ean = ean
      return [p]
    }
    for (const ean of [GTIN8, GTIN12, GTIN13, GTIN14]) {
      expect(validateCatalogData(withEan(ean))).toEqual([])
    }
    // Falsche Prüfziffer, Platzhalter und die Zwischenlängen 9–11, die
    // «8–14 Ziffern» durchliesse, Galaxus aber keinem Artikel zuordnen kann.
    for (const ean of ["8595134501286", "85966780", "0000000000000", "1234567890"]) {
      const errors = validateCatalogData(withEan(ean))
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("Greengo (Einzeln)")
      expect(errors[0]).toContain(ean)
    }
  })

  it("assertCatalogGtins wirft mit allen Fehlern auf einmal", () => {
    expect(() =>
      assertCatalogGtins([product("A", ["123"]), product("B", ["85966780"])])
    ).toThrow(/A \/ Einzeln[\s\S]*B \/ Einzeln/)
    expect(() => assertCatalogGtins([product("A", [GTIN8])])).not.toThrow()
  })
})

// ─── importCatalog ──────────────────────────────────────────────

describe("importCatalog (exec)", () => {
  const graphMock = jest.fn(async ({ entity }: { entity: string }) => ({
    data: entity === "product_category" ? [{ id: "pcat_1", name: "Papers" }] : [],
  }))
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container = {
    resolve: (key: string) => {
      if (key === "logger") {
        return logger
      }
      if (key === "query") {
        return { graph: graphMock }
      }
      if (key === "fulfillment") {
        return { listShippingProfiles: async () => [{ id: "sp_1" }] }
      }
      if (key === "sales_channel") {
        return { listSalesChannels: async () => [{ id: "sc_1" }] }
      }
      throw new Error(`unerwartetes resolve(${key})`)
    },
  } as any

  const dir = mkdtempSync(join(tmpdir(), "import-catalog-"))
  const write = (name: string, catalog: CatalogProduct[]) => {
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(catalog))
    return path
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("legt jede GTIN in variant.ean an — nicht in upc, barcode oder metadata", async () => {
    const path = write("ok.json", [
      product("Greengo Rolls", [GTIN8, GTIN13]),
      product("RAW Rolls", [GTIN12, GTIN14]),
      product("OCB Rolls", [undefined]),
    ])

    await importCatalog({ container, args: ["schreiben", path] } as any)

    expect(createProductsWorkflow).toHaveBeenCalledTimes(1)
    const { products } = (runMock.mock.calls[0] as any[])[0].input
    const eans = (p: any) => p.variants.map((v: any) => v.ean)
    expect(eans(products[0])).toEqual([GTIN8, GTIN13])
    expect(eans(products[1])).toEqual([GTIN12, GTIN14])
    expect(eans(products[2])).toEqual([undefined])
    for (const v of products.flatMap((p: any) => p.variants)) {
      expect(v).not.toHaveProperty("upc")
      expect(v).not.toHaveProperty("barcode")
    }
    expect(products[0].variants[0].metadata).toEqual({
      units_per_pack: 1,
      pack_type: "single",
    })
  })

  it("der Galaxus-Export sieht auch GTIN-8 und GTIN-12 — er liest nur variant.ean", async () => {
    const path = write("galaxus.json", [
      product("Greengo Rolls", [GTIN8]),
      product("RAW Rolls", [GTIN12]),
    ])

    await importCatalog({ container, args: ["schreiben", path] } as any)

    // Was der Import nach variant.ean schreibt, ist genau das, was
    // loadVariantSnapshots als `ean` in den Snapshot übernimmt.
    const { products } = (runMock.mock.calls[0] as any[])[0].input
    const snapshots: VariantSnapshot[] = products.map((p: any) => ({
      handle: p.handle,
      productTitle: p.title,
      variantTitle: p.variants[0].title,
      status: "published",
      sku: p.variants[0].sku,
      ean: p.variants[0].ean ?? null,
      weightG: 20,
      brand: "Marke",
      category: "Papers",
      subtitle: null,
      description: "Beschreibung.",
      imageUrls: ["https://api.jibbit.ch/static/bild.jpg"],
      price: 2,
      stock: 5,
      unitsPerPack: 1,
    }))

    const out = buildGalaxusExport(snapshots)
    expect(out.ausgeschlossen).toEqual([])
    expect(out.exportiert).toBe(2)
    expect(out.productData).toContain(`;${GTIN8};`)
    expect(out.productData).toContain(`;${GTIN12};`)
  })

  it("bricht bei einer ungültigen GTIN laut ab, bevor irgendetwas passiert", async () => {
    const path = write("broken.json", [product("Greengo Rolls", ["85966780"])])

    await expect(
      importCatalog({ container, args: [path, "dry-run"] } as any)
    ).rejects.toThrow(/Ungültige GTIN/)
    await expect(
      importCatalog({ container, args: ["schreiben", path] } as any)
    ).rejects.toThrow(/Greengo Rolls \/ Einzeln/)

    expect(graphMock).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
  })

  it("OHNE `schreiben` ist Probelauf — auch mit `dry-run` — und legt nichts an", async () => {
    const path = write("probe.json", [product("Greengo Rolls", [GTIN8])])

    for (const args of [[path], [path, "dry-run"], ["dry-run", path]]) {
      jest.clearAllMocks()
      await importCatalog({ container, args } as any)
      expect(logger.info.mock.calls[0][0]).toMatch(/^MODUS: PROBELAUF/)
      expect(logger.info.mock.calls.at(-1)![0]).toContain(`schreiben ${path}`)
      expect(createProductsWorkflow).not.toHaveBeenCalled()
      expect(runMock).not.toHaveBeenCalled()
    }
  })

  it("unbekannte Argumente brechen ab, bevor irgendetwas gelesen wird", async () => {
    const path = write("tippfehler.json", [product("Greengo Rolls", [GTIN8])])

    for (const args of [
      ["schreiben", path, "dryrun"],
      ["schreiben", path, "stok=5"],
      ["schreiben", "dry-run", path],
    ]) {
      jest.clearAllMocks()
      await importCatalog({ container, args } as any)
      expect(logger.error.mock.calls[0][0]).toMatch(/^ABBRUCH/)
      expect(graphMock).not.toHaveBeenCalled()
      expect(runMock).not.toHaveBeenCalled()
    }
  })
})
