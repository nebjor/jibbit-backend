import {
  hatStaffel,
  leseStufenExtras,
  metadataMitExtras,
  pruefeBilder,
  stufenExtras,
  preiseAusTabelle,
  pruefePreistabelle,
  tabelleAusPreisen,
  variantenMitRasterPreisen,
  zuBehaltendePreise,
} from "../lib/preistabelle"

describe("pruefePreistabelle", () => {
  it("akzeptiert eine saubere Staffel", () => {
    expect(
      pruefePreistabelle([
        { min_quantity: 10, amount: 1.85 },
        { min_quantity: 1, amount: 1.95 },
        { min_quantity: 24, amount: 1.4 },
      ])
    ).toEqual([])
  })

  it("verlangt eine Zeile ab 1", () => {
    expect(pruefePreistabelle([{ min_quantity: 10, amount: 1 }]).join(" ")).toMatch(/ab 1 Stück/)
  })

  it("lehnt doppelte Mengen, Nullpreise, Bruchmengen und Zehntelrappen ab", () => {
    const f = pruefePreistabelle([
      { min_quantity: 1, amount: 2 },
      { min_quantity: 1, amount: 1.5 },
      { min_quantity: 2.5, amount: 1 },
      { min_quantity: 5, amount: 0 },
      { min_quantity: 6, amount: 1.234 },
    ]).join(" ")
    expect(f).toMatch(/doppelt/)
    expect(f).toMatch(/keine gültige Menge/)
    expect(f).toMatch(/grösser als 0/)
    expect(f).toMatch(/zwei Nachkommastellen/)
  })

  it("lehnt steigende Stückpreise ab", () => {
    expect(
      pruefePreistabelle([
        { min_quantity: 1, amount: 1 },
        { min_quantity: 10, amount: 1.1 },
      ]).join(" ")
    ).toMatch(/nicht teurer/)
  })

  it("akzeptiert Preise wie 1.15 trotz Binärarithmetik", () => {
    expect(
      pruefePreistabelle([
        { min_quantity: 1, amount: 1.15 },
        { min_quantity: 3, amount: 0.29 },
      ])
    ).toEqual([])
  })
})

