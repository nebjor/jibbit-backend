/**
 * Buchhaltungs-Berichte: Rückrechnung des Lagerbestands, Bewertung mit und
 * ohne Einstandspreis, Monatsauswertung inkl. Rückerstattungen, Jahresgrenzen
 * in Europe/Zurich, CSV-Escaping, Schnappschüsse (Dateien in Temp-Ordner) und
 * die GET-Routen mit gefälschtem Container.
 */
import { mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GET as lagerGET } from "../api/admin/buchhaltung/lagerbestand/route"
import { GET as umsatzGET } from "../api/admin/buchhaltung/umsatz/route"
import {
  berechneLagerbestand,
  bestandZumStichtag,
  CSV_BOM,
  csvDokument,
  csvZelle,
  geldText,
  jahresGrenzen,
  lagerCsv,
  leseEinstandspreis,
  pruefeStichtag,
  RohBestellungBuch,
  RohFulfillment,
  RohLevel,
  RohVariante,
  umsatzBestellungen,
  umsatzCsv,
  umsatzProMonat,
  zahlungenCsv,
  zahlungsposten,
  zahlungsSumme,
  zuerichTag,
} from "../lib/buchhaltung"
import {
  baueSnapshot,
  ladeSnapshot,
  listeSnapshots,
  snapshotId,
  speichereSnapshot,
} from "../lib/buchhaltung-snapshots"

// ------------------------------------------------------------ CSV

describe("CSV", () => {
  it("setzt Zellen mit Semikolon, Anführungszeichen und Umbruch in Anführungszeichen", () => {
    expect(csvZelle("a;b")).toBe('"a;b"')
    expect(csvZelle('Tee "Grün"')).toBe('"Tee ""Grün"""')
    expect(csvZelle("zwei\nZeilen")).toBe('"zwei\nZeilen"')
    expect(csvZelle("Müller & Söhne – Café")).toBe("Müller & Söhne – Café")
  })
  it("entschärft Formeln, lässt Zahlen unberührt", () => {
    expect(csvZelle("=SUMME(A1)")).toBe("'=SUMME(A1)")
    expect(csvZelle("@user")).toBe("'@user")
    expect(csvZelle(-12.5)).toBe("-12.5")
    expect(csvZelle(null)).toBe("")
    expect(csvZelle(undefined)).toBe("")
  })
  it("formatiert Beträge mit Dezimalpunkt und zwei Stellen", () => {
    expect(geldText(12.5)).toBe("12.50")
    expect(geldText(1234.567)).toBe("1234.57")
    expect(geldText(null)).toBe("")
  })
  it("beginnt mit BOM und trennt Zeilen mit CRLF", () => {
    const csv = csvDokument(["A", "B"], [["1", "x;y"]])
    expect(csv.startsWith(CSV_BOM)).toBe(true)
    expect(csv).toBe(CSV_BOM + 'A;B\r\n1;"x;y"\r\n')
  })
})

// ------------------------------------------------------ Einstandspreis

describe("leseEinstandspreis", () => {
  it("liest Zahlen und Texte", () => {
    expect(leseEinstandspreis({ einstandspreis: 1.85 })).toBe(1.85)
    expect(leseEinstandspreis({ einstandspreis: "1,85" })).toBe(1.85)
    expect(leseEinstandspreis({ einstandspreis: "CHF 2.50" })).toBe(2.5)
    expect(leseEinstandspreis({ einstandspreis: 0 })).toBe(0)
  })
  it("liefert null bei fehlendem oder ungültigem Wert", () => {
    expect(leseEinstandspreis(null)).toBeNull()
    expect(leseEinstandspreis({})).toBeNull()
    expect(leseEinstandspreis({ einstandspreis: "" })).toBeNull()
    expect(leseEinstandspreis({ einstandspreis: "abc" })).toBeNull()
    expect(leseEinstandspreis({ einstandspreis: -1 })).toBeNull()
    expect(leseEinstandspreis({ einstandspreis: NaN })).toBeNull()
  })
})

// ------------------------------------------------------------ Stichtag

