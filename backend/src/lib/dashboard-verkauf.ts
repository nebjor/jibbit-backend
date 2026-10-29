/**
 * Verkaufs-Dashboard (Admin-Seite «Verkauf») — reine Funktionen ohne
 * Datenbankzugriff, damit sich die Auswertung ohne Medusa-Instanz testen lässt.
 *
 * Definition «bezahlt» (nur solche Bestellungen zählen):
 *  - Status der Bestellung ist nicht «canceled», UND
 *  - die Zahlung ist erfasst: Summe aller Captures (payments[].captures[])
 *    ist > 0, oder eine Payment-Collection hat den Status «captured»/«completed».
 * Beträge sind Endpreise in CHF (der Shop ist nicht MwSt-pflichtig).
 * «Umsatz brutto» = Summe von order.total der bezahlten Bestellungen;
 * Rückerstattungen (refunds) werden separat ausgewiesen, «Umsatz netto» =
 * brutto minus Rückerstattungen. Rückerstattungen werden dem Monat der
 * ursprünglichen Bestellung zugeordnet.
 * Monate und Tagesgrenzen gelten in der Zeitzone Europe/Zurich.
 */

export const ZEITZONE = "Europe/Zurich"
export const STANDARD_TAGE = 30
export const MAX_BESTELLUNGEN = 5000
export const SEITENGROESSE = 100
export const TOP_LIMIT = 10

export type Betrag = number | string | { value?: string | number } | null | undefined

export function betrag(b: Betrag): number {
  if (b === null || b === undefined) return 0
  if (typeof b === "object") return Number(b.value ?? 0) || 0
  return Number(b) || 0
}

/** Rundet auf Rappen. */
export function rappen(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------- Zeit

const teileFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZEITZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

function zonenTeile(ms: number) {
  const t: Record<string, number> = {}
  for (const p of teileFormat.formatToParts(new Date(ms))) {
    if (p.type !== "literal") t[p.type] = Number(p.value)
  }
  return t
}

/** Versatz Zürich − UTC in Millisekunden zum Zeitpunkt ms. */
function zonenVersatz(ms: number): number {
  const t = zonenTeile(ms)
  return (
    Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) -
    Math.floor(ms / 1000) * 1000
  )
}

/** Lokale Mitternacht (Zürich) des Kalendertags als UTC-Millisekunden. */
export function zuerichMitternacht(jahr: number, monat: number, tag: number): number {
  const roh = Date.UTC(jahr, monat - 1, tag)
  let ms = roh - zonenVersatz(roh)
  ms = roh - zonenVersatz(ms)
  return ms
}

/** Monatsschlüssel «YYYY-MM» in Zürcher Zeit. */
export function monatsSchluessel(ms: number): string {
  const t = zonenTeile(ms)
  return `${t.year}-${String(t.month).padStart(2, "0")}`
}

function naechsterMonat(schluessel: string): string {
  const [j, m] = schluessel.split("-").map(Number)
  return m === 12 ? `${j + 1}-01` : `${j}-${String(m + 1).padStart(2, "0")}`
}

const NUR_DATUM = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Liest ein Datum (ISO). Reines Datum «YYYY-MM-DD» = Zürcher Mitternacht;
 * bei `ende` der Beginn des Folgetags (Grenze exklusiv, Tag inklusive).
 */
export function parseGrenze(wert: string, ende: boolean): number | null {
  const m = NUR_DATUM.exec(wert)
  if (m) {
    const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const pruefung = new Date(Date.UTC(j, mo - 1, t))
    if (pruefung.getUTCMonth() !== mo - 1 || pruefung.getUTCDate() !== t) return null
    if (!ende) return zuerichMitternacht(j, mo, t)
    // Folgetag über den UTC-Kalender bestimmen (kein Zeitzonenproblem).
    const f = new Date(Date.UTC(j, mo - 1, t + 1))
    return zuerichMitternacht(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate())
  }
  const ms = Date.parse(wert)
  return Number.isFinite(ms) ? ms : null
}

export type Zeitraum = { von: number; bis: number }
export type ZeitraumMitVorher = Zeitraum & { vorher: Zeitraum }
export type ZeitraumFehler = { fehler: string }

/**
 * Zeitraum aus von/bis (beide optional). Standard: die letzten 30 Tage bis
 * jetzt. Intervall [von, bis). Der Vorzeitraum hat dieselbe Länge und endet
 * bei `von`.
 */
export function bestimmeZeitraum(
  von: string | undefined,
  bis: string | undefined,
  jetzt: number = Date.now()
): ZeitraumMitVorher | ZeitraumFehler {
  const b = bis ? parseGrenze(bis, true) : jetzt
  if (b === null) return { fehler: "«bis» ist kein gültiges Datum." }
  const v = von ? parseGrenze(von, false) : b - STANDARD_TAGE * 86_400_000
  if (v === null) return { fehler: "«von» ist kein gültiges Datum." }
  if (v >= b) return { fehler: "«von» muss vor «bis» liegen." }
  const laenge = b - v
  return { von: v, bis: b, vorher: { von: v - laenge, bis: v } }
}

