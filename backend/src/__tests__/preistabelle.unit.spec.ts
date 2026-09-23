import {
  basisPreis,
  leseStufenExtras,
  listenpreisIdsOhneMengen,
  metadataMitExtras,
  pruefeBilder,
  pruefePreistabelle,
  staffelAenderungen,
  staffelPreise,
  stufenExtras,
  tabelleAusPreisen,
  zuBehaltendePreise,
} from "../lib/preistabelle"

const staffel = [
  { min_quantity: 24, amount: 1.4 },
  { min_quantity: 1, amount: 1.95 },
  { min_quantity: 10, amount: 1.85 },
]

describe("pruefePreistabelle", () => {
  it("akzeptiert eine saubere Staffel mit regulärem Preis", () => {
    expect(pruefePreistabelle({ regulaerer_preis: 2.5, zeilen: staffel })).toEqual([])
  })

  it("verlangt eine Zeile ab 1", () => {
    expect(pruefePreistabelle({ zeilen: [{ min_quantity: 10, amount: 1 }] }).join(" ")).toMatch(
      /ab 1 Stück/
    )
  })

  it("lehnt doppelte Mengen, Nullpreise, Bruchmengen und Zehntelrappen ab", () => {
    const f = pruefePreistabelle({
      zeilen: [
        { min_quantity: 1, amount: 2 },
        { min_quantity: 1, amount: 1.5 },
        { min_quantity: 2.5, amount: 1 },
        { min_quantity: 5, amount: 0 },
        { min_quantity: 6, amount: 1.234 },
      ],
    }).join(" ")
    expect(f).toMatch(/doppelt/)
    expect(f).toMatch(/keine gültige Menge/)
    expect(f).toMatch(/grösser als 0/)
    expect(f).toMatch(/zwei Nachkommastellen/)
  })

  it("lehnt steigende Stückpreise und zu lange Bezeichnungen ab", () => {
    expect(
      pruefePreistabelle({
        zeilen: [
          { min_quantity: 1, amount: 1 },
          { min_quantity: 10, amount: 1.1 },
        ],
      }).join(" ")
    ).toMatch(/nicht teurer/)
    expect(
      pruefePreistabelle({ zeilen: [{ min_quantity: 1, amount: 1, label: "x".repeat(31) }] }).join(
        " "
      )
    ).toMatch(/länger als 30/)
  })

  it("regulärer Preis darf nicht unter dem Preis ab 1 liegen", () => {
    expect(pruefePreistabelle({ regulaerer_preis: 1.9, zeilen: staffel }).join(" ")).toMatch(
      /nicht tiefer/
    )
    expect(pruefePreistabelle({ regulaerer_preis: 1.95, zeilen: staffel })).toEqual([])
  })

  it("akzeptiert Preise wie 1.15 trotz Binärarithmetik", () => {
    expect(
      pruefePreistabelle({
        regulaerer_preis: 1.15,
        zeilen: [
          { min_quantity: 1, amount: 1.15 },
          { min_quantity: 3, amount: 0.29 },
        ],
      })
    ).toEqual([])
  })
})

