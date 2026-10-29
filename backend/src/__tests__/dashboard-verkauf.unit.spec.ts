/**
 * Verkaufs-Dashboard: Definition «bezahlt», Monatsreihe (auch über den
 * Jahreswechsel), Vorzeitraum, leerer Zeitraum, Top-Listen und die GET-Route
 * (mit gefälschtem Container, ohne Datenbank).
 */
import { GET } from "../api/admin/dashboard/verkauf/route"
import {
  bestimmeZeitraum,
  istBezahlt,
  monatsReihe,
  parseGrenze,
  RohBestellung,
  topBestellungen,
  topProdukte,
  veraenderung,
  werteAus,
  zuerichMitternacht,
} from "../lib/dashboard-verkauf"

function bestellung(p: Partial<RohBestellung> & { id: string; created_at: string }): RohBestellung {
  return {
    status: "pending",
    total: 50,
    shipping_total: 4.5,
    items: [{ quantity: 1, title: "Tee", product_id: "p1", total: 45.5 }],
    payment_collections: [
      { status: "completed", payments: [{ captures: [{ amount: 50 }], refunds: [] }] },
    ],
    ...p,
  }
}

describe("istBezahlt", () => {
  it("zählt erfasste Zahlungen", () => {
    expect(istBezahlt(bestellung({ id: "a", created_at: "2026-10-01T10:00:00Z" }))).toBe(true)
  })
  it("zählt Status completed ohne Capture-Zeilen", () => {
    const b = bestellung({
      id: "a",
      created_at: "2026-10-01T10:00:00Z",
      payment_collections: [{ status: "completed", payments: [] }],
    })
    expect(istBezahlt(b)).toBe(true)
  })
  it("zählt nicht: nur autorisiert / unbezahlt", () => {
    const b = bestellung({
      id: "a",
      created_at: "2026-10-01T10:00:00Z",
      payment_collections: [{ status: "authorized", payments: [{ captures: [] }] }],
    })
    expect(istBezahlt(b)).toBe(false)
    expect(istBezahlt(bestellung({ id: "b", created_at: "2026-10-01T10:00:00Z", payment_collections: [] }))).toBe(false)
  })
  it("zählt nicht: storniert, auch wenn bezahlt", () => {
    expect(istBezahlt(bestellung({ id: "a", created_at: "2026-10-01T10:00:00Z", status: "canceled" }))).toBe(false)
  })
  it("liest BigNumber-Objekte", () => {
    const b = bestellung({
      id: "a",
      created_at: "2026-10-01T10:00:00Z",
      payment_collections: [{ payments: [{ captures: [{ amount: { value: "12.5" } }] }] }],
    })
    expect(istBezahlt(b)).toBe(true)
  })
})

describe("Zeitraum", () => {
  const jetzt = Date.parse("2026-10-29T12:00:00Z")

  it("Standard: 30 Tage bis jetzt, Vorzeitraum gleich lang", () => {
    const z = bestimmeZeitraum(undefined, undefined, jetzt)
    if ("fehler" in z) throw new Error(z.fehler)
    expect(z.bis).toBe(jetzt)
    expect(z.bis - z.von).toBe(30 * 86_400_000)
    expect(z.vorher.bis).toBe(z.von)
    expect(z.vorher.bis - z.vorher.von).toBe(z.bis - z.von)
  })

  it("reines Datum = Zürcher Tag, bis inklusive", () => {
    const z = bestimmeZeitraum("2026-01-01", "2026-01-31", jetzt)
    if ("fehler" in z) throw new Error(z.fehler)
    expect(new Date(z.von).toISOString()).toBe("2025-12-31T23:00:00.000Z")
    expect(new Date(z.bis).toISOString()).toBe("2026-01-31T23:00:00.000Z")
  })

  it("Sommerzeit: Mitternacht ist UTC+2", () => {
    expect(new Date(zuerichMitternacht(2026, 7, 1)).toISOString()).toBe("2026-06-30T22:00:00.000Z")
  })

  it("weist Unsinn ab", () => {
    expect(parseGrenze("2026-02-30", false)).toBeNull()
    expect("fehler" in bestimmeZeitraum("2026-05-02", "2026-05-01", jetzt)).toBe(true)
    expect("fehler" in bestimmeZeitraum("xx", undefined, jetzt)).toBe(true)
  })
})

