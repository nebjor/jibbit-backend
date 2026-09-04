/**
 * Nachschubsteuerung — Adressprüfung, Auswahl der nachzubestellenden
 * Varianten und der Metadaten-Abgleich in update-catalog.ts.
 *
 * Die drei kritischen Punkte laut Anforderung:
 *   1. Die Lieferanten-URL wird im Admin als Link gerendert — nur http/https
 *      darf durchkommen, geprüft beim Einspielen UND beim Rendern.
 *   2. Grenzfall: Bestand GENAU auf dem Meldebestand ist fällig.
 *   3. Eine leere Fällig-Liste ist keine Entwarnung — die Zählung der nicht
 *      überwachbaren Varianten muss stimmen (heute: alle 35).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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

import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows"

import {
  isSafeSupplierUrl,
  istFaellig,
  nachschubMetadataUpdate,
  nachschubUebersicht,
  NachschubZeile,
  parseLieferanten,
  parseMeldebestand,
  validateLieferantenDaten,
} from "../lib/nachschub"
import {
  CatalogProduct,
  skuFor,
  slugify,
  validateCatalogData,
} from "../scripts/import-catalog"
import updateCatalog, {
  ExistingProduct,
  planCatalogUpdate,
} from "../scripts/update-catalog"

const DATA_DIR = resolve(__dirname, "../../../data")

// ─── Adressprüfung ──────────────────────────────────────────────

describe("isSafeSupplierUrl", () => {
  it.each([
    "https://grosshandel.example.ch/produkt/123",
    "http://grosshandel.example.ch/produkt/123",
    "https://shop.example.com/p?id=1&ref=2#top",
  ])("lässt %s durch", (url) => {
    expect(isSafeSupplierUrl(url)).toBe(true)
  })

  it.each([
    ["javascript:alert(1)", "javascript-Schema"],
    ["JavaScript:alert(1)", "Grossschreibung"],
    ["JAVASCRIPT:alert(1)", "Vollversalien"],
    ["  javascript:alert(1)", "führende Leerzeichen"],
    ["\tjavascript:alert(1)", "führender Tab"],
    ["java\tscript:alert(1)", "eingebetteter Tab (URL-Parser entfernt ihn)"],
    ["data:text/html,<script>alert(1)</script>", "data-Schema"],
    ["vbscript:msgbox(1)", "vbscript-Schema"],
    ["file:///etc/passwd", "file-Schema"],
    ["ftp://host/pfad", "ftp-Schema"],
    ["/relativer/pfad", "relative Angabe"],
    ["produktseite.html", "relative Angabe ohne Slash"],
    ["//host.example/pfad", "schema-relative Angabe"],
    ["https://", "URL ohne Host"],
    ["", "leer"],
  ])("blockt %s (%s)", (url) => {
    expect(isSafeSupplierUrl(url)).toBe(false)
  })

  it("blockt Nicht-Strings", () => {
    expect(isSafeSupplierUrl(null)).toBe(false)
    expect(isSafeSupplierUrl(undefined)).toBe(false)
    expect(isSafeSupplierUrl(42)).toBe(false)
    expect(isSafeSupplierUrl({ href: "https://x.ch" })).toBe(false)
  })
})

// ─── Metadaten lesen (Render-Seite) ─────────────────────────────

describe("parseLieferanten", () => {
  it("liest gültige Lieferanten in Reihenfolge (erster = Hauptlieferant)", () => {
    const lieferanten = parseLieferanten({
      suppliers: [
        {
          name: "Grosshandel A",
          url: "https://a.example.ch/p/1",
          article_number: "A-100",
        },
        { name: "Grosshandel B", url: "http://b.example.ch/p/2" },
      ],
    })
    expect(lieferanten).toEqual([
      {
        name: "Grosshandel A",
        url: "https://a.example.ch/p/1",
        artikelnummer: "A-100",
      },
      { name: "Grosshandel B", url: "http://b.example.ch/p/2", artikelnummer: null },
    ])
  })

  it("macht aus einer unsicheren Adresse NIE einen Link", () => {
    const [l] = parseLieferanten({
      suppliers: [{ name: "Böse", url: "javascript:alert(1)" }],
    })
    expect(l.url).toBeNull()
    expect(l.unsichereUrl).toBe("javascript:alert(1)")
  })

  it("übersteht Müll in den Metadaten", () => {
    expect(parseLieferanten(null)).toEqual([])
    expect(parseLieferanten({})).toEqual([])
    expect(parseLieferanten({ suppliers: "kaputt" })).toEqual([])
    expect(
      parseLieferanten({ suppliers: [null, 42, { url: "https://x.ch/p" }] })
    ).toEqual([]) // Einträge ohne Namen fallen weg
  })
})

describe("parseMeldebestand", () => {
  it.each([
    [10, 10],
    [0, 0],
    ["5", 5],
    [-1, null],
    [1.5, null],
    ["abc", null],
    [null, null],
    [undefined, null],
  ])("reorder_point=%p -> %p", (raw, want) => {
    expect(parseMeldebestand({ reorder_point: raw as any })).toBe(want)
  })

  it("fehlende Metadaten -> null", () => {
    expect(parseMeldebestand(null)).toBeNull()
    expect(parseMeldebestand({})).toBeNull()
  })
})

// ─── Auswahl & Zählung ──────────────────────────────────────────

function zeile(overrides: Partial<NachschubZeile>): NachschubZeile {
  return {
    sku: "SKU",
    produkt: "Produkt",
    variante: "Einzeln",
    bestand: null,
    meldebestand: null,
    lieferanten: [],
    ...overrides,
  }
}

describe("nachschubUebersicht", () => {
  it("Grenzfall: Bestand GENAU auf dem Meldebestand ist fällig", () => {
    expect(istFaellig(zeile({ bestand: 10, meldebestand: 10 }))).toBe(true)
    expect(istFaellig(zeile({ bestand: 11, meldebestand: 10 }))).toBe(false)
    expect(istFaellig(zeile({ bestand: 0, meldebestand: 0 }))).toBe(true)
    expect(istFaellig(zeile({ bestand: 1, meldebestand: 0 }))).toBe(false)
  })

  it("ohne Bestand oder ohne Meldebestand ist nichts fällig — nur unüberwachbar", () => {
    expect(istFaellig(zeile({ bestand: null, meldebestand: 10 }))).toBe(false)
    expect(istFaellig(zeile({ bestand: 0, meldebestand: null }))).toBe(false)
  })

  it("sortiert die dringendsten zuerst (grösste Unterdeckung, dann Bestand)", () => {
    const u = nachschubUebersicht([
      zeile({ sku: "KNAPP", bestand: 5, meldebestand: 5 }),
      zeile({ sku: "LEER", bestand: 0, meldebestand: 10 }),
      zeile({ sku: "UNTER", bestand: 2, meldebestand: 8 }),
      zeile({ sku: "VOLL", bestand: 50, meldebestand: 5 }),
    ])
    expect(u.faellig.map((z) => z.sku)).toEqual(["LEER", "UNTER", "KNAPP"])
  })

  it("zählt überwachte und nicht überwachbare Varianten getrennt", () => {
    const u = nachschubUebersicht([
      zeile({ sku: "A", bestand: 3, meldebestand: 5 }), // überwacht, fällig
      zeile({ sku: "B", bestand: 9, meldebestand: 5 }), // überwacht, ok
      zeile({ sku: "C", bestand: null, meldebestand: 5 }), // kein Bestand
      zeile({ sku: "D", bestand: null, meldebestand: null }), // kein Bestand
      zeile({ sku: "E", bestand: 4, meldebestand: null }), // kein Meldebestand
    ])
    expect(u.gesamt).toBe(5)
    expect(u.ueberwacht).toBe(2)
    expect(u.faellig).toHaveLength(1)
    expect(u.ohneBestand).toBe(2)
    expect(u.ohneMeldebestand).toBe(1)
    expect(u.nichtUeberwachbar).toBe(3)
  })

  it("HEUTIGER STAND: alle 35 Varianten aus inventory.json sind nicht überwachbar", () => {
    // inventory.json führt quantity=null für alles — Bestandsführung ist
    // überall aus. Die Nachschubliste wäre leer, und genau deshalb müssen
    // Übersicht und Bericht die 35 nicht überwachbaren Varianten nennen:
    // die leere Liste ist Pflegeschuld, keine Entwarnung.
    const inventory = JSON.parse(
      readFileSync(join(DATA_DIR, "inventory.json"), "utf8")
    ) as { items: { sku: string; quantity: number | null }[] }

    expect(inventory.items).toHaveLength(35)

    const zeilen = inventory.items.map((i) =>
      zeile({ sku: i.sku, bestand: i.quantity, meldebestand: null })
    )
    const u = nachschubUebersicht(zeilen)

    expect(u.faellig).toHaveLength(0)
    expect(u.ueberwacht).toBe(0)
    expect(u.nichtUeberwachbar).toBe(35)
    expect(u.ohneBestand).toBe(35)
  })
})

// ─── Prüfung beim Einspielen ────────────────────────────────────

const lieferantOk = {
  name: "Grosshandel A",
  url: "https://a.example.ch/p/1",
  article_number: "A-100",
}

function katalogMit(variante: Record<string, unknown>): CatalogProduct[] {
  return [
    {
      product: "Testprodukt",
      ref: null,
      variants: [
        {
          label: "Einzeln",
          pack_type: "single",
          units_per_pack: 1,
          tiers: [{ min_quantity: 1, max_quantity: null, price: 2 }],
          ...variante,
        } as any,
      ],
    },
  ]
}

describe("validateLieferantenDaten", () => {
  it("akzeptiert gepflegte Daten und fehlende Felder", () => {
    expect(
      validateLieferantenDaten(
        katalogMit({ reorder_point: 10, suppliers: [lieferantOk] })
      )
    ).toEqual([])
    expect(validateLieferantenDaten(katalogMit({}))).toEqual([])
    expect(
      validateLieferantenDaten(
        katalogMit({ reorder_point: null, suppliers: null })
      )
    ).toEqual([])
  })

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["data:text/html,x"],
    ["/relativ"],
    ["www.ohne-schema.ch/produkt"],
  ])("lehnt die Lieferanten-URL «%s» ab", (url) => {
    const errors = validateLieferantenDaten(
      katalogMit({ suppliers: [{ name: "X", url }] })
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("http(s)")
  })

  it("lehnt kaputte Meldebestände und Einträge ohne Namen ab", () => {
    expect(
      validateLieferantenDaten(katalogMit({ reorder_point: -3 }))
    ).toHaveLength(1)
    expect(
      validateLieferantenDaten(katalogMit({ reorder_point: 2.5 }))
    ).toHaveLength(1)
    expect(
      validateLieferantenDaten(
        katalogMit({ suppliers: [{ url: "https://a.example.ch/p" }] })
      )
    ).toHaveLength(1)
    expect(
      validateLieferantenDaten(katalogMit({ suppliers: "kaputt" }))
    ).toHaveLength(1)
  })

  it("läuft über validateCatalogData mit — beide Import-Scripts prüfen so", () => {
    const errors = validateCatalogData(
      katalogMit({ suppliers: [{ name: "X", url: "javascript:alert(1)" }] })
    )
    expect(errors.some((e) => e.includes("http(s)"))).toBe(true)
  })
})

// ─── Metadaten-Abgleich (update-catalog.ts) ─────────────────────

describe("nachschubMetadataUpdate", () => {
  it("setzt Meldebestand und Lieferanten und lässt fremde Schlüssel stehen", () => {
    const res = nachschubMetadataUpdate(
      { units_per_pack: 1, pack_type: "single" },
      { reorder_point: 10, suppliers: [lieferantOk] }
    )
    expect(res).not.toBeNull()
    expect(res!.metadata).toEqual({
      units_per_pack: 1,
      pack_type: "single",
      reorder_point: 10,
      suppliers: [
        {
          name: "Grosshandel A",
          url: "https://a.example.ch/p/1",
          article_number: "A-100",
        },
      ],
    })
    expect(res!.changes.map((c) => c.field).sort()).toEqual([
      "lieferanten",
      "meldebestand",
    ])
  })

  it("ist idempotent: gleiche Werte -> nichts zu tun", () => {
    const erst = nachschubMetadataUpdate(null, {
      reorder_point: 10,
      suppliers: [lieferantOk],
    })
    expect(
      nachschubMetadataUpdate(erst!.metadata, {
        reorder_point: 10,
        suppliers: [lieferantOk],
      })
    ).toBeNull()
  })

  it("fehlende Katalogwerte löschen nie etwas", () => {
    const existing = {
      reorder_point: 10,
      suppliers: [{ name: "A", url: "https://a.example.ch/p", article_number: null }],
    }
    expect(nachschubMetadataUpdate(existing, {})).toBeNull()
    expect(
      nachschubMetadataUpdate(existing, { reorder_point: null, suppliers: null })
    ).toBeNull()
  })

  it("meldet nur das abweichende Feld", () => {
    const res = nachschubMetadataUpdate(
      {
        reorder_point: 5,
        suppliers: [{ name: "Grosshandel A", url: "https://a.example.ch/p/1", article_number: "A-100" }],
      },
      { reorder_point: 12, suppliers: [lieferantOk] }
    )
    expect(res!.changes.map((c) => c.field)).toEqual(["meldebestand"])
    expect(res!.metadata.reorder_point).toBe(12)
  })
})

// ─── planCatalogUpdate: Lieferantendaten je Variante ────────────

const testprodukt: CatalogProduct = katalogMit({
  reorder_point: 10,
  suppliers: [lieferantOk],
})[0]
const testHandle = slugify(testprodukt.product)
const testSku = skuFor(testprodukt.product, testprodukt.variants[0])

function existingTestprodukt(
  metadata: Record<string, unknown> | null = null
): ExistingProduct {
  return {
    id: "prod_1",
    handle: testHandle,
    title: testprodukt.product,
    subtitle: null,
    description: null,
    variants: [
      {
        id: "var_1",
        sku: testSku,
        metadata,
        manage_inventory: false,
        inventory_item_ids: [],
        prices: [
          {
            amount: 2,
            currency_code: "chf",
            min_quantity: 1,
            max_quantity: null,
            price_list_id: null,
          },
        ],
      },
    ],
  }
}

describe("planCatalogUpdate mit Nachschubdaten", () => {
  it("plant das Metadaten-Update für die Variante", () => {
    const plan = planCatalogUpdate({
      existing: [existingTestprodukt()],
      catalog: [testprodukt],
      content: [],
      inventory: [],
      step: 0.05,
    })
    expect(plan.products).toHaveLength(1)
    const [data] = plan.products[0].variantData
    expect(data.variant_id).toBe("var_1")
    expect(data.update.metadata).toEqual({
      reorder_point: 10,
      suppliers: [
        {
          name: "Grosshandel A",
          url: "https://a.example.ch/p/1",
          article_number: "A-100",
        },
      ],
    })
    expect(
      plan.products[0].changes.map((c) => c.field)
    ).toEqual([`${testSku} meldebestand`, `${testSku} lieferanten`])
  })

  it("zweiter Lauf: nichts zu tun", () => {
    const erst = planCatalogUpdate({
      existing: [existingTestprodukt()],
      catalog: [testprodukt],
      content: [],
      inventory: [],
      step: 0.05,
    })
    const geschrieben = erst.products[0].variantData[0].update.metadata!
    const zweit = planCatalogUpdate({
      existing: [existingTestprodukt(geschrieben)],
      catalog: [testprodukt],
      content: [],
      inventory: [],
      step: 0.05,
    })
    expect(zweit.products).toHaveLength(0)
  })
})

// ─── Einspielen bricht bei böser URL ab, bevor etwas passiert ───

describe("updateCatalog (exec) mit böser Lieferanten-URL", () => {
  const graphMock = jest.fn()
  const errorMock = jest.fn()
  const container = {
    resolve: (key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: errorMock }
      }
      if (key === "query") {
        return { graph: graphMock }
      }
      if (key === "link" || key === "remoteLink") {
        return { create: jest.fn() }
      }
      throw new Error(`unerwartetes resolve(${key})`)
    },
  } as any

  it("bricht ab: keine Datenbank-Abfrage, kein Workflow, klare Fehlermeldung", async () => {
    jest.clearAllMocks()
    const dir = mkdtempSync(join(tmpdir(), "nachschub-"))
    const catalogPath = join(dir, "catalog.json")
    writeFileSync(
      catalogPath,
      JSON.stringify(
        katalogMit({ suppliers: [{ name: "Böse", url: "JavaScript:alert(1)" }] })
      )
    )

    await updateCatalog({ container, args: [catalogPath] } as any)

    expect(graphMock).not.toHaveBeenCalled()
    expect(updateProductVariantsWorkflow).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
    expect(errorMock).toHaveBeenCalledWith(
      "Ungültige Katalogdaten — nichts wurde geändert:"
    )
    expect(
      errorMock.mock.calls.some(([msg]) => String(msg).includes("http(s)"))
    ).toBe(true)
  })
})
