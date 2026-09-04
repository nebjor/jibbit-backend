/**
 * Galaxus-Anbindung — CSV-Erzeugung, GTIN-Prüfung, Bereitschaft und
 * Export-Aufbau. Alles reine Funktionen, keine Datenbank nötig.
 */

import {
  buildGalaxusExport,
  csvCell,
  decimal,
  fehlendeFelder,
  isValidGtin,
  toCsv,
  VariantSnapshot,
} from "../scripts/galaxus-common"
import { validateCatalogData, CatalogProduct } from "../scripts/import-catalog"

// ─── GTIN ───────────────────────────────────────────────────────

describe("isValidGtin", () => {
  it("akzeptiert 8 bis 14 Ziffern", () => {
    expect(isValidGtin("12345678")).toBe(true) // GTIN-8
    expect(isValidGtin("4012345678901")).toBe(true) // EAN-13
    expect(isValidGtin("00012345678905")).toBe(true) // GTIN-14, führende Nullen
  })

  it("lehnt alles andere ab", () => {
    expect(isValidGtin("1234567")).toBe(false) // zu kurz
    expect(isValidGtin("123456789012345")).toBe(false) // zu lang
    expect(isValidGtin("40123A5678901")).toBe(false) // Buchstabe
    expect(isValidGtin("4012345 78901")).toBe(false) // Leerzeichen
    expect(isValidGtin("4012345.78901")).toBe(false) // Punkt
    expect(isValidGtin("")).toBe(false)
    expect(isValidGtin(null)).toBe(false)
    expect(isValidGtin(4012345678901)).toBe(false) // Zahl statt String
  })
})

// ─── CSV ────────────────────────────────────────────────────────

describe("csvCell / toCsv", () => {
  it("setzt Text in Anführungszeichen — auch mit Semikolon darin", () => {
    expect(csvCell("Papers; extra fein")).toBe('"Papers; extra fein"')
  })

  it("verdoppelt Anführungszeichen im Text (Handbuch 1.4.1)", () => {
    expect(csvCell('Aufschrift "Kings of E-Commerce"')).toBe(
      '"Aufschrift ""Kings of E-Commerce"""'
    )
  })

  it("normalisiert Zeilenumbrüche in Beschreibungen aufs Windows-Format", () => {
    expect(csvCell("Zeile 1\nZeile 2\r\nZeile 3")).toBe(
      '"Zeile 1\r\nZeile 2\r\nZeile 3"'
    )
  })

  it("schreibt Zahlen unquotiert mit Dezimalpunkt", () => {
    expect(csvCell(25.5)).toBe("25.5")
    expect(csvCell(decimal(1.4, 2))).toBe("1.40")
    expect(csvCell(decimal(0, 1))).toBe("0.0")
  })

  it("lässt leere Zellen leer", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
  })

  it("baut Kopfzeile und Zeilen mit Semikolon und CRLF", () => {
    const csv = toCsv(
      ["ProviderKey", "Gtin", "ProductTitle_de"],
      [{ ProviderKey: "SKU-1", Gtin: { raw: "12345678" }, ProductTitle_de: "Test" }]
    )
    expect(csv).toBe(
      'ProviderKey;Gtin;ProductTitle_de\r\n"SKU-1";12345678;"Test"\r\n'
    )
  })

  it("hält eine Beschreibung mit Umbruch in einer logischen Zeile", () => {
    const csv = toCsv(
      ["ProviderKey", "LongDescription_de"],
      [{ ProviderKey: "SKU-1", LongDescription_de: "Absatz 1.\n\nAbsatz 2." }]
    )
    // Der Umbruch bleibt INNERHALB der Anführungszeichen erhalten.
    expect(csv).toBe(
      'ProviderKey;LongDescription_de\r\n"SKU-1";"Absatz 1.\r\n\r\nAbsatz 2."\r\n'
    )
  })
})

// ─── Bereitschaft ───────────────────────────────────────────────

function vollstaendig(over: Partial<VariantSnapshot> = {}): VariantSnapshot {
  return {
    handle: "gizeh-dw-extra-fine",
    productTitle: "Gizeh DW Extra Fine",
    variantTitle: "Einzeln",
    status: "published",
    sku: "GIZ-DW-EXT-FIN-EA",
    ean: "4012345678901",
    weightG: 25,
    brand: "Gizeh",
    category: "Papers",
    subtitle: "Double Window, extra fein",
    description: "Blättchen von Gizeh im Double-Window-Format, extra fein.",
    imageUrls: ["https://api.jibbit.ch/static/gizeh-dw.jpg"],
    price: 1.7,
    stock: 12,
    unitsPerPack: 1,
    ...over,
  }
}