describe("basisPreis / staffelPreise", () => {
  it("regulärer Preis wird Basispreis, die Staffel lückenlos in die Liste", () => {
    const t = { regulaerer_preis: 2.5, zeilen: staffel }
    expect(basisPreis(t)).toEqual({
      amount: 2.5,
      currency_code: "chf",
      min_quantity: null,
      max_quantity: null,
    })
    expect(staffelPreise(t)).toEqual([
      { amount: 1.95, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
      { amount: 1.85, currency_code: "chf", min_quantity: 10, max_quantity: 23 },
      { amount: 1.4, currency_code: "chf", min_quantity: 24, max_quantity: null },
    ])
  })

  it("ohne regulären Preis ist der Preis ab 1 der Basispreis", () => {
    expect(basisPreis({ zeilen: staffel }).amount).toBe(1.95)
  })

  it("ein einziger Preis ohne regulären Preis braucht keine Preisliste", () => {
    expect(staffelPreise({ zeilen: [{ min_quantity: 1, amount: 27 }] })).toEqual([])
    expect(
      staffelPreise({ regulaerer_preis: 29, zeilen: [{ min_quantity: 1, amount: 27 }] })
    ).toEqual([{ amount: 27, currency_code: "chf", min_quantity: 1, max_quantity: null }])
  })
})

describe("tabelleAusPreisen", () => {
  const liste = (amount: number, min: number, max: number | null) => ({
    amount,
    currency_code: "chf",
    min_quantity: min,
    max_quantity: max,
    price_list_id: "plist_1",
  })

  it("Rundreise: gespeicherte Preise ergeben wieder die Tabelle", () => {
    const t = { regulaerer_preis: 2.5, zeilen: staffel }
    const basis = [basisPreis(t), { amount: 2.1, currency_code: "eur", min_quantity: null }]
    const listen = staffelPreise(t).map((p) => ({ ...p, price_list_id: "plist_1" }))
    expect(tabelleAusPreisen(basis, listen)).toEqual({
      regulaerer_preis: 2.5,
      zeilen: [
        { min_quantity: 1, amount: 1.95 },
        { min_quantity: 10, amount: 1.85 },
        { min_quantity: 24, amount: 1.4 },
      ],
      hinweise: [],
    })
  })

  it("nur ein Basispreis: eine Zeile ab 1, kein regulärer Preis", () => {
    expect(tabelleAusPreisen([{ amount: 27, currency_code: "CHF" }], [])).toEqual({
      regulaerer_preis: null,
      zeilen: [{ min_quantity: 1, amount: 27 }],
      hinweise: [],
    })
  })

  it("Altbestand mit Staffeln im Basispreis wird gelesen und gemeldet", () => {
    const basis = [
      { amount: 1.95, currency_code: "chf", min_quantity: 1, max_quantity: 9 },
      { amount: 1.85, currency_code: "chf", min_quantity: 10, max_quantity: null },
    ]
    expect(tabelleAusPreisen(basis, []).zeilen).toHaveLength(2)
    expect(tabelleAusPreisen(basis, [liste(1.9, 1, null)]).hinweise.join(" ")).toMatch(
      /alte Staffeln/
    )
  })

  it("meldet Lücken und fehlenden Preis ab 1", () => {
    const { hinweise } = tabelleAusPreisen([], [liste(2, 2, 5), liste(1, 10, null)])
    expect(hinweise.join(" ")).toMatch(/ab 1 Stück/)
    expect(hinweise.join(" ")).toMatch(/lückenlos/)
  })
})

describe("zuBehaltendePreise", () => {
  it("behält andere Währungen und Regelpreise, nie die Tabelle oder Preislisten", () => {
    const basis = [
      { id: "p1", amount: 2.5, currency_code: "chf" },
      { id: "p2", amount: 2.1, currency_code: "eur" },
      { id: "p3", amount: 1.9, currency_code: "chf", rules_count: 1 },
      { id: "p4", amount: 1.5, currency_code: "chf", price_list_id: "plist_1" },
    ]
    expect(zuBehaltendePreise(basis).map((p) => p.id)).toEqual(["p2", "p3"])
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
    const alt = { brand: "RAW", preistabelle: { stufen: [{ min_quantity: 5 }] } }
    expect(metadataMitExtras(alt, [])).toEqual({ brand: "RAW" })
    expect(leseStufenExtras(metadataMitExtras(alt, stufenExtras(zeilen)))).toEqual(
      stufenExtras(zeilen)
    )
  })

  it("liest kaputte Metadata defensiv", () => {
    expect(leseStufenExtras({ preistabelle: "x" })).toEqual([])
    expect(
      leseStufenExtras({
        preistabelle: { stufen: [null, { min_quantity: "a" }, { min_quantity: 3, image_id: 5 }] },
      })
    ).toEqual([{ min_quantity: 3 }])
  })

  it("lehnt Bilder ab, die nicht am Produkt hängen", () => {
    expect(pruefeBilder(zeilen, ["img_other"]).join(" ")).toMatch(/Ab 24 Stk/)
    expect(pruefeBilder(zeilen, ["img_box"])).toEqual([])
  })
})

describe("staffelAenderungen", () => {
  it("aktualisiert gleiche «ab»-Mengen, legt neue an, löscht übrige", () => {
    const soll = staffelPreise({ regulaerer_preis: 2.5, zeilen: staffel })
    const ist = [
      { id: "p1", amount: 1.9, currency_code: "chf", min_quantity: 1, max_quantity: 23 },
      { id: "p24", amount: 1.4, currency_code: "chf", min_quantity: 24, max_quantity: 49 },
      { id: "p50", amount: 1.3, currency_code: "chf", min_quantity: 50, max_quantity: null },
    ]
    const a = staffelAenderungen(soll, ist, "v1")
    expect(a.update.map((u) => [u.id, u.amount, u.max_quantity])).toEqual([
      ["p1", 1.95, 9],
      ["p24", 1.4, null],
    ])
    expect(a.create.map((c) => [c.min_quantity, c.variant_id])).toEqual([[10, "v1"]])
    expect(a.delete).toEqual(["p50"])
  })

  it("zweimal dieselbe Tabelle ändert nur, legt nichts an und löscht nichts", () => {
    const soll = staffelPreise({ zeilen: staffel })
    const ist = soll.map((p, i) => ({ ...p, id: `p${i}` }))
    const a = staffelAenderungen(soll, ist, "v1")
    expect([a.create.length, a.update.length, a.delete.length]).toEqual([0, 3, 0])
  })
})

describe("listenpreisIdsOhneMengen", () => {
  it("findet Updates ohne Mengen und Löschungen aus dem Standard-Preisraster", () => {
    expect(
      listenpreisIdsOhneMengen({
        create: [{ variant_id: "v", amount: 1, currency_code: "chf" }],
        update: [{ id: "p1", variant_id: "v", amount: 2, currency_code: "chf" }],
        delete: ["p2"],
      })
    ).toEqual(["p1", "p2"])
  })

  it("lässt Updates mit Mengen durch", () => {
    expect(
      listenpreisIdsOhneMengen({ update: [{ id: "p1", amount: 2, min_quantity: 10 }], delete: [] })
    ).toEqual([])
    expect(listenpreisIdsOhneMengen(null)).toEqual([])
  })
})