describe("preiseAusTabelle", () => {
  it("baut lückenlose Staffeln, oberste offen", () => {
    expect(
      preiseAusTabelle([
        { min_quantity: 24, amount: 1.4 },
        { min_quantity: 1, amount: 1.95 },
        { min_quantity: 10, amount: 1.85 },
      ])
    ).toEqual([
      { amount: 1.95, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
      { amount: 1.85, currency_code: "chf", min_quantity: 10, max_quantity: 23 },
      { amount: 1.4, currency_code: "chf", min_quantity: 24, max_quantity: null },
    ])
  })

  it("eine Zeile wird ein normaler Preis ohne Mengen", () => {
    expect(preiseAusTabelle([{ min_quantity: 1, amount: 27 }])).toEqual([
      { amount: 27, currency_code: "chf", min_quantity: null, max_quantity: null },
    ])
  })
})

describe("tabelleAusPreisen", () => {
  it("liest nur CHF-Basispreise ohne Regeln, sortiert", () => {
    const { zeilen, hinweise } = tabelleAusPreisen([
      { amount: "1.4", currency_code: "chf", min_quantity: 24, max_quantity: null },
      { amount: 1.95, currency_code: "chf", min_quantity: 1, max_quantity: 23 },
      { amount: 1.2, currency_code: "chf", min_quantity: 1, price_list_id: "plist_1" },
      { amount: 2, currency_code: "eur", min_quantity: null },
    ])
    expect(zeilen).toEqual([
      { min_quantity: 1, amount: 1.95 },
      { min_quantity: 24, amount: 1.4 },
    ])
    expect(hinweise).toEqual([])
  })

  it("normaler Preis ohne Mengen = Zeile ab 1", () => {
    expect(
      tabelleAusPreisen([{ amount: 27, currency_code: "CHF", min_quantity: null }]).zeilen
    ).toEqual([{ min_quantity: 1, amount: 27 }])
  })

  it("meldet Lücken und fehlenden Preis ab 1", () => {
    const { hinweise } = tabelleAusPreisen([
      { amount: 2, currency_code: "chf", min_quantity: 2, max_quantity: 5 },
      { amount: 1, currency_code: "chf", min_quantity: 10, max_quantity: null },
    ])
    expect(hinweise.join(" ")).toMatch(/ab 1 Stück/)
    expect(hinweise.join(" ")).toMatch(/lückenlos/)
  })

  it("Rundreise Tabelle → Preise → Tabelle ist stabil", () => {
    const tabelle = [
      { min_quantity: 1, amount: 1.6 },
      { min_quantity: 10, amount: 1.5 },
      { min_quantity: 34, amount: 1.15 },
    ]
    expect(tabelleAusPreisen(preiseAusTabelle(tabelle))).toEqual({ zeilen: tabelle, hinweise: [] })
  })
})

describe("zuBehaltendePreise / hatStaffel", () => {
  const prices = [
    { id: "p1", amount: 1.95, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
    { id: "p2", amount: 1.85, currency_code: "chf", min_quantity: 10, max_quantity: null },
    { id: "p3", amount: 2.1, currency_code: "eur", min_quantity: null, max_quantity: null },
    { id: "p4", amount: 1.9, currency_code: "chf", rules_count: 1 },
    { id: "p5", amount: 1.5, currency_code: "chf", price_list_id: "plist_1" },
  ]

  it("behält andere Währungen und Regelpreise, nie Preislisten-Preise", () => {
    expect(zuBehaltendePreise(prices).map((p) => p.id)).toEqual(["p3", "p4"])
  })

  it("erkennt eine Staffel erst ab zwei Tabellenzeilen", () => {
    expect(hatStaffel(prices)).toBe(true)
    expect(hatStaffel([prices[0], prices[2], prices[4]])).toBe(false)
  })
})

describe("variantenMitRasterPreisen", () => {
  it("findet den Batch-Request des Standard-Preisrasters", () => {
    expect(
      variantenMitRasterPreisen({
        update: [{ id: "variant_1", prices: [{ id: "p1", currency_code: "chf", amount: 2 }] }],
      })
    ).toEqual(["variant_1"])
  })

  it("lässt Requests mit Mengen durch (Import/API)", () => {
    expect(
      variantenMitRasterPreisen({
        update: [
          { id: "variant_1", prices: [{ currency_code: "chf", amount: 2, min_quantity: 1 }] },
        ],
      })
    ).toEqual([])
  })

  it("Einzelvarianten-Request liefert leere id (steht im Pfad)", () => {
    expect(variantenMitRasterPreisen({ prices: [{ currency_code: "chf", amount: 2 }] })).toEqual([
      "",
    ])
  })

  it("ignoriert Requests ohne Preise", () => {
    expect(variantenMitRasterPreisen({ title: "x", update: [{ id: "v", title: "y" }] })).toEqual(
      []
    )
  })
})

describe("Bild und Bezeichnung je Zeile", () => {
  const zeilen = [
    { min_quantity: 24, amount: 1.4, image_id: "img_box", label: " 24er Display " },
    { min_quantity: 1, amount: 1.95, image_id: null, label: "" },
    { min_quantity: 10, amount: 1.85, label: "Zehnerpack" },
  ]

  it("speichert nur Zeilen mit Extras, sortiert und getrimmt", () => {
    expect(stufenExtras(zeilen)).toEqual([
      { min_quantity: 10, label: "Zehnerpack" },
      { min_quantity: 24, image_id: "img_box", label: "24er Display" },
    ])
  })

  it("lässt andere Metadata-Schlüssel stehen und räumt leere Extras weg", () => {
    const alt = { brand: "RAW", suppliers: [{ name: "X" }], preistabelle: { stufen: [{ min_quantity: 5 }] } }
    expect(metadataMitExtras(alt, [])).toEqual({ brand: "RAW", suppliers: [{ name: "X" }] })
    expect(metadataMitExtras(alt, stufenExtras(zeilen)).brand).toBe("RAW")
    expect(leseStufenExtras(metadataMitExtras(alt, stufenExtras(zeilen)))).toEqual(stufenExtras(zeilen))
  })

  it("liest kaputte Metadata defensiv", () => {
    expect(leseStufenExtras({ preistabelle: "x" })).toEqual([])
    expect(leseStufenExtras({ preistabelle: { stufen: [null, { min_quantity: "a" }, { min_quantity: 3, image_id: 5 }] } })).toEqual([
      { min_quantity: 3 },
    ])
  })

  it("lehnt fremde Bilder und zu lange Bezeichnungen ab", () => {
    expect(pruefeBilder(zeilen, ["img_other"]).join(" ")).toMatch(/Ab 24 Stk/)
    expect(pruefeBilder(zeilen, ["img_box"])).toEqual([])
    expect(
      pruefePreistabelle([{ min_quantity: 1, amount: 1, label: "x".repeat(31) }]).join(" ")
    ).toMatch(/länger als 30/)
  })
})
