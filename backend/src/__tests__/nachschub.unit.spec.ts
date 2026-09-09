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
 *   4. Die metadata wird beim Speichern als GANZES geschrieben — fremde
 *      Schlüssel müssen den Speichervorgang überleben: am Produkt z.B.
 *      brand (Galaxus-Anbindung), an der Variante ean, weight_g,
 *      units_per_pack, ….
 *   5. Lieferanten hängen am PRODUKT (product.metadata.suppliers), der
 *      Meldebestand an der VARIANTE (variant.metadata.reorder_point).
 *      Alt-Einträge je Variante gelten als Rückfallebene weiter und gehen
 *      NIE stillschweigend verloren (effektiveLieferantenMetadata).
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  effektiveLieferantenMetadata,
  fuehreVariantenLieferantenZusammen,
  isSafeSupplierUrl,
  istFaellig,
  LieferantEingabe,
  lieferantenEingabeAusMetadata,
  lieferantenFormularMetadata,
  meldebestandEingabeAusMetadata,
  meldebestandFormularMetadata,
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

describe("meldebestandFormularMetadata — Varianten-metadata, die gefährlichste Stelle", () => {
  it("LÄSST FREMDE SCHLÜSSEL STEHEN: metadata wird als Ganzes geschrieben", () => {
    // ean/weight_g braucht die Galaxus-Anbindung, units_per_pack & Co.
    // stammen aus der Odoo-Migration. Gingen sie beim Speichern im Widget
    // verloren, wären Galaxus-Export und Grundpreis kaputt — deshalb wird
    // IMMER gemergt geschrieben.
    const res = meldebestandFormularMetadata(
      {
        ean: "7611234567890",
        weight_g: 24,
        units_per_pack: 60,
        pack_type: "display",
        irgendwas: { tief: true },
      },
      "10"
    )
    expect(res).toEqual({
      ean: "7611234567890",
      weight_g: 24,
      units_per_pack: 60,
      pack_type: "display",
      irgendwas: { tief: true },
      reorder_point: 10,
    })
  })

  it("leerer Meldebestand leert den Schlüssel (nicht 0, nicht NaN)", () => {
    const res = meldebestandFormularMetadata(
      { reorder_point: 10, ean: "761", units_per_pack: 1 },
      ""
    )
    expect(res.reorder_point).toBeNull()
    expect(res.ean).toBe("761")
    expect(parseMeldebestand(res)).toBeNull()
  })

  it("fasst die Lieferanten NICHT an — auch Alt-Einträge nicht", () => {
    // Das Räumen der Alt-Einträge ist ein bewusster, eigener Schritt beim
    // Speichern der Produkt-Lieferanten — nie ein Nebeneffekt des
    // Meldebestands.
    const res = meldebestandFormularMetadata(
      { suppliers: [{ name: "Alt", url: "https://alt.example.ch/p" }] },
      "3"
    )
    expect(res.suppliers).toEqual([
      { name: "Alt", url: "https://alt.example.ch/p" },
    ])
  })

  it("trimmt den Meldebestand", () => {
    expect(meldebestandFormularMetadata(null, " 7 ")).toEqual({
      reorder_point: 7,
    })
  })
})