describe("pruefeStichtag", () => {
  const jetzt = Date.parse("2027-01-15T10:00:00Z")
  it("nimmt heute als Standard und markiert ihn als live", () => {
    const r = pruefeStichtag(undefined, jetzt)
    expect(r).toMatchObject({ stichtag: "2027-01-15", heute: true })
  })
  it("setzt die Grenze auf Mitternacht nach dem Stichtag (Winterzeit)", () => {
    const r = pruefeStichtag("2026-12-31", jetzt)
    if ("fehler" in r) throw new Error(r.fehler)
    expect(r.heute).toBe(false)
    expect(new Date(r.grenze).toISOString()).toBe("2026-12-31T23:00:00.000Z")
  })
  it("verwirft Zukunft, Unsinn und falsche Formate", () => {
    expect(pruefeStichtag("2027-01-16", jetzt)).toHaveProperty("fehler")
    expect(pruefeStichtag("2026-02-30", jetzt)).toHaveProperty("fehler")
    expect(pruefeStichtag("31.12.2026", jetzt)).toHaveProperty("fehler")
  })
  it("rechnet «heute» in Zürcher Zeit (kurz nach Mitternacht lokal)", () => {
    // 23:30 UTC am 31.12. ist in Zürich bereits der 1.1.
    expect(zuerichTag(Date.parse("2026-12-31T23:30:00Z"))).toBe("2027-01-01")
  })
})

// --------------------------------------------- Rückrechnung / Bewertung

const GRENZE = Date.parse("2026-12-31T23:00:00Z") // Ende 31.12.2026 Zürich

const levels: RohLevel[] = [
  { inventory_item_id: "ii1", location_id: "loc", stocked_quantity: 10 },
  { inventory_item_id: "ii2", location_id: "loc", stocked_quantity: 3 },
]

function ff(p: Partial<RohFulfillment> & { id: string; created_at: string }): RohFulfillment {
  return { location_id: "loc", items: [{ inventory_item_id: "ii1", quantity: 2 }], ...p }
}