// ------------------------------------------------------------ Rohdaten

type Person = { first_name?: string | null; last_name?: string | null }

/** Rohdaten aus query.graph("order") — nur die Felder, die wir lesen. */
export type RohBestellung = {
  id: string
  display_id?: number | null
  created_at: string | Date
  status?: string | null
  email?: string | null
  total?: Betrag
  shipping_total?: Betrag
  customer?: (Person & { email?: string | null }) | null
  shipping_address?: Person | null
  items?: Array<{
    quantity?: Betrag
    title?: string | null
    product_title?: string | null
    product_id?: string | null
    variant_id?: string | null
    unit_price?: Betrag
    total?: Betrag
  } | null> | null
  payment_collections?: Array<{
    status?: string | null
    payments?: Array<{
      captures?: Array<{ amount?: Betrag } | null> | null
      refunds?: Array<{ amount?: Betrag } | null> | null
    } | null> | null
  } | null> | null
}

/** Felder für query.graph — hier, damit Route und Auswertung zusammenpassen. */
export const BESTELL_FELDER = [
  "id",
  "display_id",
  "created_at",
  "status",
  "email",
  "total",
  "shipping_total",
  "customer.first_name",
  "customer.last_name",
  "customer.email",
  "shipping_address.first_name",
  "shipping_address.last_name",
  "items.quantity",
  "items.title",
  "items.product_title",
  "items.product_id",
  "items.variant_id",
  "items.unit_price",
  "items.total",
  "payment_collections.status",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.refunds.amount",
]

export function summeCaptures(b: RohBestellung): number {
  let s = 0
  for (const pc of b.payment_collections ?? []) {
    for (const p of pc?.payments ?? []) {
      for (const c of p?.captures ?? []) s += betrag(c?.amount)
    }
  }
  return s
}

export function summeRueckerstattungen(b: RohBestellung): number {
  let s = 0
  for (const pc of b.payment_collections ?? []) {
    for (const p of pc?.payments ?? []) {
      for (const r of p?.refunds ?? []) s += betrag(r?.amount)
    }
  }
  return s
}

/** «Bezahlt», siehe Kopfkommentar. */
export function istBezahlt(b: RohBestellung): boolean {
  if (b.status === "canceled") return false
  if (summeCaptures(b) > 0) return true
  return (b.payment_collections ?? []).some(
    (pc) => pc?.status === "captured" || pc?.status === "completed"
  )
}

// ----------------------------------------------------------- Auswertung

export type Kennzahlen = {
  bestellungen: number
  umsatz_brutto: number
  rueckerstattungen: number
  umsatz_netto: number
  /** Brutto-Umsatz geteilt durch Anzahl bezahlter Bestellungen. */
  durchschnitt_auftrag: number
  stueck_gesamt: number
  durchschnitt_stueck: number
  /** Brutto-Umsatz ohne Versand. */
  warenwert: number
  versand: number
  gratis_versand_anzahl: number
  /** 0..1 */
  gratis_versand_anteil: number
}

export type TopBestellung = {
  id: string
  display_id: number | null
  kunde: string
  created_at: string
  total: number
}

export type TopProdukt = { schluessel: string; titel: string; menge: number; umsatz: number }

export type Monat = { monat: string; bestellungen: number; umsatz: number }

function zeit(b: RohBestellung): number {
  return new Date(b.created_at).getTime()
}

export function kundenName(b: RohBestellung): string {
  const name = (a?: Person | null) =>
    [a?.first_name, a?.last_name].filter(Boolean).join(" ").trim()
  return name(b.customer) || name(b.shipping_address) || b.customer?.email || b.email || "Gast"
}

export function berechneKennzahlen(bezahlt: RohBestellung[]): Kennzahlen {
  let brutto = 0
  let rueck = 0
  let stueck = 0
  let versand = 0
  let gratis = 0
  for (const b of bezahlt) {
    brutto += betrag(b.total)
    rueck += summeRueckerstattungen(b)
    const v = betrag(b.shipping_total)
    versand += v
    if (v === 0) gratis++
    for (const i of b.items ?? []) stueck += betrag(i?.quantity)
  }
  const n = bezahlt.length
  return {
    bestellungen: n,
    umsatz_brutto: rappen(brutto),
    rueckerstattungen: rappen(rueck),
    umsatz_netto: rappen(brutto - rueck),
    durchschnitt_auftrag: n ? rappen(brutto / n) : 0,
    stueck_gesamt: stueck,
    durchschnitt_stueck: n ? Math.round((stueck / n) * 100) / 100 : 0,
    warenwert: rappen(brutto - versand),
    versand: rappen(versand),
    gratis_versand_anzahl: gratis,
    gratis_versand_anteil: n ? gratis / n : 0,
  }
}

/** Veränderung in Prozent gegenüber dem Vorzeitraum; null, wenn dieser 0 war. */
export function veraenderung(aktuell: number, vorher: number): number | null {
  if (!vorher) return null
  return Math.round(((aktuell - vorher) / vorher) * 1000) / 10
}