describe("fehlendeFelder", () => {
  it("meldet nichts, wenn alle Pflichtangaben da sind", () => {
    expect(fehlendeFelder(vollstaendig())).toEqual([])
  })

  it("meldet jede fehlende Pflichtangabe einzeln", () => {
    const fehlt = fehlendeFelder(
      vollstaendig({
        ean: null,
        weightG: null,
        brand: null,
        imageUrls: [],
        price: null,
        stock: null,
        description: null,
        category: null,
      })
    )
    expect(fehlt).toEqual([
      "ean",
      "marke",
      "kategorie",
      "beschreibung",
      "preis",
      "bestand",
      "gewicht",
      "bild",
    ])
  })

  it("unterscheidet fehlende von ungültiger EAN", () => {
    expect(fehlendeFelder(vollstaendig({ ean: "123" }))).toEqual([
      "ean ungültig («123»)",
    ])
  })

  it("Bestand 0 ist ein gültiger Bestand, null nicht", () => {
    expect(fehlendeFelder(vollstaendig({ stock: 0 }))).toEqual([])
    expect(fehlendeFelder(vollstaendig({ stock: null }))).toEqual(["bestand"])
  })

  it("unveröffentlichte Produkte fallen auf", () => {
    expect(fehlendeFelder(vollstaendig({ status: "draft" }))).toEqual([
      "nicht veröffentlicht",
    ])
  })
})

// ─── Export ─────────────────────────────────────────────────────

describe("buildGalaxusExport", () => {
  it("exportiert eine vollständige Variante in alle vier Dateien", () => {
    const result = buildGalaxusExport([vollstaendig()])
    expect(result.exportiert).toBe(1)
    expect(result.ausgeschlossen).toEqual([])

    expect(result.productData.split("\r\n")[0]).toBe(
      "ProviderKey;Gtin;BrandName;ProductCategory;WeightG;ProductSuperType;" +
        "ProductTitle_de;ShortDescription_de;LongDescription_de;MainImageURL"
    )
    expect(result.productData).toContain(
      '"GIZ-DW-EXT-FIN-EA";4012345678901;"Gizeh";"Papers";25;' +
        '"gizeh-dw-extra-fine";"Gizeh DW Extra Fine";'
    )

    expect(result.priceData.split("\r\n")[0]).toBe(
      "ProviderKey;VatRatePercentage;SalesPriceExcludingVat;" +
        "SalesPriceIncludingVat;Currency"
    )
    // Nicht MwSt-pflichtig: Endpreis in beiden Spalten, Satz 0.0.
    expect(result.priceData).toContain('"GIZ-DW-EXT-FIN-EA";0.0;1.70;1.70;"CHF"')

    expect(result.stockData.split("\r\n")[0]).toBe(
      "ProviderKey;QuantityOnStock;MinimumOrderQuantity_dd;" +
        "RetailUnitQuantity;ShipmentType"
    )
    // 25 g ≤ 1000 g → Brief (ShipmentType 1).
    expect(result.stockData).toContain('"GIZ-DW-EXT-FIN-EA";12;1;1;1')

    expect(result.specificationData.split("\r\n")[0]).toBe(
      "ProductKey;SpecificationKey;SpecificationGroup_DE;SpecificationGroup_FR;" +
        "SpecificationGroup_EN;SpecificationGroup_IT;SpecificationKey_DE;" +
        "SpecificationKey_FR;SpecificationKey_EN;SpecificationKey_IT;" +
        "SpecificationValue_DE;SpecificationValue_FR;SpecificationValue_EN;" +
        "SpecificationValue_IT"
    )
    expect(result.specificationData).toContain(
      '"GIZ-DW-EXT-FIN-EA";"verpackungseinheit";;;;;"Verpackungseinheit";;;;' +
        '"Einzeln";;;'
    )
  })

  it("lässt Varianten ohne GTIN nicht stillschweigend weg, sondern meldet sie", () => {
    const result = buildGalaxusExport([
      vollstaendig(),
      vollstaendig({ sku: "OHNE-EAN-EA", ean: null }),
    ])
    expect(result.exportiert).toBe(1)
    expect(result.ausgeschlossen).toEqual([
      {
        sku: "OHNE-EAN-EA",
        produkt: "Gizeh DW Extra Fine",
        variante: "Einzeln",
        fehlt: ["ean"],
      },
    ])
    expect(result.productData).not.toContain("OHNE-EAN-EA")
  })

  it("mit-luecken nimmt unvollständige Varianten mit leeren Zellen auf", () => {
    const result = buildGalaxusExport(
      [vollstaendig({ ean: null, weightG: null })],
      { mitLuecken: true }
    )
    expect(result.exportiert).toBe(1)
    expect(result.productData).toContain('"GIZ-DW-EXT-FIN-EA";;')
  })

  it("Varianten ohne SKU bleiben auch mit mit-luecken draussen", () => {
    const result = buildGalaxusExport([vollstaendig({ sku: null })], {
      mitLuecken: true,
    })
    expect(result.exportiert).toBe(0)
    expect(result.ausgeschlossen).toHaveLength(1)
  })

  it("über 1000 g wird aus dem Brief ein Paket", () => {
    const schwer = vollstaendig({ sku: "BOX-EA", weightG: 1250 })
    const result = buildGalaxusExport([schwer])
    expect(result.stockData).toContain('"BOX-EA";12;1;1;2')
  })

  it("Display-Varianten führen die Anzahl Einzelpackungen als Eigenschaft", () => {
    const display = vollstaendig({
      sku: "DIS-D34",
      ean: "76123456",
      variantTitle: "Display (34 Stk.)",
      unitsPerPack: 34,
    })
    const result = buildGalaxusExport([display])
    expect(result.specificationData).toContain(
      '"DIS-D34";"anzahl_einzelpackungen";;;;;"Anzahl Einzelpackungen";;;;"34";;;'
    )
    // RetailUnitQuantity in den Bestandesdaten trägt dieselbe Zahl.
    expect(result.stockData).toContain('"DIS-D34";12;1;34;')
  })

  it("nummeriert zusätzliche Bilder als ImageURL_1..n durch", () => {
    const result = buildGalaxusExport([
      vollstaendig({
        imageUrls: [
          "https://api.jibbit.ch/static/haupt.jpg",
          "https://api.jibbit.ch/static/detail-1.jpg",
          "https://api.jibbit.ch/static/detail-2.jpg",
        ],
      }),
    ])
    expect(result.productData.split("\r\n")[0]).toContain(
      "MainImageURL;ImageURL_1;ImageURL_2"
    )
    expect(result.productData).toContain(
      '"https://api.jibbit.ch/static/haupt.jpg";' +
        '"https://api.jibbit.ch/static/detail-1.jpg";' +
        '"https://api.jibbit.ch/static/detail-2.jpg"'
    )
  })

  it("sortiert alle Dateien nach ProviderKey", () => {
    const result = buildGalaxusExport([
      vollstaendig({ sku: "ZZZ-EA", ean: "12345678" }),
      vollstaendig({ sku: "AAA-EA", ean: "87654321" }),
    ])
    for (const file of [
      result.productData,
      result.priceData,
      result.stockData,
      result.specificationData,
    ]) {
      expect(file.indexOf("AAA-EA")).toBeLessThan(file.indexOf("ZZZ-EA"))
    }
  })
})

