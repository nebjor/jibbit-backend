/**
 * Preistabelle (Mengenstaffel) eines Produkts — reine Logik, ohne
 * @medusajs-Importe, damit sie sich isoliert testen lässt.
 *
 * Modell (Entscheid Joris, 2026-09): ein Produkt = EINE Variante = EIN
 * Lagerartikel. Die Preistabelle ist eine Mengenstaffel auf genau dieser
 * Variante: «ab 1 Stk. CHF 1.95, ab 10 Stk. CHF 1.85, ab 24 Stk. CHF 1.40».
 * Der Kunde kauft jede beliebige Menge; der Stückpreis ist der der höchsten
 * Zeile, deren «ab»-Menge erreicht ist.
 *
 * Gespeichert wird die Tabelle NICHT separat, sondern direkt als Medusa-
 * Preiszeilen (price.min_quantity / max_quantity im Pricing-Modul). Genau
 * damit rechnet der Warenkorb — es gibt also keine zweite Quelle, die
 * auseinanderlaufen könnte. Diese Datei übersetzt nur zwischen der
 * Tabelle, wie der Betreiber sie sieht, und den Preiszeilen.
 */

export const PREISTABELLE_CURRENCY = "chf"
export const PREISTABELLE_MAX_ZEILEN = 20

/** Eine Zeile, wie sie im Admin steht: «ab <min_quantity> Stk. → <amount> pro Stk.» */
export type PreisZeile = {
  min_quantity: number
  amount: number
  /** Optional: id eines vorhandenen Produktbilds, z.B. das Foto der 24er-Box. */
  image_id?: string | null
  /** Optional: Bezeichnung im Shop statt «24 Stück», z.B. «24er Display». */
  label?: string | null
}

/**
 * Bild und Bezeichnung je Zeile. Die Preise selbst stehen in Medusas
 * Preiszeilen; nur diese beiden Anzeige-Angaben haben dort keinen Platz und
 * liegen deshalb in product.metadata.preistabelle — geschrieben nur vom
 * Preistabellen-Workflow, zusammen mit den Preisen.
 */
export const PREISTABELLE_METADATA_KEY = "preistabelle"
export const LABEL_MAX = 30

export type StufenExtra = {
  min_quantity: number
  image_id?: string
  label?: string
}

/** Eine Medusa-Preiszeile (Teilmenge dessen, was listPrices/query liefert). */
export type PreisRow = {
  id?: string
  amount: number | string
  currency_code: string
  min_quantity?: number | string | null
  max_quantity?: number | string | null
  price_list_id?: string | null
  rules_count?: number | null
}

export type PreisInput = {
  amount: number
  currency_code: string
  min_quantity: number | null
  max_quantity: number | null
}

const rappen = (n: number) => Math.round(n * 100)

/**
 * Prüft die Eingabe des Betreibers. Liefert deutsche, laienverständliche
 * Fehlermeldungen — leer heisst: in Ordnung.
 */
export function pruefePreistabelle(zeilen: PreisZeile[]): string[] {
  const fehler: string[] = []

  if (!Array.isArray(zeilen) || !zeilen.length) {
    return ["Die Preistabelle braucht mindestens eine Zeile (ab 1 Stück)."]
  }
  if (zeilen.length > PREISTABELLE_MAX_ZEILEN) {
    fehler.push(`Höchstens ${PREISTABELLE_MAX_ZEILEN} Zeilen.`)
  }

  const gesehen = new Set<number>()
  for (const z of zeilen) {
    const menge = Number(z?.min_quantity)
    const preis = Number(z?.amount)
    if (!Number.isInteger(menge) || menge < 1) {
      fehler.push(`«${z?.min_quantity}» ist keine gültige Menge (ganze Zahl ab 1).`)
      continue
    }
    if (gesehen.has(menge)) {
      fehler.push(`Die Menge ${menge} steht doppelt in der Tabelle.`)
    }
    gesehen.add(menge)
    if (z?.label != null && String(z.label).trim().length > LABEL_MAX) {
      fehler.push(`Ab ${menge} Stk.: die Bezeichnung ist länger als ${LABEL_MAX} Zeichen.`)
    }
    if (!Number.isFinite(preis) || preis <= 0) {
      fehler.push(`Ab ${menge} Stk.: der Stückpreis muss grösser als 0 sein.`)
    } else if (Math.abs(preis * 100 - rappen(preis)) > 1e-6) {
      fehler.push(`Ab ${menge} Stk.: höchstens zwei Nachkommastellen (Rappen).`)
    }
  }

  if (!gesehen.has(1)) {
    fehler.push(
      "Es fehlt die Zeile «ab 1 Stück» — ohne sie hat der Artikel keinen Preis für kleine Mengen."
    )
  }

  if (!fehler.length) {
    const sortiert = sortiere(zeilen)
    for (let i = 1; i < sortiert.length; i++) {
      if (rappen(sortiert[i].amount) > rappen(sortiert[i - 1].amount)) {
        fehler.push(
          `Ab ${sortiert[i].min_quantity} Stk. ist der Stückpreis höher als ab ` +
            `${sortiert[i - 1].min_quantity} Stk. — grössere Mengen dürfen nicht teurer sein.`
        )
      }
    }
  }

  return fehler
}