describe("lieferantenFormularMetadata — Produkt-metadata, ebenso gefährlich", () => {
  it("LÄSST FREMDE SCHLÜSSEL STEHEN: brand braucht die Galaxus-Anbindung", () => {
    const res = lieferantenFormularMetadata(
      { brand: "Gizeh", irgendwas: { tief: true } },
      [lieferant()]
    )
    expect(res).toEqual({
      brand: "Gizeh",
      irgendwas: { tief: true },
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
    const res = lieferantenFormularMetadata(
      {
        brand: "Gizeh",
        suppliers: [{ name: "Alt", url: "https://alt.example.ch/p" }],
      },
      []
    )
    expect(res.suppliers).toBeNull()
    expect(res.brand).toBe("Gizeh")
    // Die Leser sehen danach schlicht «kein Lieferant gepflegt»:
    expect(parseLieferanten(res)).toEqual([])
  })

  it("räumt mit leerer Liste die ALT-Einträge einer Variante, ohne ihre übrigen Schlüssel anzufassen", () => {
    // Genau so hebt das Widget die Lieferanten ans Produkt: die Liste ans
    // Produkt schreiben, dann je Variante mit leerer Liste räumen.
    const res = lieferantenFormularMetadata(
      {
        ean: "7611234567890",
        weight_g: 24,
        reorder_point: 5,
        suppliers: [{ name: "Alt", url: "https://alt.example.ch/p" }],
      },
      []
    )
    expect(res).toEqual({
      ean: "7611234567890",
      weight_g: 24,
      reorder_point: 5,
      suppliers: null,
    })
  })

  it("trimmt und normalisiert: leere URL/Artikelnummer werden null", () => {
    const res = lieferantenFormularMetadata(null, [
      { name: "  B  ", url: "  ", article_number: "" },
    ])
    expect(res).toEqual({
      suppliers: [{ name: "B", url: null, article_number: null }],
    })
  })
})

// ─── Alt-Daten: Varianten-Lieferanten auf die Produktebene heben ──

describe("effektiveLieferantenMetadata — kein Eintrag geht verloren", () => {
  const hbieu = { name: "HBIEU", url: null, article_number: "10379" }

  it("die Produktliste gewinnt, sobald sie existiert — auch eine leere", () => {
    const produkt = { brand: "Gizeh", suppliers: [hbieu] }
    const res = effektiveLieferantenMetadata(produkt, [
      { suppliers: [{ name: "Anders", url: "https://x.example.ch/p" }] },
    ])
    expect(res.quelle).toBe("produkt")
    expect(res.metadata).toBe(produkt)

    // Leere Liste am Produkt = der Betreiber hat alle Lieferanten entfernt.
    const leer = effektiveLieferantenMetadata({ suppliers: [] }, [
      { suppliers: [hbieu] },
    ])
    expect(leer.quelle).toBe("produkt")
    expect(parseLieferanten(leer.metadata)).toEqual([])
  })

  it("DER FALL AUS DEM BETRIEB: ein an der Variante erfasster Lieferant bleibt sichtbar", () => {
    // Der Betreiber hat «HBIEU · 10379» an der Variante «1 Heftchen»
    // erfasst, bevor die Lieferanten ans Produkt wanderten. Der Eintrag
    // muss ohne erneute Eingabe auf Produktebene erscheinen.
    const res = effektiveLieferantenMetadata({ brand: "Gizeh" }, [
      { reorder_point: 5, suppliers: [hbieu] },
      { reorder_point: 2 },
    ])
    expect(res.quelle).toBe("varianten")
    expect(parseLieferanten(res.metadata)).toEqual([
      { name: "HBIEU", url: null, artikelnummer: "10379" },
    ])
    expect(res.zusammenfuehrung).toMatchObject({
      vonVarianten: 1,
      duplikateEntfernt: 0,
      unterschiedlich: false,
    })
  })

  it("ohne jegliche Lieferanten: Quelle produkt, leere Liste", () => {
    const res = effektiveLieferantenMetadata({ brand: "Gizeh" }, [
      { reorder_point: 5 },
      null,
    ])
    expect(res.quelle).toBe("produkt")
    expect(parseLieferanten(res.metadata)).toEqual([])
  })
})

describe("fuehreVariantenLieferantenZusammen — nachvollziehbare Zusammenführung", () => {
  const a = { name: "Grosshandel A", url: "https://a.example.ch/p", article_number: "A-1" }
  const b = { name: "Grosshandel B", url: "https://b.example.ch/p", article_number: null }

  it("identische Listen mehrerer Varianten werden EINE Liste (kein Konflikt)", () => {
    const res = fuehreVariantenLieferantenZusammen([
      { suppliers: [a, b] },
      { suppliers: [a, b] },
    ])
    expect(res.suppliers).toEqual([a, b])
    expect(res.vonVarianten).toBe(2)
    expect(res.duplikateEntfernt).toBe(2)
    expect(res.unterschiedlich).toBe(false)
  })

  it("unterschiedliche Listen: Vereinigungsmenge in Reihenfolge des ersten Vorkommens, Konflikt markiert", () => {
    // Lieber einen Eintrag zu viel zeigen als einen stillschweigend
    // verwerfen — die Entscheidung trifft der Betreiber beim Speichern.
    const res = fuehreVariantenLieferantenZusammen([
      { suppliers: [a] },
      { suppliers: [b, a] },
    ])
    expect(res.suppliers).toEqual([a, b])
    expect(res.unterschiedlich).toBe(true)
    // Der Hauptlieferant der ERSTEN gepflegten Variante bleibt vorn.
    expect(res.suppliers[0]).toEqual(a)
  })

  it("dedupliziert nur exakte Doppel (Name ohne Gross/Klein, Adresse, Artikelnummer)", () => {
    const res = fuehreVariantenLieferantenZusammen([
      { suppliers: [{ name: "HBIEU", article_number: "10379" }] },
      { suppliers: [{ name: "hbieu", article_number: "10379" }] },
      // andere Artikelnummer -> ein ECHT anderer Eintrag, bleibt erhalten
      { suppliers: [{ name: "HBIEU", article_number: "99999" }] },
    ])
    expect(res.suppliers).toEqual([
      { name: "HBIEU", article_number: "10379" },
      { name: "HBIEU", article_number: "99999" },
    ])
    expect(res.duplikateEntfernt).toBe(1)
  })

  it("übersteht Müll in den Varianten-Metadaten", () => {
    const res = fuehreVariantenLieferantenZusammen([
      null,
      undefined,
      { suppliers: "kaputt" },
      { suppliers: [null, 42, a] },
    ])
    expect(res.suppliers).toEqual([a])
    expect(res.vonVarianten).toBe(1)
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
    // Produktebene: Lieferanten.
    expect(
      validateNachschubMetadata(
        lieferantenFormularMetadata({ brand: "Gizeh" }, [
          lieferant(),
          lieferant({ url: "" }),
        ])
      )
    ).toEqual([])
    // Variantenebene: Meldebestand.
    expect(
      validateNachschubMetadata(
        meldebestandFormularMetadata({ units_per_pack: 1 }, "10")
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

  it("findet die metadata im direkten Produkt- oder Varianten-Update", () => {
    // POST /admin/products/:id (metadata auf PRODUKTEBENE — dort liegen die
    // Lieferanten jetzt) und POST /admin/products/:id/variants/:vid haben
    // dieselbe Body-Form: { metadata: … } zuoberst.
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
        metadata: {
          ...meldebestandFormularMetadata(null, "3"),
          ...lieferantenFormularMetadata(null, [lieferant()]),
        },
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
    // Produktebene: POST /admin/products/:id mit metadata.suppliers — hier
    // liegen die Lieferanten jetzt, die Middleware muss sie genauso
    // abfangen wie früher an der Variante.
    const { res, next } = aufruf({
      metadata: { suppliers: [{ name: "Böse", url: "javascript:alert(1)" }] },
    })
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      message: expect.stringContaining("http(s)"),
    })
    expect(next).not.toHaveBeenCalled()
  })

  it("fängt Alt-suppliers an der VARIANTE weiterhin ab (eingebettet)", () => {
    const { res, next } = aufruf({
      variants: [
        {
          id: "v1",
          metadata: {
            suppliers: [{ name: "Böse", url: "javascript:alert(1)" }],
          },
        },
      ],
    })
    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it("lässt einen Request ohne Nachschubdaten passieren", () => {
    const { res, next } = aufruf({ title: "Neuer Titel" })
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("lässt gültige Nachschubdaten passieren", () => {
    // Produkt-Update (Lieferanten) …
    const produkt = aufruf({
      metadata: lieferantenFormularMetadata({ brand: "Gizeh" }, [lieferant()]),
    })
    expect(produkt.next).toHaveBeenCalled()
    // … und Varianten-Update (Meldebestand).
    const variante = aufruf({
      metadata: meldebestandFormularMetadata({ units_per_pack: 1 }, "5"),
    })
    expect(variante.next).toHaveBeenCalled()
  })
})