/** Monatsreihe für [von, bis) inklusive leerer Monate. */
export function monatsReihe(bezahlt: RohBestellung[], z: Zeitraum): Monat[] {
  const reihe = new Map<string, Monat>()
  const letzter = monatsSchluessel(z.bis - 1)
  for (let m = monatsSchluessel(z.von); ; m = naechsterMonat(m)) {
    reihe.set(m, { monat: m, bestellungen: 0, umsatz: 0 })
    if (m === letzter || reihe.size > 1200) break
  }
  for (const b of bezahlt) {
    const eintrag = reihe.get(monatsSchluessel(zeit(b)))
    if (!eintrag) continue
    eintrag.bestellungen++
    eintrag.umsatz += betrag(b.total)
  }
  return [...reihe.values()].map((m) => ({ ...m, umsatz: rappen(m.umsatz) }))
}

export function topBestellungen(bezahlt: RohBestellung[], limit = TOP_LIMIT): TopBestellung[] {
  return [...bezahlt]
    .sort((a, b) => betrag(b.total) - betrag(a.total) || zeit(b) - zeit(a))
    .slice(0, limit)
    .map((b) => ({
      id: b.id,
      display_id: b.display_id ?? null,
      kunde: kundenName(b),
      created_at: new Date(b.created_at).toISOString(),
      total: rappen(betrag(b.total)),
    }))
}

export function topProdukte(
  bezahlt: RohBestellung[],
  limit = TOP_LIMIT
): { nach_umsatz: TopProdukt[]; nach_menge: TopProdukt[] } {
  const karte = new Map<string, TopProdukt>()
  for (const b of bezahlt) {
    for (const i of b.items ?? []) {
      if (!i) continue
      const titel = i.product_title || i.title || "Unbenannt"
      const schluessel = i.product_id || i.variant_id || titel
      const menge = betrag(i.quantity)
      const umsatz =
        i.total !== undefined && i.total !== null
          ? betrag(i.total)
          : betrag(i.unit_price) * menge
      const e = karte.get(schluessel) ?? { schluessel, titel, menge: 0, umsatz: 0 }
      e.menge += menge
      e.umsatz += umsatz
      karte.set(schluessel, e)
    }
  }
  const alle = [...karte.values()].map((p) => ({ ...p, umsatz: rappen(p.umsatz) }))
  const nachTitel = (a: TopProdukt, b: TopProdukt) => a.titel.localeCompare(b.titel, "de")
  return {
    nach_umsatz: [...alle].sort((a, b) => b.umsatz - a.umsatz || nachTitel(a, b)).slice(0, limit),
    nach_menge: [...alle].sort((a, b) => b.menge - a.menge || nachTitel(a, b)).slice(0, limit),
  }
}

export type DashboardAntwort = {
  zeitraum: { von: string; bis: string }
  vorzeitraum: { von: string; bis: string }
  aktuell: Kennzahlen
  vorher: Kennzahlen
  aenderung: {
    bestellungen: number | null
    umsatz: number | null
    durchschnitt_auftrag: number | null
  }
  monate: Monat[]
  top_bestellungen: TopBestellung[]
  top_produkte_umsatz: TopProdukt[]
  top_produkte_menge: TopProdukt[]
  /** true, wenn MAX_BESTELLUNGEN erreicht wurde — Zahlen dann unvollständig. */
  abgeschnitten: boolean
  geladen: number
}

/**
 * Wertet alle geladenen Bestellungen aus (Zeitraum + Vorzeitraum zusammen);
 * die Zuordnung erfolgt über created_at.
 */
export function werteAus(
  bestellungen: RohBestellung[],
  z: ZeitraumMitVorher,
  abgeschnitten = false
): DashboardAntwort {
  const bezahlt = bestellungen.filter(istBezahlt)
  const imZeitraum = (r: Zeitraum) =>
    bezahlt.filter((b) => zeit(b) >= r.von && zeit(b) < r.bis)
  const jetzt = imZeitraum(z)
  const aktuell = berechneKennzahlen(jetzt)
  const vorher = berechneKennzahlen(imZeitraum(z.vorher))
  const top = topProdukte(jetzt)
  const iso = (r: Zeitraum) => ({
    von: new Date(r.von).toISOString(),
    bis: new Date(r.bis).toISOString(),
  })
  return {
    zeitraum: iso(z),
    vorzeitraum: iso(z.vorher),
    aktuell,
    vorher,
    aenderung: {
      bestellungen: veraenderung(aktuell.bestellungen, vorher.bestellungen),
      umsatz: veraenderung(aktuell.umsatz_brutto, vorher.umsatz_brutto),
      durchschnitt_auftrag: veraenderung(aktuell.durchschnitt_auftrag, vorher.durchschnitt_auftrag),
    },
    monate: monatsReihe(jetzt, z),
    top_bestellungen: topBestellungen(jetzt),
    top_produkte_umsatz: top.nach_umsatz,
    top_produkte_menge: top.nach_menge,
    abgeschnitten,
    geladen: bestellungen.length,
  }
}