function sortiere(zeilen: PreisZeile[]): PreisZeile[] {
  return zeilen
    .map((z) => ({ min_quantity: Number(z.min_quantity), amount: Number(z.amount) }))
    .sort((a, b) => a.min_quantity - b.min_quantity)
}

/**
 * Tabelle → Medusa-Preiszeilen. Lückenlos, aufsteigend, oberste Zeile nach
 * oben offen. Eine einzige Zeile wird ein ganz normaler Preis ohne Mengen
 * (min/max null) — so sieht er für Medusa und das Standard-Admin aus wie
 * jeder andere Preis.
 */
export function preiseAusTabelle(
  zeilen: PreisZeile[],
  currency: string = PREISTABELLE_CURRENCY
): PreisInput[] {
  const sortiert = sortiere(zeilen)
  if (sortiert.length === 1) {
    return [
      {
        amount: sortiert[0].amount,
        currency_code: currency,
        min_quantity: null,
        max_quantity: null,
      },
    ]
  }
  return sortiert.map((z, i) => ({
    amount: z.amount,
    currency_code: currency,
    min_quantity: z.min_quantity,
    max_quantity: i < sortiert.length - 1 ? sortiert[i + 1].min_quantity - 1 : null,
  }))
}

/** Gehört die Zeile zur Preistabelle (Basispreis in CHF ohne Regeln)? */
export function istTabellenPreis(
  p: PreisRow,
  currency: string = PREISTABELLE_CURRENCY
): boolean {
  return (
    !p.price_list_id &&
    !(Number(p.rules_count ?? 0) > 0) &&
    String(p.currency_code).toLowerCase() === currency
  )
}

/**
 * Medusa-Preiszeilen → Tabelle, plus Hinweise, falls die gespeicherten
 * Zeilen nicht sauber sind (Lücken, Überlappungen, kein Preis ab 1). Solche
 * Daten kommen nur aus Importen oder direkten API-Aufrufen; beim nächsten
 * Speichern aus dem Admin werden sie sauber neu geschrieben.
 */
export function tabelleAusPreisen(
  prices: PreisRow[],
  currency: string = PREISTABELLE_CURRENCY
): { zeilen: PreisZeile[]; hinweise: string[] } {
  const eigene = prices.filter((p) => istTabellenPreis(p, currency))
  const zeilen = eigene
    .map((p) => ({
      min_quantity: Number(p.min_quantity ?? 1) || 1,
      max_quantity:
        p.max_quantity === null || p.max_quantity === undefined
          ? null
          : Number(p.max_quantity),
      amount: Number(p.amount),
    }))
    .sort((a, b) => a.min_quantity - b.min_quantity)

  const hinweise: string[] = []
  if (zeilen.length && zeilen[0].min_quantity !== 1) {
    hinweise.push("Es gibt keinen Preis ab 1 Stück — der Artikel ist so nicht bestellbar.")
  }
  for (let i = 0; i < zeilen.length - 1; i++) {
    const erwartet = zeilen[i + 1].min_quantity - 1
    if (zeilen[i].max_quantity !== erwartet) {
      hinweise.push(
        `Die gespeicherten Staffeln sind nicht lückenlos (bei ${zeilen[i].min_quantity}–` +
          `${zeilen[i].max_quantity ?? "∞"} Stk.). Einmal speichern bereinigt das.`
      )
      break
    }
  }
  if (zeilen.length > 1 && zeilen[zeilen.length - 1].max_quantity !== null) {
    hinweise.push("Die oberste Staffel ist nach oben begrenzt. Einmal speichern bereinigt das.")
  }

  return {
    zeilen: zeilen.map(({ min_quantity, amount }) => ({ min_quantity, amount })),
    hinweise,
  }
}

/**
 * Preise des Price Sets, die NICHT zur Tabelle gehören und beim Speichern
 * erhalten bleiben müssen (andere Währungen, Regionspreise). Medusas
 * updatePriceSets löscht jeden Basispreis, der nicht mitgeschickt wird —
 * deshalb werden sie mit ihrer id unverändert zurückgeschickt.
 * Preislisten-Preise sind davon nicht betroffen (die fasst Medusa hier nie an).
 */