describe("monatsReihe", () => {
  it("füllt leere Monate und läuft über den Jahreswechsel", () => {
    const z = bestimmeZeitraum("2025-11-15", "2026-02-10")
    if ("fehler" in z) throw new Error(z.fehler)
    const reihe = monatsReihe(
      [
        bestellung({ id: "a", created_at: "2025-11-20T10:00:00Z", total: 40 }),
        bestellung({ id: "b", created_at: "2026-02-01T10:00:00Z", total: 60 }),
        bestellung({ id: "c", created_at: "2026-02-02T10:00:00Z", total: 10 }),
      ],
      z
    )
    expect(reihe).toEqual([
      { monat: "2025-11", bestellungen: 1, umsatz: 40 },
      { monat: "2025-12", bestellungen: 0, umsatz: 0 },
      { monat: "2026-01", bestellungen: 0, umsatz: 0 },
      { monat: "2026-02", bestellungen: 2, umsatz: 70 },
    ])
  })

  it("ordnet nach Zürcher Zeit zu (Silvester 23:30 UTC = Neujahr in Zürich)", () => {
    const z = bestimmeZeitraum("2025-12-01", "2026-01-31")
    if ("fehler" in z) throw new Error(z.fehler)
    const reihe = monatsReihe([bestellung({ id: "a", created_at: "2025-12-31T23:30:00Z" })], z)
    expect(reihe.map((m) => m.bestellungen)).toEqual([0, 1])
  })
})

describe("werteAus", () => {
  const z = bestimmeZeitraum("2026-10-01", "2026-10-31")
  if ("fehler" in z) throw new Error(z.fehler)

  const daten: RohBestellung[] = [
    // Zeitraum, bezahlt, mit Versand
    bestellung({
      id: "o1",
      display_id: 11,
      created_at: "2026-10-05T10:00:00Z",
      total: 54.5,
      shipping_total: 4.5,
      customer: { first_name: "Anna", last_name: "Muster" },
      items: [
        { quantity: 2, title: "Tee", product_id: "p1", total: 30 },
        { quantity: 1, title: "Kaffee", product_id: "p2", total: 20 },
      ],
      payment_collections: [
        { status: "completed", payments: [{ captures: [{ amount: 54.5 }], refunds: [{ amount: 10 }] }] },
      ],
    }),
    // Zeitraum, bezahlt, gratis Versand
    bestellung({
      id: "o2",
      display_id: 12,
      created_at: "2026-10-20T10:00:00Z",
      total: 100,
      shipping_total: 0,
      email: "gast@example.ch",
      items: [{ quantity: 5, title: "Tee", product_id: "p1", total: 100 }],
    }),
    // unbezahlt und storniert: zählen nicht
    bestellung({ id: "o3", created_at: "2026-10-10T10:00:00Z", payment_collections: [] }),
    bestellung({ id: "o4", created_at: "2026-10-11T10:00:00Z", status: "canceled" }),
    // Vorzeitraum (September, gleiche Länge reicht von 31.8. bis 1.10.)
    bestellung({ id: "o5", created_at: "2026-09-15T10:00:00Z", total: 77.2 }),
  ]

  it("berechnet Kennzahlen und Vorperiode", () => {
    const a = werteAus(daten, z)
    expect(a.aktuell.bestellungen).toBe(2)
    expect(a.aktuell.umsatz_brutto).toBe(154.5)
    expect(a.aktuell.rueckerstattungen).toBe(10)
    expect(a.aktuell.umsatz_netto).toBe(144.5)
    expect(a.aktuell.durchschnitt_auftrag).toBe(77.25)
    expect(a.aktuell.stueck_gesamt).toBe(8)
    expect(a.aktuell.durchschnitt_stueck).toBe(4)
    expect(a.aktuell.versand).toBe(4.5)
    expect(a.aktuell.warenwert).toBe(150)
    expect(a.aktuell.gratis_versand_anzahl).toBe(1)
    expect(a.aktuell.gratis_versand_anteil).toBe(0.5)
    expect(a.vorher.bestellungen).toBe(1)
    expect(a.vorher.umsatz_brutto).toBe(77.2)
    expect(a.aenderung.bestellungen).toBe(100)
    expect(a.aenderung.umsatz).toBe(100.1)
    expect(a.geladen).toBe(5)
    expect(a.abgeschnitten).toBe(false)
  })

  it("bildet Top-Bestellungen und Top-Produkte", () => {
    const a = werteAus(daten, z)
    expect(a.top_bestellungen.map((t) => [t.id, t.kunde])).toEqual([
      ["o2", "gast@example.ch"],
      ["o1", "Anna Muster"],
    ])
    expect(a.top_produkte_umsatz[0]).toMatchObject({ schluessel: "p1", menge: 7, umsatz: 130 })
    expect(a.top_produkte_menge.map((p) => p.schluessel)).toEqual(["p1", "p2"])
  })

  it("leerer Zeitraum: Nullen, keine Division durch 0, Monate trotzdem gefüllt", () => {
    const a = werteAus([], z)
    expect(a.aktuell).toMatchObject({
      bestellungen: 0,
      umsatz_brutto: 0,
      durchschnitt_auftrag: 0,
      durchschnitt_stueck: 0,
      gratis_versand_anteil: 0,
    })
    expect(a.aenderung).toEqual({ bestellungen: null, umsatz: null, durchschnitt_auftrag: null })
    expect(a.monate).toEqual([{ monat: "2026-10", bestellungen: 0, umsatz: 0 }])
    expect(a.top_bestellungen).toEqual([])
  })
})

