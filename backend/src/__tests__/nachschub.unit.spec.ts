/**
 * Nachschubsteuerung — Adressprüfung, Auswahl der nachzubestellenden
 * Varianten und die Pflege im Admin (Formular-Bausteine + API-Prüfung).
 *
 * Die kritischen Punkte:
 *   1. Die Lieferanten-URL wird im Admin als Link gerendert — nur http/https
 *      darf durchkommen, geprüft beim Speichern (Formular UND Admin-API)
 *      sowie beim Rendern.
 *   2. Grenzfall: Bestand GENAU auf dem Meldebestand ist fällig.
 *   3. Eine leere Fällig-Liste ist keine Entwarnung — die Zählung der nicht
 *      überwachbaren Varianten muss stimmen (heute: alle 35).
 *   4. Die metadata der Variante wird beim Speichern als GANZES geschrieben —
 *      fremde Schlüssel (units_per_pack, pack_type, …) müssen den
 *      Speichervorgang überleben.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  isSafeSupplierUrl,
  istFaellig,
  LieferantEingabe,
  lieferantenEingabeAusMetadata,
  meldebestandEingabeAusMetadata,
  nachschubFormularMetadata,
  nachschubUebersicht,
  NachschubZeile,
  parseLieferanten,
  parseMeldebestand,
  pruefeLieferantenEingabe,
  pruefeMeldebestandEingabe,
  sammleNachschubMetadataFehler,
  validateNachschubMetadata,
} from "../lib/nachschub"
import { validateNachschubBody } from "../api/middlewares"

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

// ─── Pflege im Admin: Formular-Bausteine ────────────────────────

function lieferant(overrides: Partial<LieferantEingabe> = {}): LieferantEingabe {
  return {
    name: "Grosshandel A",
    url: "https://a.example.ch/p/1",
    article_number: "A-100",
    ...overrides,
  }
}

describe("lieferantenEingabeAusMetadata", () => {
  it("liest Rohwerte — auch kaputte, damit sie korrigiert werden können", () => {
    expect(
      lieferantenEingabeAusMetadata({
        suppliers: [
          { name: "A", url: "https://a.example.ch/p", article_number: "A-1" },
          { name: "", url: "javascript:alert(1)" },
          { name: "C" },
        ],
      })
    ).toEqual([
      { name: "A", url: "https://a.example.ch/p", article_number: "A-1" },
      { name: "", url: "javascript:alert(1)", article_number: "" },
      { name: "C", url: "", article_number: "" },
    ])
  })

  it("übersteht Müll", () => {
    expect(lieferantenEingabeAusMetadata(null)).toEqual([])
    expect(lieferantenEingabeAusMetadata({ suppliers: "kaputt" })).toEqual([])
    expect(
      lieferantenEingabeAusMetadata({ suppliers: [null, 42, { name: 7 }] })
    ).toEqual([{ name: "", url: "", article_number: "" }])
  })
})

describe("meldebestandEingabeAusMetadata", () => {
  it.each([
    [{ reorder_point: 10 }, "10"],
    [{ reorder_point: 0 }, "0"],
    [{ reorder_point: "kaputt" }, ""],
    [{}, ""],
    [null, ""],
  ])("metadata=%p -> %p", (metadata, want) => {
    expect(meldebestandEingabeAusMetadata(metadata as any)).toBe(want)
  })
})

describe("pruefeMeldebestandEingabe", () => {
  it("leer ist erlaubt (= nicht überwachen), ganze Zahlen ab 0 auch", () => {
    expect(pruefeMeldebestandEingabe("")).toBeNull()
    expect(pruefeMeldebestandEingabe("  ")).toBeNull()
    expect(pruefeMeldebestandEingabe("0")).toBeNull()
    expect(pruefeMeldebestandEingabe("10")).toBeNull()
  })

  it.each([["-1"], ["2.5"], ["abc"], ["1e"]])(
    "lehnt %s ab",
    (wert) => {
      expect(pruefeMeldebestandEingabe(wert)).toContain("ganze Zahl")
    }
  )
})

describe("pruefeLieferantenEingabe — die Adressprüfung beim Speichern", () => {
  it("akzeptiert gültige Einträge, leere Liste und leere Adresse", () => {
    expect(pruefeLieferantenEingabe([])).toEqual([])
    expect(pruefeLieferantenEingabe([lieferant()])).toEqual([])
    expect(
      pruefeLieferantenEingabe([lieferant({ url: "", article_number: "" })])
    ).toEqual([])
  })

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["data:text/html,x"],
    ["/relativ"],
    ["www.ohne-schema.ch/produkt"],
  ])("lehnt die Adresse «%s» beim Speichern ab", (url) => {
    const fehler = pruefeLieferantenEingabe([lieferant({ url })])
    expect(fehler).toHaveLength(1)
    expect(fehler[0]).toContain("http(s)")
  })

  it("lehnt einen leeren Lieferantennamen ab — er wird nicht gespeichert", () => {
    expect(pruefeLieferantenEingabe([lieferant({ name: "" })])).toEqual([
      "Lieferant 1: Name fehlt.",
    ])
    expect(pruefeLieferantenEingabe([lieferant({ name: "   " })])).toEqual([
      "Lieferant 1: Name fehlt.",
    ])
  })

  it("nennt die Position des kaputten Eintrags", () => {
    const fehler = pruefeLieferantenEingabe([
      lieferant(),
      lieferant({ name: "", url: "ftp://x" }),
    ])
    expect(fehler).toEqual([
      "Lieferant 2: Name fehlt.",
      expect.stringContaining("Lieferant 2: Adresse"),
    ])
  })
})

describe("nachschubFormularMetadata — die gefährlichste Stelle", () => {
  it("LÄSST FREMDE SCHLÜSSEL STEHEN: metadata wird als Ganzes geschrieben", () => {
    // units_per_pack & Co. stammen aus der Odoo-Migration. Gingen sie beim
    // Speichern im Widget verloren, wäre der Grundpreis auf der
    // Produktseite kaputt — deshalb wird IMMER gemergt geschrieben.
    const res = nachschubFormularMetadata(
      { units_per_pack: 60, pack_type: "display", irgendwas: { tief: true } },
      { meldebestand: "10", lieferanten: [lieferant()] }
    )
    expect(res).toEqual({
      units_per_pack: 60,
      pack_type: "display",
      irgendwas: { tief: true },
      reorder_point: 10,
      suppliers: [
        {
          name: "Grosshandel A",
          url: "https://a.example.ch/p/1",
          article_number: "A-100",
        },
      ],
    })
  })

  it("Entfernen des letzten Lieferanten leert sauber — kein kaputter Eintrag", () => {
    const res = nachschubFormularMetadata(
      {
        units_per_pack: 1,
        suppliers: [{ name: "Alt", url: "https://alt.example.ch/p" }],
      },
      { meldebestand: "5", lieferanten: [] }
    )
    expect(res.suppliers).toBeNull()
    expect(res.units_per_pack).toBe(1)
    // Die Leser sehen danach schlicht «kein Lieferant gepflegt»:
    expect(parseLieferanten(res)).toEqual([])
  })

  it("leerer Meldebestand leert den Schlüssel (nicht 0, nicht NaN)", () => {
    const res = nachschubFormularMetadata(
      { reorder_point: 10, units_per_pack: 1 },
      { meldebestand: "", lieferanten: [lieferant()] }
    )
    expect(res.reorder_point).toBeNull()
    expect(parseMeldebestand(res)).toBeNull()
  })

  it("trimmt und normalisiert: leere URL/Artikelnummer werden null", () => {
    const res = nachschubFormularMetadata(null, {
      meldebestand: " 7 ",
      lieferanten: [
        { name: "  B  ", url: "  ", article_number: "" },
      ],
    })
    expect(res).toEqual({
      reorder_point: 7,
      suppliers: [{ name: "B", url: null, article_number: null }],
    })
  })
})

// ─── Prüfung beim Speichern über die Admin-API ──────────────────

describe("validateNachschubMetadata", () => {
  it("nichts zu beanstanden ohne Nachschub-Schlüssel oder bei null", () => {
    expect(validateNachschubMetadata(undefined)).toEqual([])
    expect(validateNachschubMetadata(null)).toEqual([])
    expect(validateNachschubMetadata("egal")).toEqual([])
    expect(validateNachschubMetadata({ brand: "Gizeh" })).toEqual([])
    expect(
      validateNachschubMetadata({ reorder_point: null, suppliers: null })
    ).toEqual([])
  })

  it("akzeptiert gültige Nachschubdaten (auch die Formular-Normalform)", () => {
    expect(
      validateNachschubMetadata(
        nachschubFormularMetadata(
          { units_per_pack: 1 },
          {
            meldebestand: "10",
            lieferanten: [lieferant(), lieferant({ url: "" })],
          }
        )
      )
    ).toEqual([])
  })

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["data:text/html,x"],
    ["/relativ"],
  ])("blockt die Lieferanten-URL «%s» an der API", (url) => {
    const fehler = validateNachschubMetadata({
      suppliers: [{ name: "X", url }],
    })
    expect(fehler).toHaveLength(1)
    expect(fehler[0]).toContain("http(s)")
  })

  it("blockt Einträge ohne Namen und kaputte Strukturen", () => {
    expect(
      validateNachschubMetadata({ suppliers: [{ url: "https://a.example.ch/p" }] })
    ).toEqual([expect.stringContaining("name fehlt")])
    expect(validateNachschubMetadata({ suppliers: "kaputt" })).toEqual([
      expect.stringContaining("Liste"),
    ])
    expect(validateNachschubMetadata({ suppliers: [42] })).toEqual([
      expect.stringContaining("Objekt"),
    ])
  })

  it("blockt kaputte Meldebestände", () => {
    expect(validateNachschubMetadata({ reorder_point: -3 })).toHaveLength(1)
    expect(validateNachschubMetadata({ reorder_point: 2.5 })).toHaveLength(1)
    expect(validateNachschubMetadata({ reorder_point: "abc" })).toHaveLength(1)
    expect(validateNachschubMetadata({ reorder_point: 0 })).toEqual([])
  })
})

describe("sammleNachschubMetadataFehler — deckt auch Batch-Routen ab", () => {
  const boese = { suppliers: [{ name: "Böse", url: "javascript:alert(1)" }] }

  it("findet die metadata im direkten Varianten-Update", () => {
    expect(sammleNachschubMetadataFehler({ metadata: boese })).toHaveLength(1)
  })

  it("findet die metadata in Batch- und verschachtelten Updates", () => {
    // POST /admin/products/:id/variants/batch
    expect(
      sammleNachschubMetadataFehler({ update: [{ id: "v1", metadata: boese }] })
    ).toHaveLength(1)
    // POST /admin/products/batch mit eingebetteten Varianten
    expect(
      sammleNachschubMetadataFehler({
        update: [{ id: "p1", variants: [{ id: "v1", metadata: boese }] }],
      })
    ).toHaveLength(1)
    // POST /admin/products mit Varianten
    expect(
      sammleNachschubMetadataFehler({ variants: [{ metadata: boese }] })
    ).toHaveLength(1)
  })

  it("lässt harmlose Bodies durch", () => {
    expect(sammleNachschubMetadataFehler(undefined)).toEqual([])
    expect(sammleNachschubMetadataFehler({ title: "Neu" })).toEqual([])
    expect(
      sammleNachschubMetadataFehler({ metadata: { brand: "Gizeh" } })
    ).toEqual([])
    expect(
      sammleNachschubMetadataFehler({
        metadata: nachschubFormularMetadata(null, {
          meldebestand: "3",
          lieferanten: [lieferant()],
        }),
      })
    ).toEqual([])
  })
})

describe("validateNachschubBody (Middleware)", () => {
  function aufruf(body: unknown) {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }
    const next = jest.fn()
    validateNachschubBody({ body } as any, res as any, next)
    return { res, next }
  }

  it("weist eine javascript:-Adresse mit 400 ab — kein next()", () => {
    const { res, next } = aufruf({
      metadata: { suppliers: [{ name: "Böse", url: "javascript:alert(1)" }] },
    })
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      message: expect.stringContaining("http(s)"),
    })
    expect(next).not.toHaveBeenCalled()
  })

  it("lässt einen Request ohne Nachschubdaten passieren", () => {
    const { res, next } = aufruf({ title: "Neuer Titel" })
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("lässt gültige Nachschubdaten passieren", () => {
    const { next } = aufruf({
      metadata: nachschubFormularMetadata(
        { units_per_pack: 1 },
        { meldebestand: "5", lieferanten: [lieferant()] }
      ),
    })
    expect(next).toHaveBeenCalled()
  })
})
