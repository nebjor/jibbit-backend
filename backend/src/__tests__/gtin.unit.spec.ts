/**
 * gtin.ts — GS1-Prüfziffer, Zuordnung auf Medusas native Spalten, und dass
 * import-catalog.ts an einer falschen Nummer laut scheitert, statt sie
 * anzulegen.
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

import {
  assertCatalogGtins,
  gtinFieldFor,
  gtinFields,
  isValidGtin,
  validateCatalogGtins,
} from "../scripts/gtin"
import importCatalog, { CatalogProduct } from "../scripts/import-catalog"

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

describe("gtinFields", () => {
  it("GTIN-13 -> ean, GTIN-12 -> upc, GTIN-8 und GTIN-14 -> barcode", () => {
    expect(gtinFieldFor(GTIN13)).toBe("ean")
    expect(gtinFieldFor(GTIN12)).toBe("upc")
    expect(gtinFieldFor(GTIN8)).toBe("barcode")
    expect(gtinFieldFor(GTIN14)).toBe("barcode")
    expect(gtinFields(GTIN13)).toEqual({ ean: GTIN13 })
  })

  it("ohne GTIN wird kein Feld gesetzt", () => {
    expect(gtinFields(undefined)).toEqual({})
    expect(gtinFields(null)).toEqual({})
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

  it("meldet doppelt vergebene Nummern — die Spalten sind unique", () => {
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
  const container = {
    resolve: (key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
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

  it("legt die GTIN in der nativen Spalte an, nicht in metadata", async () => {
    const path = write("ok.json", [
      product("Greengo Rolls", [GTIN8, GTIN13]),
      product("RAW Rolls", [GTIN12]),
      product("OCB Rolls", [undefined]),
    ])

    await importCatalog({ container, args: [path] } as any)

    expect(createProductsWorkflow).toHaveBeenCalledTimes(1)
    const { products } = (runMock.mock.calls[0] as any[])[0].input
    const pick = (v: any) => ({ ean: v.ean, upc: v.upc, barcode: v.barcode })
    expect(products[0].variants.map(pick)).toEqual([
      { ean: undefined, upc: undefined, barcode: GTIN8 },
      { ean: GTIN13, upc: undefined, barcode: undefined },
    ])
    expect(pick(products[1].variants[0])).toEqual({
      ean: undefined,
      upc: GTIN12,
      barcode: undefined,
    })
    expect(pick(products[2].variants[0])).toEqual({
      ean: undefined,
      upc: undefined,
      barcode: undefined,
    })
    expect(products[0].variants[0].metadata).toEqual({
      units_per_pack: 1,
      pack_type: "single",
    })
  })

  it("bricht bei einer ungültigen GTIN laut ab, bevor irgendetwas passiert", async () => {
    const path = write("broken.json", [product("Greengo Rolls", ["85966780"])])

    await expect(
      importCatalog({ container, args: [path, "dry-run"] } as any)
    ).rejects.toThrow(/Ungültige GTIN/)
    await expect(
      importCatalog({ container, args: [path] } as any)
    ).rejects.toThrow(/Greengo Rolls \/ Einzeln/)

    expect(graphMock).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
  })
})