describe("Hilfsfunktionen", () => {
  it("veraenderung", () => {
    expect(veraenderung(150, 100)).toBe(50)
    expect(veraenderung(50, 100)).toBe(-50)
    expect(veraenderung(5, 0)).toBeNull()
  })
  it("topBestellungen und topProdukte respektieren das Limit", () => {
    const viele = Array.from({ length: 15 }, (_, i) =>
      bestellung({
        id: `o${i}`,
        created_at: "2026-10-05T10:00:00Z",
        total: i,
        items: [{ quantity: 1, title: `P${i}`, product_id: `p${i}`, total: i }],
      })
    )
    expect(topBestellungen(viele)).toHaveLength(10)
    expect(topBestellungen(viele)[0].id).toBe("o14")
    expect(topProdukte(viele).nach_umsatz).toHaveLength(10)
  })
})

describe("GET /admin/dashboard/verkauf", () => {
  function antwort() {
    const res: any = { statusCode: 200, body: undefined }
    res.status = (c: number) => ((res.statusCode = c), res)
    res.json = (b: unknown) => ((res.body = b), res)
    return res
  }

  it("lädt seitenweise, bis eine Seite nicht mehr voll ist", async () => {
    const seiten = [
      Array.from({ length: 100 }, (_, i) => bestellung({ id: `a${i}`, created_at: "2026-10-05T10:00:00Z" })),
      Array.from({ length: 30 }, (_, i) => bestellung({ id: `b${i}`, created_at: "2026-10-06T10:00:00Z" })),
    ]
    const graph = jest.fn(async ({ pagination }: any) => ({ data: seiten[pagination.skip / 100] ?? [] }))
    const req: any = {
      query: { von: "2026-10-01", bis: "2026-10-31" },
      scope: { resolve: () => ({ graph }) },
    }
    const res = antwort()
    await GET(req, res)
    expect(graph).toHaveBeenCalledTimes(2)
    expect(res.body.geladen).toBe(130)
    expect(res.body.aktuell.bestellungen).toBe(130)
    expect(res.body.abgeschnitten).toBe(false)
  })

  it("bricht bei der Obergrenze ab und meldet das", async () => {
    const graph = jest.fn(async () => ({
      data: Array.from({ length: 100 }, (_, i) => bestellung({ id: `x${i}`, created_at: "2026-10-05T10:00:00Z" })),
    }))
    const req: any = { query: { von: "2026-10-01", bis: "2026-10-31" }, scope: { resolve: () => ({ graph }) } }
    const res = antwort()
    await GET(req, res)
    expect(graph).toHaveBeenCalledTimes(50)
    expect(res.body.abgeschnitten).toBe(true)
  })

  it("antwortet 400 bei ungültigem Datum", async () => {
    const req: any = { query: { von: "kaputt" }, scope: { resolve: () => ({ graph: jest.fn() }) } }
    const res = antwort()
    await GET(req, res)
    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Echte Form aus query.graph (Medusa v2, am 2026-10-29 auf api.jibbit.ch
// beobachtet): total/shipping_total/quantity/amount sind BigNumber-INSTANZEN
// (Getter `numeric`, `raw.value`, `valueOf()`), kein Feld `value`. Erst die
// HTTP-Serialisierung (toJSON) macht daraus Zahlen. Anonymisiert.
// ---------------------------------------------------------------------------
import { BigNumber } from "@medusajs/framework/utils"
import { betrag, berechneKennzahlen } from "../lib/dashboard-verkauf"

function echt(
  id: string,
  nr: number,
  datum: string,
  total: number,
  versand: number,
  menge: number,
  bezahlt: boolean
): RohBestellung {
  return {
    id,
    display_id: nr,
    created_at: datum,
    status: "pending",
    total: new BigNumber(total) as never,
    shipping_total: new BigNumber(versand) as never,
    items: [
      {
        quantity: new BigNumber(menge) as never,
        title: "Artikel",
        product_id: "prod_1",
        unit_price: new BigNumber((total - versand) / menge) as never,
        total: new BigNumber(total - versand) as never,
      },
    ],
    payment_collections: [
      {
        status: bezahlt ? "completed" : "not_paid",
        payments: bezahlt
          ? [{ captures: [{ amount: new BigNumber(total) as never }], refunds: [] }]
          : [],
      },
    ],
  }
}

describe("betrag mit echten Formen", () => {
  it("liest BigNumber-Instanzen, Strings, Zahlen, rohe Werte", () => {
    expect(betrag(new BigNumber(8.28) as never)).toBe(8.28)
    expect(betrag(new BigNumber("17.25") as never)).toBe(17.25)
    expect(betrag({ value: "9", precision: 20 } as never)).toBe(9)
    expect(betrag({ numeric: 3.75 })).toBe(3.75)
    expect(betrag({ raw: { value: "4.5" } })).toBe(4.5)
    expect(betrag("8.65")).toBe(8.65)
    expect(betrag(8.28)).toBe(8.28)
    expect(betrag(null)).toBe(0)
    expect(betrag(undefined)).toBe(0)
  })
})

describe("Auswertung mit BigNumber-Bestellungen (Bestellungen #1 bis #4)", () => {
  const alle = [
    echt("o1", 1, "2026-09-03T22:17:06.127Z", 71.4, 9, 48, false),
    echt("o2", 2, "2026-09-03T22:25:03.933Z", 17.25, 3.75, 10, true),
    echt("o3", 3, "2026-09-04T18:29:29.503Z", 8.65, 3.75, 4, true),
    echt("o4", 4, "2026-10-29T14:16:20.722Z", 8.28, 4.5, 3, true),
  ]
  const jetzt = Date.parse("2026-10-29T20:00:00Z")

  it("#1 ist nicht bezahlt, #2 bis #4 schon", () => {
    expect(alle.map(istBezahlt)).toEqual([false, true, true, true])
  })

  it("30 Tage (Widget): 1 Bestellung, CHF 8.28, Durchschnitt 8.28", () => {
    const z = bestimmeZeitraum(undefined, undefined, jetzt) as ReturnType<typeof bestimmeZeitraum> & {
      von: number
    }
    const a = werteAus(alle, z as never).aktuell
    expect(a.bestellungen).toBe(1)
    expect(a.umsatz_brutto).toBe(8.28)
    expect(a.durchschnitt_auftrag).toBe(8.28)
    expect(a.versand).toBe(4.5)
    expect(a.stueck_gesamt).toBe(3)
  })

  it("ab 2026-09-01: 3 Bestellungen, Summe 34.18", () => {
    const z = bestimmeZeitraum("2026-09-01", "2026-10-30", jetzt) as never
    const r = werteAus(alle, z)
    expect(r.aktuell.bestellungen).toBe(3)
    expect(r.aktuell.umsatz_brutto).toBe(34.18)
    expect(r.top_bestellungen[0].total).toBe(17.25)
    expect(r.top_produkte_umsatz[0].umsatz).toBeGreaterThan(0)
  })

  it("Rückerstattungen als BigNumber", () => {
    const b = echt("o9", 9, "2026-10-01T10:00:00Z", 10, 0, 1, true)
    b.payment_collections![0]!.payments![0]!.refunds = [{ amount: new BigNumber(2.5) as never }]
    const k = berechneKennzahlen([b])
    expect(k.rueckerstattungen).toBe(2.5)
    expect(k.umsatz_netto).toBe(7.5)
  })
})