// ─── Katalog-Validierung (import-catalog/update-catalog) ────────

describe("validateCatalogData", () => {
  const produkt = (variant: Partial<CatalogProduct["variants"][0]>): CatalogProduct => ({
    product: "Gizeh DW Extra Fine",
    ref: null,
    variants: [
      {
        label: "Einzeln",
        pack_type: "single",
        units_per_pack: 1,
        tiers: [{ min_quantity: 1, max_quantity: null, price: 1.7 }],
        ...variant,
      },
    ],
  })

  it("lässt Varianten ohne die neuen Felder unbeanstandet", () => {
    expect(validateCatalogData([produkt({})])).toEqual([])
  })

  it("akzeptiert gültige EAN und Gewicht", () => {
    expect(
      validateCatalogData([produkt({ ean: "4012345678901", weight_g: 25 })])
    ).toEqual([])
  })

  it("meldet ungültige EANs mit Fundstelle", () => {
    const errors = validateCatalogData([produkt({ ean: "40123" })])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Gizeh DW Extra Fine (Einzeln)")
    expect(errors[0]).toContain("40123")
  })

  it("meldet doppelt vergebene EANs", () => {
    const a = produkt({ ean: "4012345678901" })
    const b = {
      ...produkt({ ean: "4012345678901" }),
      product: "Anderes Produkt",
    }
    const errors = validateCatalogData([a, b])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("bereits vergeben")
  })

  it("meldet Gewichte, die nicht über 0 liegen", () => {
    expect(validateCatalogData([produkt({ weight_g: 0 })])).toHaveLength(1)
    expect(validateCatalogData([produkt({ weight_g: -5 })])).toHaveLength(1)
  })
})
