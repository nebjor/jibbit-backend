/**
 * Nachschubsteuerung — gemeinsame, reine Bausteine.
 *
 * Der Betreiber pflegt Meldebestand (reorder_point) und Bezugsquellen
 * (suppliers) je Variante direkt im Admin: im Widget «Nachschub» an der
 * Produktseite. Gespeichert wird über die Admin-API in die metadata der
 * Variante. Von dort lesen drei Abnehmer:
 *
 *   - das Admin-Widget an der Produktseite (src/admin/widgets/nachschub-widget.tsx)
 *   - die Admin-Seite «Nachschub»          (src/admin/routes/nachschub/page.tsx)
 *   - der Bericht fürs Terminal            (src/scripts/nachschub-report.ts)
 *
 * Dieses Modul ist bewusst rein (keine Datenbank, kein Medusa-Import): die
 * Admin-Oberfläche bündelt es per Vite mit, Scripts und Middleware per tsc,
 * und die Unit-Tests füttern es direkt.
 *
 * SICHERHEIT — die Lieferanten-URL wird im Admin als Link gerendert, und dort
 * sitzt jemand mit vollen Rechten. isSafeSupplierUrl() lässt NUR http: und
 * https: durch (kein javascript:, data:, vbscript:, keine relativen
 * Angaben). Geprüft wird dreimal:
 *
 *   1. beim Speichern im Formular (pruefeLieferantenEingabe) — der Betreiber
 *      sieht den Fehler sofort;
 *   2. beim Speichern über die Admin-API (validateNachschubMetadata via
 *      Middleware in src/api/middlewares.ts) — wer die API direkt anspricht,
 *      umgeht das Formular;
 *   3. beim Rendern (parseLieferanten liefert für alles andere url=null, der
 *      Link entfällt) — der eigentliche Schutz, falls doch etwas in der
 *      Datenbank landet. Jeder gerenderte Link trägt zusätzlich
 *      rel="noopener noreferrer".
 */

/** Schlüssel in variant.metadata, unter denen die Nachschubdaten liegen. */
export const SUPPLIERS_KEY = "suppliers"
export const REORDER_POINT_KEY = "reorder_point"

// ─── Adressprüfung ──────────────────────────────────────────────

/**
 * Nur absolute http(s)-Adressen gelten als Link-tauglich.
 *
 * new URL() normalisiert das Schema (JavaScript: -> javascript:) und
 * entfernt führende Steuer-/Leerzeichen — Tricks wie " jAvAsCrIpT:" oder
 * "java\tscript:" landen also ebenfalls beim verbotenen Schema. Relative
 * und schema-relative Angaben ("//host/…") werfen und fallen durch.
 */
export function isSafeSupplierUrl(url: unknown): url is string {
  if (typeof url !== "string") {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
}

// ─── Lieferanten aus den Varianten-Metadaten lesen ──────────────

export type Lieferant = {
  name: string
  /** Geprüfte Produktseiten-Adresse — null, wenn keine sichere http(s)-URL da ist. */
  url: string | null
  /** Die Roh-Angabe, falls sie als Link NICHT taugt — für eine Warnung im Admin. */
  unsichereUrl?: string
  /** Artikelnummer beim Lieferanten. */
  artikelnummer: string | null
}

/**
 * variant.metadata.suppliers defensiv lesen. Einträge ohne Namen fallen weg;
 * eine Adresse, die die Prüfung nicht besteht, wird zu url=null — der
 * Eintrag bleibt sichtbar (der Betreiber soll die kaputte Angabe sehen),
 * aber es entsteht nie ein Link daraus.
 */
export function parseLieferanten(
  metadata: Record<string, unknown> | null | undefined
): Lieferant[] {
  const raw = metadata?.[SUPPLIERS_KEY]
  if (!Array.isArray(raw)) {
    return []
  }
  const lieferanten: Lieferant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue
    }
    const e = entry as Record<string, unknown>
    const name = typeof e.name === "string" ? e.name.trim() : ""
    if (!name) {
      continue
    }
    const urlRaw = typeof e.url === "string" ? e.url.trim() : ""
    const artikelnummer =
      typeof e.article_number === "string" && e.article_number.trim()
        ? e.article_number.trim()
        : null
    const lieferant: Lieferant = {
      name,
      url: isSafeSupplierUrl(urlRaw) ? urlRaw : null,
      artikelnummer,
    }
    if (!lieferant.url && urlRaw) {
      lieferant.unsichereUrl = urlRaw
    }
    lieferanten.push(lieferant)
  }
  return lieferanten
}