describe("bestandZumStichtag", () => {
  it("lässt den Live-Bestand unverändert (grenze null)", () => {
    const k = bestandZumStichtag(levels, [ff({ id: "f", created_at: "2027-02-01T00:00:00Z" })], null)
    expect(k.get("ii1|loc")).toBe(10)
  })
  it("addiert Versand nach dem Stichtag zurück", () => {
    const k = bestandZumStichtag(
      levels,
      [ff({ id: "f", created_at: "2027-01-05T09:00:00Z" })],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(12)
  })
  it("ignoriert Versand vor dem Stichtag", () => {
    const k = bestandZumStichtag(levels, [ff({ id: "f", created_at: "2026-12-30T09:00:00Z" })], GRENZE)
    expect(k.get("ii1|loc")).toBe(10)
  })
  it("Grenze exklusiv: genau zur Grenze erstellt zählt als nach dem Stichtag", () => {
    const k = bestandZumStichtag(levels, [ff({ id: "f", created_at: "2026-12-31T23:00:00Z" })], GRENZE)
    expect(k.get("ii1|loc")).toBe(12)
    const davor = bestandZumStichtag(
      levels,
      [ff({ id: "f", created_at: "2026-12-31T22:59:59Z" })],
      GRENZE
    )
    expect(davor.get("ii1|loc")).toBe(10)
  })
  it("Fulfillment nach dem Stichtag erstellt und storniert: netto null", () => {
    const k = bestandZumStichtag(
      levels,
      [ff({ id: "f", created_at: "2027-01-05T09:00:00Z", canceled_at: "2027-01-06T09:00:00Z" })],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(10)
  })
  it("vor dem Stichtag erstellt, danach storniert: Ware war am Stichtag draussen", () => {
    const k = bestandZumStichtag(
      levels,
      [ff({ id: "f", created_at: "2026-12-20T09:00:00Z", canceled_at: "2027-01-03T09:00:00Z" })],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(8)
  })
  it("vor dem Stichtag erstellt und storniert: ohne Wirkung", () => {
    const k = bestandZumStichtag(
      levels,
      [ff({ id: "f", created_at: "2026-12-20T09:00:00Z", canceled_at: "2026-12-22T09:00:00Z" })],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(10)
  })
  it("beachtet den Lagerort und überspringt Artikel ohne Lagerartikel-ID", () => {
    const k = bestandZumStichtag(
      levels,
      [
        ff({ id: "a", created_at: "2027-01-05T09:00:00Z", location_id: "anderer" }),
        ff({
          id: "b",
          created_at: "2027-01-05T09:00:00Z",
          items: [{ inventory_item_id: null, quantity: 5 }, null],
        }),
      ],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(10)
    expect(k.has("ii1|anderer")).toBe(false)
  })
  it("liest BigNumber-Objekte", () => {
    const k = bestandZumStichtag(
      [{ inventory_item_id: "ii1", location_id: "loc", stocked_quantity: { value: "4" } }],
      [ff({ id: "f", created_at: "2027-01-05T09:00:00Z", items: [{ inventory_item_id: "ii1", quantity: { value: "1" } }] })],
      GRENZE
    )
    expect(k.get("ii1|loc")).toBe(5)
  })
})

describe("berechneLagerbestand", () => {
  const varianten: RohVariante[] = [
    {
      id: "v1",
      sku: "TEE-1",
      barcode: "7612345678900",
      title: "100 g",
      product: { title: "Tee" },
      metadata: { einstandspreis: 2.5 },
      inventory_items: [{ inventory_item_id: "ii1", required_quantity: 1 }],
    },
    {
      id: "v2",
      sku: "KAF-1",
      title: "250 g",
      product: { title: "Kaffee" },
      metadata: {},
      inventory_items: [{ inventory_item_id: "ii2", required_quantity: 1 }],
    },
    { id: "v3", sku: "X", title: "ohne Lager", product: { title: "Zeug" }, inventory_items: [] },
  ]
  const info = { stichtag: "2026-12-31", grenze: GRENZE, heute: false }

  it("bewertet mit Einstandspreis und kennzeichnet fehlende", () => {
    const r = berechneLagerbestand(
      varianten,
      levels,
      [ff({ id: "f", created_at: "2027-01-05T09:00:00Z" })],
      info
    )
    // sortiert: Kaffee vor Tee
    expect(r.positionen.map((p) => p.sku)).toEqual(["KAF-1", "TEE-1"])
    const kaffee = r.positionen[0]
    expect(kaffee).toMatchObject({ menge: 3, einstandspreis: null, wert: null })
    const tee = r.positionen[1]
    expect(tee).toMatchObject({ menge: 12, menge_heute: 10, einstandspreis: 2.5, wert: 30 })
    expect(tee.gtin).toBe("7612345678900")
    expect(r.summe).toMatchObject({
      positionen: 2,
      stueck: 15,
      wert: 30,
      ohne_einstandspreis: 1,
      stueck_ohne_einstandspreis: 3,
    })
    expect(r.live).toBe(false)
    expect(r.hinweise.join(" ")).toMatch(/Einstandspreis fehlt bei 1/)
    expect(r.hinweise.join(" ")).toMatch(/Rückgerechnet/)
    expect(r.hinweise.join(" ")).toMatch(/1 Varianten ohne Lagerartikel/)
  })
  it("rechnet für heute nicht zurück", () => {
    const r = berechneLagerbestand(
      varianten,
      levels,
      [ff({ id: "f", created_at: "2027-01-05T09:00:00Z" })],
      { stichtag: "2027-01-15", grenze: GRENZE, heute: true }
    )
    expect(r.positionen.find((p) => p.sku === "TEE-1")?.menge).toBe(10)
    expect(r.live).toBe(true)
  })
  it("bewertet negative Bestände mit 0 und warnt", () => {
    const r = berechneLagerbestand(
      varianten,
      levels,
      [ff({ id: "f", created_at: "2026-12-20T09:00:00Z", canceled_at: "2027-01-03T09:00:00Z", items: [{ inventory_item_id: "ii2", quantity: 5 }] })],
      info
    )
    const k = r.positionen.find((p) => p.sku === "KAF-1")!
    expect(k.menge).toBe(-2)
    expect(r.summe.negativ).toBe(1)
    expect(r.summe.stueck).toBe(10)
  })
  it("rundet Stücklisten auf volle Einheiten ab und summiert Lagerorte", () => {
    const r = berechneLagerbestand(
      [
        {
          id: "v",
          title: "Set",
          product: { title: "Set" },
          metadata: { einstandspreis: "4,00" },
          inventory_items: [{ inventory_item_id: "a", required_quantity: 2 }],
        },
      ],
      [
        { inventory_item_id: "a", location_id: "l1", stocked_quantity: 5 },
        { inventory_item_id: "a", location_id: "l2", stocked_quantity: 4 },
      ],
      [],
      { stichtag: "2027-01-15", grenze: GRENZE, heute: true }
    )
    expect(r.positionen[0]).toMatchObject({ menge: 4, wert: 16 })
  })
  it("weist Varianten mit ausgeschaltetem manage_inventory aus", () => {
    const r = berechneLagerbestand(
      [{ ...varianten[0], manage_inventory: false }],
      levels,
      [],
      { stichtag: "2027-01-15", grenze: GRENZE, heute: true }
    )
    expect(r.summe.nicht_verwaltet).toBe(1)
  })
})

describe("lagerCsv", () => {
  it("lässt Preis und Wert leer, wenn der Einstandspreis fehlt", () => {
    const csv = lagerCsv(
      "2026-12-31",
      [
        { sku: "A", gtin: "", produkt: 'Tee; "Bio"', variante: "Süss", menge: 3, einstandspreis: null, wert: null },
        { sku: "B", gtin: "123", produkt: "Kaffee", variante: "", menge: 2, einstandspreis: 1.5, wert: 3 },
      ],
      { stueck: 5, wert: 3 }
    )
    const zeilen = csv.replace(CSV_BOM, "").split("\r\n")
    expect(zeilen[0]).toBe(
      "Stichtag;Produkt;Variante;SKU;GTIN;Menge;Einstandspreis CHF;Wert CHF;Hinweis"
    )
    expect(zeilen[1]).toBe('2026-12-31;"Tee; ""Bio""";Süss;A;;3;;;Einstandspreis fehlt')
    expect(zeilen[2]).toBe("2026-12-31;Kaffee;;B;123;2;1.50;3.00;")
    expect(zeilen[3]).toBe("2026-12-31;Total;;;;5;;3.00;")
  })
})

// ------------------------------------------------------------- Umsatz

function best(p: Partial<RohBestellungBuch> & { id: string; created_at: string }): RohBestellungBuch {
  return {
    status: "pending",
    display_id: 1,
    total: 50,
    shipping_total: 5,
    email: "k@example.ch",
    customer: { first_name: "Anna", last_name: "Müller", email: "k@example.ch" },
    payment_collections: [
      {
        status: "completed",
        payments: [
          {
            id: "pay_1",
            provider_id: "pp_zahls",
            captures: [{ amount: 50, created_at: p.created_at }],
            refunds: [],
          },
        ],
      },
    ],
    ...p,
  }
}

describe("Jahresgrenzen Europe/Zurich", () => {
  it("beginnt das Jahr in Zürcher Mitternacht (Winterzeit = UTC+1)", () => {
    const g = jahresGrenzen(2026)
    expect(new Date(g.von).toISOString()).toBe("2025-12-31T23:00:00.000Z")
    expect(new Date(g.bis).toISOString()).toBe("2026-12-31T23:00:00.000Z")
  })
  it("ordnet Bestellungen um den Jahreswechsel dem Zürcher Jahr zu", () => {
    const liste = [
      best({ id: "alt", display_id: 1, created_at: "2025-12-31T22:59:00Z" }), // 31.12. 23:59 Zürich
      best({ id: "neu", display_id: 2, created_at: "2025-12-31T23:00:00Z" }), // 1.1. 00:00 Zürich
      best({ id: "ende", display_id: 3, created_at: "2026-12-31T22:59:00Z" }), // 31.12.2026 23:59
      best({ id: "naechstes", display_id: 4, created_at: "2026-12-31T23:00:00Z" }), // 1.1.2027
    ]
    expect(umsatzBestellungen(liste, 2026).map((b) => b.id)).toEqual(["neu", "ende"])
    expect(umsatzBestellungen(liste, 2025).map((b) => b.id)).toEqual(["alt"])
    const { monate } = umsatzProMonat(liste, 2026)
    expect(monate[0].bestellungen).toBe(1)
    expect(monate[11].bestellungen).toBe(1)
  })
})

describe("umsatzProMonat", () => {
  const liste = [
    best({ id: "a", display_id: 1, created_at: "2026-03-10T10:00:00Z", total: 50, shipping_total: 5 }),
    best({
      id: "b",
      display_id: 2,
      created_at: "2026-03-20T10:00:00Z",
      total: 30,
      shipping_total: 0,
      payment_collections: [
        {
          status: "completed",
          payments: [{ id: "pay_2", captures: [{ amount: 30 }], refunds: [{ amount: 10 }] }],
        },
      ],
    }),
    best({ id: "c", display_id: 3, created_at: "2026-07-01T10:00:00Z", total: 20, shipping_total: 5 }),
    // nicht bezahlt / storniert zählen nicht
    best({ id: "x", display_id: 4, created_at: "2026-03-11T10:00:00Z", payment_collections: [] }),
    best({ id: "y", display_id: 5, created_at: "2026-03-12T10:00:00Z", status: "canceled" }),
  ]
  it("liefert zwölf Monate mit Waren, Versand, Brutto, Rückerstattungen, Netto", () => {
    const { monate, summe } = umsatzProMonat(liste, 2026)
    expect(monate).toHaveLength(12)
    expect(monate[2]).toMatchObject({
      monat: "2026-03",
      bestellungen: 2,
      waren: 75,
      versand: 5,
      brutto: 80,
      rueckerstattungen: 10,
      netto: 70,
    })
    expect(monate[6]).toMatchObject({ bestellungen: 1, waren: 15, brutto: 20, netto: 20 })
    expect(monate[0]).toMatchObject({ bestellungen: 0, brutto: 0 })
    expect(summe).toMatchObject({
      bestellungen: 3,
      waren: 90,
      versand: 10,
      brutto: 100,
      rueckerstattungen: 10,
      netto: 90,
    })
  })
  it("ist für ein Jahr ohne Bestellungen überall null", () => {
    const { summe } = umsatzProMonat(liste, 2024)
    expect(summe).toMatchObject({ bestellungen: 0, brutto: 0, netto: 0 })
  })
})

describe("umsatzCsv", () => {
  it("enthält Kopf, Bestellungen mit Anbieter/ID und Summenzeile", () => {
    const liste = umsatzBestellungen(
      [
        best({
          id: "a",
          display_id: 7,
          created_at: "2026-03-10T10:00:00Z",
          customer: { first_name: "Hans", last_name: 'O"Brien; Söhne', email: "h@ex.ch" },
        }),
      ],
      2026
    )
    const zeilen = umsatzCsv(liste).replace(CSV_BOM, "").split("\r\n")
    expect(zeilen[0]).toContain("Bestellung;Datum;Kunde;E-Mail;Waren CHF")
    expect(zeilen[1]).toBe(
      '7;2026-03-10;"Hans O""Brien; Söhne";h@ex.ch;45.00;5.00;50.00;0.00;50.00;pp_zahls;pay_1'
    )
    expect(zeilen[2]).toBe("Total;;;;45.00;5.00;50.00;0.00;50.00;;")
  })
})

describe("Zahlungsliste nach Zahlungsdatum", () => {
  const liste = [
    // Dezember bestellt, Januar bezahlt: gehört ins Zahlungsjahr 2026
    best({
      id: "a",
      display_id: 1,
      created_at: "2025-12-30T10:00:00Z",
      payment_collections: [
        {
          status: "completed",
          payments: [
            {
              id: "pay_a",
              provider_id: "pp_zahls",
              captures: [{ amount: 40, created_at: "2026-01-02T08:00:00Z" }],
              refunds: [{ amount: 15, created_at: "2026-02-01T08:00:00Z" }],
            },
          ],
        },
      ],
    }),
    best({ id: "b", display_id: 2, created_at: "2026-05-05T10:00:00Z" }),
    // storniert, aber Geld war da und ging zurück
    best({
      id: "c",
      display_id: 3,
      status: "canceled",
      created_at: "2026-06-05T10:00:00Z",
      payment_collections: [
        {
          status: "canceled",
          payments: [
            {
              id: "pay_c",
              captures: [{ amount: 20, created_at: "2026-06-05T10:05:00Z" }],
              refunds: [{ amount: 20, created_at: "2026-06-06T10:00:00Z" }],
            },
          ],
        },
      ],
    }),
  ]
  it("nimmt Captures und Rückerstattungen nach ihrem eigenen Datum", () => {
    const p26 = zahlungsposten(liste, 2026)
    expect(p26.map((x) => `${x.bestellung}:${x.typ}:${x.betrag}`)).toEqual([
      "1:Zahlung:40",
      "1:Rückerstattung:-15",
      "2:Zahlung:50",
      "3:Zahlung:20",
      "3:Rückerstattung:-20",
    ])
    expect(p26[0].datum).toBe("2026-01-02 09:00")
    expect(zahlungsSumme(p26)).toEqual({
      anzahl: 5,
      eingaenge: 110,
      rueckerstattungen: 35,
      saldo: 75,
    })
    expect(zahlungsposten(liste, 2025)).toHaveLength(0)
  })
  it("fällt ohne Capture-Datum auf das Bestelldatum zurück und schreibt Rückerstattungen negativ in die CSV", () => {
    const csv = zahlungenCsv(zahlungsposten(liste, 2026)).replace(CSV_BOM, "").split("\r\n")
    expect(csv[0]).toBe("Datum;Art;Bestellung;Betrag CHF;Zahlungsanbieter;Zahlungs-ID;Bestellstatus")
    expect(csv[2]).toBe("2026-02-01 09:00;Rückerstattung;1;-15.00;pp_zahls;pay_a;pending")
    expect(csv[3]).toBe("2026-05-05 12:00;Zahlung;2;50.00;pp_zahls;pay_1;pending")
    expect(csv[csv.length - 2]).toBe("Saldo;;;75.00;;;")
  })
})

// --------------------------------------------------------- Schnappschüsse

describe("Schnappschüsse", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "buchhaltung-test-"))
  })
  afterEach(async () => {
    const dateien = await readdir(dir)
    for (const d of dateien) await rm(join(dir, d))
    await rmdir(dir)
  })

  const positionen = [
    { variant_id: "v1", sku: "A", gtin: "", produkt: "Tee", variante: "100 g", menge: 4, menge_heute: 4, einstandspreis: 2, wert: 8, bestand_verwaltet: true },
  ]
  const summe = { positionen: 1, stueck: 4, wert: 8, ohne_einstandspreis: 0, stueck_ohne_einstandspreis: 0, negativ: 0, nicht_verwaltet: 0 }

  it("bildet die ID aus Stichtag und Uhrzeit", () => {
    expect(snapshotId("2026-12-31", new Date("2026-12-31T21:05:09Z"))).toBe("bestand-2026-12-31-210509")
  })
  it("speichert, listet (neueste zuerst) und lädt zurück", async () => {
    const a = baueSnapshot("2026-12-31", positionen, summe, "user_1", new Date("2026-12-31T10:00:00Z"))
    const b = baueSnapshot("2026-12-31", positionen, summe, null, new Date("2026-12-31T11:00:00Z"))
    await speichereSnapshot(dir, a)
    await speichereSnapshot(dir, b)
    const liste = await listeSnapshots(dir)
    expect(liste.map((s) => s.id)).toEqual([b.id, a.id])
    expect(liste[1]).toMatchObject({ stichtag: "2026-12-31", stueck: 4, wert: 8, erstellt_von: "user_1" })
    const geladen = await ladeSnapshot(dir, a.id)
    expect(geladen?.positionen[0]).toMatchObject({ sku: "A", menge: 4, einstandspreis: 2, wert: 8 })
    expect(geladen?.positionen[0]).not.toHaveProperty("menge_heute")
  })
  it("überschreibt nie einen bestehenden Schnappschuss", async () => {
    const a = baueSnapshot("2026-12-31", positionen, summe, null, new Date("2026-12-31T10:00:00Z"))
    await speichereSnapshot(dir, a)
    await expect(speichereSnapshot(dir, a)).rejects.toThrow()
    expect((await listeSnapshots(dir)).length).toBe(1)
  })
  it("verweigert ungültige IDs (Pfadtricks) und überspringt defekte Dateien", async () => {
    expect(await ladeSnapshot(dir, "../../etc/passwd")).toBeNull()
    expect(await ladeSnapshot(dir, "bestand-2026-12-31-000000")).toBeNull()
    await writeFile(join(dir, "bestand-2026-12-31-000001.json"), "{kaputt")
    expect(await listeSnapshots(dir)).toEqual([])
  })
  it("liefert eine leere Liste, wenn das Verzeichnis fehlt", async () => {
    expect(await listeSnapshots(join(dir, "gibt-es-nicht"))).toEqual([])
  })
})

