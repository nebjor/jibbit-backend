/**
 * Nachschubsteuerung — gemeinsame, reine Bausteine.
 *
 * Der Betreiber pflegt je Variante in data/catalog.json einen Meldebestand
 * (reorder_point) und seine Bezugsquellen (suppliers); update-catalog.ts
 * schreibt beides in die metadata der Variante. Von dort lesen drei Abnehmer:
 *
 *   - das Admin-Widget an der Produktseite (src/admin/widgets/nachschub-widget.tsx)
 *   - die Admin-Seite «Nachschub»          (src/admin/routes/nachschub/page.tsx)
 *   - der Bericht fürs Terminal            (src/scripts/nachschub-report.ts)
 *
 * Dieses Modul ist bewusst rein (keine Datenbank, kein Medusa-Import): die
 * Admin-Oberfläche bündelt es per Vite mit, die Scripts per tsc, und die
 * Unit-Tests füttern es direkt.
 *
 * SICHERHEIT — die Lieferanten-URL wird im Admin als Link gerendert, und dort
 * sitzt jemand mit vollen Rechten. Die Datei wird von Hand gepflegt, also
 * gilt sie als nicht vertrauenswürdig: isSafeSupplierUrl() lässt NUR http:
 * und https: durch (kein javascript:, data:, vbscript:, keine relativen
 * Angaben). Geprüft wird zweimal — beim Einspielen (validateLieferantenDaten
 * bricht den Import ab) UND beim Rendern (parseLieferanten liefert für alles
 * andere url=null, der Link entfällt). Jeder gerenderte Link trägt zusätzlich
 * rel="noopener noreferrer".
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
  /** davon: keine Bestandsführung (inventory.json quantity=null). */
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

// ─── Prüfung beim Einspielen (catalog.json) ─────────────────────

/** So stehen die Felder in data/catalog.json je Variante. */
export type KatalogLieferant = {
  name: string
  /** Adresse der Produktseite beim Lieferanten — nur http(s) erlaubt. */
  url: string
  /** Artikelnummer beim Lieferanten, optional. */
  article_number?: string | null
}

type KatalogVarianteMitNachschub = {
  label: string
  reorder_point?: number | null
  suppliers?: KatalogLieferant[] | null
}

/**
 * Lieferanten- und Meldebestandsdaten des Katalogs prüfen, BEVOR etwas
 * geschrieben wird — gleiche Mechanik wie die EAN-Prüfung in
 * validateCatalogData(): eine nicht-leere Fehlerliste bricht den Lauf ab.
 * Insbesondere kommt so nie eine javascript:-Adresse in die Datenbank.
 */
export function validateLieferantenDaten(
  catalog: { product: string; variants: KatalogVarianteMitNachschub[] }[]
): string[] {
  const errors: string[] = []
  for (const entry of catalog) {
    for (const v of entry.variants) {
      const where = `${entry.product} (${v.label})`
      if (v.reorder_point != null) {
        if (!Number.isInteger(v.reorder_point) || v.reorder_point < 0) {
          errors.push(
            `${where}: reorder_point muss eine ganze Zahl >= 0 sein ` +
              `(ist ${v.reorder_point})`
          )
        }
      }
      if (v.suppliers == null) {
        continue
      }
      if (!Array.isArray(v.suppliers)) {
        errors.push(`${where}: suppliers muss eine Liste sein`)
        continue
      }
      v.suppliers.forEach((s, i) => {
        const wo = `${where}, Lieferant ${i + 1}`
        if (!s || typeof s !== "object") {
          errors.push(`${wo}: Eintrag muss ein Objekt mit name und url sein`)
          return
        }
        if (typeof s.name !== "string" || !s.name.trim()) {
          errors.push(`${wo}: name fehlt`)
        }
        if (!isSafeSupplierUrl(s.url)) {
          errors.push(
            `${wo}: url muss eine absolute http(s)-Adresse sein ` +
              `(ist «${String((s as { url?: unknown }).url ?? "")}»)`
          )
        }
        if (
          s.article_number != null &&
          (typeof s.article_number !== "string" || !s.article_number.trim())
        ) {
          errors.push(`${wo}: article_number muss ein nicht-leerer String sein`)
        }
      })
    }
  }
  return errors
}

// ─── Metadaten-Abgleich für update-catalog.ts ───────────────────

/** Normalform, in der die Lieferanten in variant.metadata.suppliers liegen. */
function normalisiereLieferanten(
  suppliers: KatalogLieferant[]
): { name: string; url: string; article_number: string | null }[] {
  return suppliers.map((s) => ({
    name: s.name.trim(),
    url: s.url.trim(),
    article_number: s.article_number?.trim() || null,
  }))
}

export type NachschubMetadataUpdate = {
  /** Vollständige, gemergte metadata der Variante (andere Schlüssel überleben). */
  metadata: Record<string, unknown>
  changes: { field: string; before: string; after: string }[]
}

function fmtLieferanten(l: { name: string }[] | null): string {
  return l && l.length ? l.map((s) => s.name).join(", ") : "(leer)"
}

/**
 * Entscheiden, ob und wie variant.metadata für die Nachschubsteuerung
 * nachgezogen werden muss. Gleiche Regeln wie bei EAN/Gewicht/Marke:
 * nur setzen, wenn der Katalog einen Wert hat und er abweicht — fehlende
 * Katalogwerte löschen nie etwas. Rückgabe null = nichts zu tun.
 */
export function nachschubMetadataUpdate(
  existing: Record<string, unknown> | null | undefined,
  wanted: {
    reorder_point?: number | null
    suppliers?: KatalogLieferant[] | null
  }
): NachschubMetadataUpdate | null {
  const changes: NachschubMetadataUpdate["changes"] = []
  const metadata: Record<string, unknown> = { ...(existing ?? {}) }

  if (wanted.reorder_point != null) {
    const have = parseMeldebestand(existing ?? null)
    if (have !== wanted.reorder_point) {
      metadata[REORDER_POINT_KEY] = wanted.reorder_point
      changes.push({
        field: "meldebestand",
        before: have === null ? "(leer)" : String(have),
        after: String(wanted.reorder_point),
      })
    }
  }

  if (wanted.suppliers != null && Array.isArray(wanted.suppliers)) {
    const soll = normalisiereLieferanten(wanted.suppliers)
    const ist = existing?.[SUPPLIERS_KEY]
    if (JSON.stringify(ist ?? null) !== JSON.stringify(soll)) {
      metadata[SUPPLIERS_KEY] = soll
      changes.push({
        field: "lieferanten",
        before: fmtLieferanten(
          Array.isArray(ist) ? (ist as { name: string }[]) : null
        ),
        after: fmtLieferanten(soll),
      })
    }
  }

  return changes.length ? { metadata, changes } : null
}