/** variant.metadata.reorder_point defensiv lesen: ganze Zahl >= 0, sonst null. */
export function parseMeldebestand(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  const raw = metadata?.[REORDER_POINT_KEY]
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

// ─── Auswahl: was muss nachbestellt werden? ─────────────────────

export type NachschubZeile = {
  sku: string | null
  produkt: string
  variante: string
  /** Fürs Verlinken der Produktseite im Admin; Scripts lassen es leer. */
  productId?: string
  /** Verfügbarer Bestand; null = Bestandsführung aus oder kein Level. */
  bestand: number | null
  meldebestand: number | null
  lieferanten: Lieferant[]
}

export type NachschubUebersicht = {
  /** Bestand <= Meldebestand — die dringendsten zuerst. */
  faellig: NachschubZeile[]
  /** Varianten mit Bestand UND Meldebestand — nur die sind überwachbar. */
  ueberwacht: number
  /**
   * Varianten, die mangels Bestand oder Meldebestand NICHT überwacht werden
   * können. Solange dieser Wert > 0 ist, ist eine leere Fällig-Liste KEINE
   * Entwarnung — Übersicht und Bericht müssen ihn deshalb immer nennen.
   */
  nichtUeberwachbar: number
  /** davon: keine Bestandsführung an der Variante. */
  ohneBestand: number
  /** davon: Bestand da, aber kein Meldebestand (reorder_point) gepflegt. */
  ohneMeldebestand: number
  gesamt: number
}

/** Grenzfall eingeschlossen: Bestand GENAU auf dem Meldebestand ist fällig. */
export function istFaellig(z: NachschubZeile): boolean {
  return (
    z.bestand !== null && z.meldebestand !== null && z.bestand <= z.meldebestand
  )
}

/**
 * Dringlichkeit: grösste Unterdeckung (Bestand minus Meldebestand) zuerst,
 * bei Gleichstand der kleinere Bestand, zuletzt stabil nach SKU.
 */
export function nachDringlichkeit(a: NachschubZeile, b: NachschubZeile): number {
  const unterdeckung =
    (a.bestand ?? 0) -
    (a.meldebestand ?? 0) -
    ((b.bestand ?? 0) - (b.meldebestand ?? 0))
  if (unterdeckung !== 0) {
    return unterdeckung
  }
  if ((a.bestand ?? 0) !== (b.bestand ?? 0)) {
    return (a.bestand ?? 0) - (b.bestand ?? 0)
  }
  return (a.sku ?? "").localeCompare(b.sku ?? "")
}

export function nachschubUebersicht(
  zeilen: NachschubZeile[]
): NachschubUebersicht {
  const ohneBestand = zeilen.filter((z) => z.bestand === null).length
  const ohneMeldebestand = zeilen.filter(
    (z) => z.bestand !== null && z.meldebestand === null
  ).length
  const ueberwacht = zeilen.filter(
    (z) => z.bestand !== null && z.meldebestand !== null
  ).length
  const faellig = zeilen.filter(istFaellig).sort(nachDringlichkeit)
  return {
    faellig,
    ueberwacht,
    nichtUeberwachbar: ohneBestand + ohneMeldebestand,
    ohneBestand,
    ohneMeldebestand,
    gesamt: zeilen.length,
  }
}

// ─── Pflege im Admin: Formular-Bausteine ────────────────────────
//
// Das Widget «Nachschub» (Produktseite) bearbeitet Meldebestand und
// Lieferanten je Variante. Diese Bausteine sind rein und getestet:
// Rohwerte fürs Formular lesen, Eingaben prüfen, die metadata fürs
// Speichern MERGEN — die Admin-API schreibt metadata als Ganzes, fremde
// Schlüssel (units_per_pack, pack_type, …) müssen also mitkommen, sonst
// sind sie nach dem Speichern weg.

/** Eine Formularzeile im Widget — Rohtext, wie ihn der Betreiber eintippt. */
export type LieferantEingabe = {
  name: string
  url: string
  article_number: string
}

/**
 * Roh-Lieferanten fürs Formular lesen — bewusst UNGEFILTERT (anders als
 * parseLieferanten): auch ein Eintrag ohne Namen oder mit kaputter Adresse
 * soll im Formular erscheinen, damit er korrigiert werden kann.
 */
export function lieferantenEingabeAusMetadata(
  metadata: Record<string, unknown> | null | undefined
): LieferantEingabe[] {
  const raw = metadata?.[SUPPLIERS_KEY]
  if (!Array.isArray(raw)) {
    return []
  }
  const eintraege: LieferantEingabe[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue
    }
    const e = entry as Record<string, unknown>
    eintraege.push({
      name: typeof e.name === "string" ? e.name : "",
      url: typeof e.url === "string" ? e.url : "",
      article_number:
        typeof e.article_number === "string" ? e.article_number : "",
    })
  }
  return eintraege
}

/** Meldebestand als Formularwert: "" = nicht gepflegt. */
export function meldebestandEingabeAusMetadata(
  metadata: Record<string, unknown> | null | undefined
): string {
  const n = parseMeldebestand(metadata)
  return n === null ? "" : String(n)
}

/** Leer ist erlaubt (= kein Meldebestand); sonst ganze Zahl >= 0. */
export function pruefeMeldebestandEingabe(wert: string): string | null {
  if (wert.trim() === "") {
    return null
  }
  const n = Number(wert)
  return Number.isInteger(n) && n >= 0
    ? null
    : "Meldebestand muss eine ganze Zahl ab 0 sein — oder leer bleiben."
}