// ------------------------------------------------------------- Routen

function antwort() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c
      return res
    },
    json(b: unknown) {
      res.body = b
      return res
    },
    send(b: unknown) {
      res.body = b
      return res
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v
    },
  }
  return res
}

function anfrage(query: Record<string, unknown>, daten: Record<string, any[]>) {
  return {
    query,
    scope: {
      resolve: () => ({
        graph: async ({ entity, pagination }: any) => ({
          data: (daten[entity] ?? []).slice(pagination.skip, pagination.skip + pagination.take),
        }),
      }),
    },
  } as any
}

describe("GET /admin/buchhaltung/lagerbestand", () => {
  const daten = {
    product_variant: [
      {
        id: "v1",
        sku: "A",
        title: "100 g",
        product: { title: "Tee" },
        metadata: { einstandspreis: 2 },
        inventory_items: [{ inventory_item_id: "ii1", required_quantity: 1 }],
      },
    ],
    inventory_level: [{ inventory_item_id: "ii1", location_id: "loc", stocked_quantity: 5 }],
    fulfillment: [],
  }
  it("liefert JSON für heute", async () => {
    const res = antwort()
    await lagerGET(anfrage({}, daten), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.live).toBe(true)
    expect(res.body.summe).toMatchObject({ stueck: 5, wert: 10 })
  })
  it("liefert CSV mit Download-Header", async () => {
    const res = antwort()
    await lagerGET(anfrage({ stichtag: "2020-12-31", format: "csv" }, daten), res)
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8")
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="lagerbestand-2020-12-31.csv"')
    expect((res.body as string).startsWith(CSV_BOM)).toBe(true)
  })
  it("lehnt falsche und zukünftige Stichtage mit 400 ab", async () => {
    for (const stichtag of ["morgen", "2999-01-01"]) {
      const res = antwort()
      await lagerGET(anfrage({ stichtag }, daten), res)
      expect(res.statusCode).toBe(400)
    }
  })
  it("blättert über mehr als 100 Varianten", async () => {
    const viele = Array.from({ length: 250 }, (_, i) => ({
      id: `v${i}`,
      title: String(i),
      product: { title: "P" },
      inventory_items: [{ inventory_item_id: `ii${i}`, required_quantity: 1 }],
    }))
    const res = antwort()
    await lagerGET(anfrage({}, { ...daten, product_variant: viele }), res)
    expect(res.body.summe.positionen).toBe(250)
  })
})