export function zuBehaltendePreise(
  prices: PreisRow[],
  currency: string = PREISTABELLE_CURRENCY
): (PreisInput & { id: string })[] {
  return prices
    .filter((p) => !p.price_list_id && p.id && !istTabellenPreis(p, currency))
    .map((p) => ({
      id: p.id as string,
      amount: Number(p.amount),
      currency_code: p.currency_code,
      min_quantity:
        p.min_quantity === null || p.min_quantity === undefined ? null : Number(p.min_quantity),
      max_quantity:
        p.max_quantity === null || p.max_quantity === undefined ? null : Number(p.max_quantity),
    }))
}

/**
 * Hat die Variante eine Mengenstaffel? Dann würde das Standard-Preisraster
 * des Admins (eine Zelle je Währung) die Staffel beim Speichern löschen.
 */
export function hatStaffel(
  prices: PreisRow[],
  currency: string = PREISTABELLE_CURRENCY
): boolean {
  return prices.filter((p) => istTabellenPreis(p, currency)).length > 1
}

/**
 * Enthält ein Admin-Request Preise für Varianten, ohne selbst Mengen
 * anzugeben? So sieht der Request des Standard-Preisrasters aus. Liefert die
 * Varianten-IDs, deren Preise damit überschrieben würden (leer = harmlos).
 */
export function variantenMitRasterPreisen(body: unknown): string[] {
  const ids: string[] = []
  const pruefe = (v: any) => {
    if (!v || typeof v !== "object" || !Array.isArray(v.prices)) return
    const mitMengen = v.prices.some(
      (p: any) =>
        p && (p.min_quantity !== undefined && p.min_quantity !== null ||
          p.max_quantity !== undefined && p.max_quantity !== null)
    )
    if (!mitMengen) ids.push(typeof v.id === "string" ? v.id : "")
  }
  const b = body as any
  if (!b || typeof b !== "object") return ids
  // POST /admin/products/:id/variants/:variant_id
  pruefe(b)
  // POST /admin/products/:id/variants/batch
  for (const v of Array.isArray(b.update) ? b.update : []) pruefe(v)
  // POST /admin/products/:id  (variants: [...])
  for (const v of Array.isArray(b.variants) ? b.variants : []) pruefe(v)
  return ids
}

/** Nur Zeilen mit Bild oder Bezeichnung — die landen in der Produkt-Metadata. */
export function stufenExtras(zeilen: PreisZeile[]): StufenExtra[] {
  return zeilen
    .map((z) => {
      const extra: StufenExtra = { min_quantity: Number(z.min_quantity) }
      const label = typeof z.label === "string" ? z.label.trim() : ""
      if (typeof z.image_id === "string" && z.image_id.trim()) extra.image_id = z.image_id.trim()
      if (label) extra.label = label
      return extra
    })
    .filter((e) => e.image_id || e.label)
    .sort((a, b) => a.min_quantity - b.min_quantity)
}

/** Liest die Extras aus der Metadata (unvalidiertes JSON — defensiv). */
export function leseStufenExtras(
  metadata: Record<string, unknown> | null | undefined
): StufenExtra[] {
  const raw = (metadata?.[PREISTABELLE_METADATA_KEY] as any)?.stufen
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e: any) => e && Number.isInteger(Number(e.min_quantity)))
    .map((e: any) => ({
      min_quantity: Number(e.min_quantity),
      ...(typeof e.image_id === "string" && e.image_id ? { image_id: e.image_id } : {}),
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    }))
}

/**
 * Neue Produkt-Metadata: bestehende Schlüssel (brand, suppliers, …) bleiben
 * unangetastet, nur `preistabelle` wird ersetzt bzw. entfernt. Nötig, weil
 * Medusa metadata beim Update als Ganzes ersetzt.
 */
export function metadataMitExtras(
  bestehend: Record<string, unknown> | null | undefined,
  extras: StufenExtra[]
): Record<string, unknown> {
  const neu: Record<string, unknown> = { ...(bestehend ?? {}) }
  delete neu[PREISTABELLE_METADATA_KEY]
  if (extras.length) neu[PREISTABELLE_METADATA_KEY] = { stufen: extras }
  return neu
}

/** Bild-ids, die nicht (mehr) am Produkt hängen — Fehlermeldungen für den Betreiber. */
export function pruefeBilder(zeilen: PreisZeile[], produktBildIds: string[]): string[] {
  const bekannt = new Set(produktBildIds)
  return stufenExtras(zeilen)
    .filter((e) => e.image_id && !bekannt.has(e.image_id))
    .map(
      (e) => `Ab ${e.min_quantity} Stk.: das gewählte Bild gehört nicht (mehr) zu diesem Produkt.`
    )
}