/**
 * Formularprüfung vor dem Speichern: jeder Lieferant braucht einen Namen,
 * und eine Adresse (optional) muss eine absolute http(s)-Adresse sein.
 * Der Betreiber sieht den Fehler so sofort — statt später einen toten
 * Link. Leere Liste = keine Fehler (alle Lieferanten entfernt ist gültig).
 */
export function pruefeLieferantenEingabe(
  eintraege: LieferantEingabe[]
): string[] {
  const fehler: string[] = []
  eintraege.forEach((l, i) => {
    const wo = `Lieferant ${i + 1}`
    if (!l.name.trim()) {
      fehler.push(`${wo}: Name fehlt.`)
    }
    const url = l.url.trim()
    if (url && !isSafeSupplierUrl(url)) {
      fehler.push(
        `${wo}: Adresse muss eine vollständige http(s)-Adresse sein ` +
          `(«${url}» ist keine).`
      )
    }
  })
  return fehler
}

/**
 * Die metadata fürs Speichern bauen — GEMERGT: alle fremden Schlüssel der
 * Variante bleiben erhalten, nur reorder_point und suppliers werden
 * gesetzt. Leere Eingaben leeren den jeweiligen Schlüssel sauber (null):
 * parseMeldebestand/parseLieferanten lesen null als «nicht gepflegt», und
 * null räumt den Wert auch dann ab, wenn die API metadata schlüsselweise
 * mergen sollte.
 */
export function nachschubFormularMetadata(
  existing: Record<string, unknown> | null | undefined,
  eingabe: { meldebestand: string; lieferanten: LieferantEingabe[] }
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(existing ?? {}) }
  const m = eingabe.meldebestand.trim()
  metadata[REORDER_POINT_KEY] = m === "" ? null : Number(m)
  metadata[SUPPLIERS_KEY] = eingabe.lieferanten.length
    ? eingabe.lieferanten.map((l) => ({
        name: l.name.trim(),
        url: l.url.trim() || null,
        article_number: l.article_number.trim() || null,
      }))
    : null
  return metadata
}

// ─── Prüfung beim Speichern über die Admin-API ──────────────────

/**
 * Nachschub-Schlüssel in einer metadata prüfen — die Server-Seite der
 * Formularprüfung: wer die Admin-API direkt anspricht, umgeht das Formular.
 * Fremde Schlüssel werden nicht beanstandet; fehlen reorder_point und
 * suppliers ganz (oder sind null), gibt es nichts zu prüfen. Insbesondere
 * kommt so nie eine javascript:-Adresse in die Datenbank.
 */
export function validateNachschubMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return []
  }
  const m = metadata as Record<string, unknown>
  const fehler: string[] = []

  if (m[REORDER_POINT_KEY] != null && parseMeldebestand(m) === null) {
    fehler.push(
      `${REORDER_POINT_KEY} muss eine ganze Zahl >= 0 sein ` +
        `(ist ${JSON.stringify(m[REORDER_POINT_KEY])})`
    )
  }

  const raw = m[SUPPLIERS_KEY]
  if (raw != null) {
    if (!Array.isArray(raw)) {
      fehler.push(`${SUPPLIERS_KEY} muss eine Liste sein`)
    } else {
      raw.forEach((entry, i) => {
        const wo = `${SUPPLIERS_KEY}[${i}]`
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          fehler.push(`${wo}: Eintrag muss ein Objekt mit name sein`)
          return
        }
        const e = entry as Record<string, unknown>
        if (typeof e.name !== "string" || !e.name.trim()) {
          fehler.push(`${wo}: name fehlt`)
        }
        if (e.url != null && e.url !== "" && !isSafeSupplierUrl(e.url)) {
          fehler.push(
            `${wo}: url muss eine absolute http(s)-Adresse sein ` +
              `(ist «${String(e.url)}»)`
          )
        }
        if (e.article_number != null && typeof e.article_number !== "string") {
          fehler.push(`${wo}: article_number muss ein Text sein`)
        }
      })
    }
  }
  return fehler
}

/**
 * Einen Request-Body rekursiv nach metadata-Objekten absuchen und deren
 * Nachschub-Schlüssel prüfen. Deckt alle Admin-Produktrouten ab — Update
 * einer Variante, Batch-Varianten, Produkt anlegen/ändern mit
 * eingebetteten Varianten — ohne jede Route einzeln zu kennen.
 */
export function sammleNachschubMetadataFehler(
  body: unknown,
  tiefe = 0
): string[] {
  if (tiefe > 6 || !body || typeof body !== "object") {
    return []
  }
  const fehler: string[] = []
  if (Array.isArray(body)) {
    for (const eintrag of body) {
      fehler.push(...sammleNachschubMetadataFehler(eintrag, tiefe + 1))
    }
    return fehler
  }
  for (const [key, value] of Object.entries(body)) {
    if (key === "metadata") {
      fehler.push(...validateNachschubMetadata(value))
    }
    fehler.push(...sammleNachschubMetadataFehler(value, tiefe + 1))
  }
  return fehler
}