describe("GET /admin/buchhaltung/umsatz", () => {
  const daten = {
    order: [best({ id: "a", display_id: 1, created_at: "2026-03-10T10:00:00Z" })],
  }
  it("liefert Monatstabelle und Zahlungssaldo", async () => {
    const res = antwort()
    await umsatzGET(anfrage({ jahr: "2026" }, daten), res)
    expect(res.body.jahr).toBe(2026)
    expect(res.body.summe).toMatchObject({ bestellungen: 1, brutto: 50, netto: 50 })
    expect(res.body.zahlungen).toMatchObject({ eingaenge: 50, saldo: 50 })
  })
  it("liefert beide CSV-Formate", async () => {
    const a = antwort()
    await umsatzGET(anfrage({ jahr: "2026", format: "csv" }, daten), a)
    expect(a.headers["Content-Disposition"]).toBe('attachment; filename="umsatz-2026-bestellungen.csv"')
    const z = antwort()
    await umsatzGET(anfrage({ jahr: "2026", format: "zahlungen-csv" }, daten), z)
    expect(z.headers["Content-Disposition"]).toBe('attachment; filename="umsatz-2026-zahlungen.csv"')
  })
  it("lehnt ungültige Jahre und Formate ab", async () => {
    for (const q of [{ jahr: "26" }, { jahr: "1999" }, { jahr: "2026", format: "xls" }]) {
      const res = antwort()
      await umsatzGET(anfrage(q, daten), res)
      expect(res.statusCode).toBe(400)
    }
  })
})
