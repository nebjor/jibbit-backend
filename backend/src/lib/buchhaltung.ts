/**
 * Buchhaltungs-Berichte (Admin-Seite «Buchhaltung») — reine Funktionen ohne
 * Datenbankzugriff, damit sich alles ohne Medusa-Instanz testen lässt.
 *
 * 1. Lagerbestand per Stichtag, bewertet zum Einstandspreis.
 *    Medusa 2.13 führt KEIN Bewegungsjournal: ein Inventory-Level kennt nur
 *    den aktuellen Stand (stocked_quantity). Beim Erstellen einer Fulfillment
 *    wird stocked_quantity sofort um die versandte Menge verringert, beim
 *    Stornieren der Fulfillment wieder erhöht. Für vergangene Stichtage
 *    rechnen wir deshalb vom heutigen Stand zurück:
 *      Bestand(Stichtag) = Bestand(heute)
 *        + Mengen aus Fulfillments, die NACH dem Stichtag erstellt und nicht
 *          storniert wurden,
 *        - Mengen aus Fulfillments, die VOR dem Stichtag erstellt, aber erst
 *          NACH dem Stichtag storniert wurden (Ware war am Stichtag draussen).
 *    Nicht rekonstruierbar: manuelle Bestandskorrekturen, Wareneingänge,
 *    Retouren und Inventuren nach dem Stichtag. Dafür gibt es die gespeicherten
 *    Stichtags-Schnappschüsse (src/lib/buchhaltung-snapshots.ts).
 *    «Stichtag» heisst: Ende des Tages (24:00) in Europe/Zurich.
 *
 * 2. Umsatz pro Jahr: bezahlte Bestellungen nach Bestelldatum (Definition
 *    «bezahlt» wie im Verkaufs-Dashboard), plus eine Zahlungsliste nach
 *    Zahlungsdatum (Captures/Rückerstattungen) für die Ist-Versteuerung.
 *
 * CSV: UTF-8 mit BOM, Trennzeichen Semikolon, Dezimalpunkt, CRLF.
 */
import {
  betrag,
  istBezahlt,
  kundenName,
  monatsSchluessel,
  parseGrenze,
  rappen,
  RohBestellung,
  summeRueckerstattungen,
  ZEITZONE,
  zuerichMitternacht,
} from "./dashboard-verkauf"
import type { Betrag } from "./dashboard-verkauf"

/** Schlüssel in variant.metadata: Einstandspreis pro Stück in CHF. */
export const EINSTANDSPREIS_KEY = "einstandspreis"

// ---------------------------------------------------------------- Zeit

const tagFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZEITZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const zeitFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZEITZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

/** Kalendertag «YYYY-MM-DD» in Zürcher Zeit. */
export function zuerichTag(ms: number): string {
  return tagFormat.format(new Date(ms))
}

/** «YYYY-MM-DD HH:mm» in Zürcher Zeit. */
export function zuerichZeit(ms: number): string {
  return zeitFormat.format(new Date(ms)).replace(", ", " ")
}

const NUR_DATUM = /^\d{4}-\d{2}-\d{2}$/

export type StichtagGueltig = { stichtag: string; grenze: number; heute: boolean }
export type StichtagInfo = StichtagGueltig | { fehler: string }

/**
 * Prüft den Stichtag (nur «YYYY-MM-DD»). `grenze` = Beginn des Folgetags
 * (Zürich), also das Ende des Stichtags. Zukünftige Tage sind ungültig;
 * der heutige Tag zählt als «jetzt» (Live-Bestand).
 */
export function pruefeStichtag(
  stichtag: string | undefined,
  jetzt: number = Date.now()
): StichtagInfo {
  const heute = zuerichTag(jetzt)
  const tag = stichtag || heute
  if (!NUR_DATUM.test(tag)) return { fehler: "«stichtag» muss das Format JJJJ-MM-TT haben." }
  const grenze = parseGrenze(tag, true)
  if (grenze === null) return { fehler: "«stichtag» ist kein gültiges Datum." }
  if (tag > heute) return { fehler: "«stichtag» darf nicht in der Zukunft liegen." }
  return { stichtag: tag, grenze, heute: tag === heute }
}

/** [von, bis) des Kalenderjahres in Zürcher Zeit. */
export function jahresGrenzen(jahr: number): { von: number; bis: number } {
  return { von: zuerichMitternacht(jahr, 1, 1), bis: zuerichMitternacht(jahr + 1, 1, 1) }
}

// ----------------------------------------------------------------- CSV

/**
 * Eine Zelle als CSV-Text. Zahlen: Dezimalpunkt, ohne Tausendertrenner.
 * Text mit Semikolon, Anführungszeichen oder Zeilenumbruch wird in
 * Anführungszeichen gesetzt (" verdoppelt). Text, der mit = + - @ oder Tab
 * beginnt, bekommt ein vorangestelltes ' (Schutz vor Formeln in Excel).
 */
export function csvZelle(wert: string | number | null | undefined): string {
  if (wert === null || wert === undefined) return ""
  if (typeof wert === "number") return Number.isFinite(wert) ? String(wert) : ""
  let s = wert
  // Reine Zahlen (auch negativ, z. B. «-15.00») sind keine Formeln.
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** Betrag mit genau zwei Nachkommastellen und Dezimalpunkt («12.50»). */
export function geldText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return ""
  return (Math.round(n * 100) / 100).toFixed(2)
}

export const CSV_BOM = "﻿"

/** Komplettes CSV-Dokument: BOM, Kopfzeile, CRLF, Semikolon. */
export function csvDokument(
  kopf: string[],
  zeilen: Array<Array<string | number | null | undefined>>
): string {
  const alle = [kopf, ...zeilen].map((z) => z.map(csvZelle).join(";"))
  return CSV_BOM + alle.join("\r\n") + "\r\n"
}

// ------------------------------------------------- Einstandspreis lesen

/**
 * variant.metadata.einstandspreis defensiv lesen: Zahl >= 0 oder Text wie
 * «1.85» / «1,85» / «CHF 1.85». Alles andere (leer, negativ, Text) = null,
 * also «Einstandspreis fehlt».
 */
export function leseEinstandspreis(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  const roh = metadata?.[EINSTANDSPREIS_KEY]
  let n: number
  if (typeof roh === "number") n = roh
  else if (typeof roh === "string") {
    const t = roh.replace(/^\s*CHF\s*/i, "").replace(/['’\s]/g, "").replace(",", ".")
    if (!/^\d+(\.\d+)?$/.test(t)) return null
    n = Number(t)
  } else return null
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

// --------------------------------------------------- Lagerbestand

export type RohVariante = {
  id: string
  sku?: string | null
  barcode?: string | null
  ean?: string | null
  title?: string | null
  manage_inventory?: boolean | null
  metadata?: Record<string, unknown> | null
  product?: { id?: string; title?: string | null } | null
  inventory_items?: Array<{
    inventory_item_id?: string | null
    required_quantity?: Betrag
  } | null> | null
}

export type RohLevel = {
  inventory_item_id: string
  location_id: string
  stocked_quantity?: Betrag
}

export type RohFulfillment = {
  id: string
  location_id?: string | null
  created_at: string | Date
  canceled_at?: string | Date | null
  items?: Array<{
    inventory_item_id?: string | null
    quantity?: Betrag
  } | null> | null
}

const levelSchluessel = (item: string, ort: string) => `${item}|${ort}`

/**
 * Bestand je (Lagerartikel, Lagerort) zum Stichtag: aktueller Stand,
 * zurückgerechnet über Fulfillments (siehe Kopfkommentar). Ohne `grenze`
 * (Live-Bestand) wird nichts zurückgerechnet.
 */
export function bestandZumStichtag(
  levels: RohLevel[],
  fulfillments: RohFulfillment[],
  grenze: number | null
): Map<string, number> {
  const karte = new Map<string, number>()
  for (const l of levels) {
    const k = levelSchluessel(l.inventory_item_id, l.location_id)
    karte.set(k, (karte.get(k) ?? 0) + betrag(l.stocked_quantity))
  }
  if (grenze === null) return karte
  for (const f of fulfillments) {
    if (!f.location_id) continue
    const erstellt = new Date(f.created_at).getTime()
    const storniert = f.canceled_at ? new Date(f.canceled_at).getTime() : null
    let vorzeichen = 0
    if (erstellt >= grenze) vorzeichen = storniert === null ? 1 : 0
    else if (storniert !== null && storniert >= grenze) vorzeichen = -1
    if (!vorzeichen) continue
    for (const i of f.items ?? []) {
      if (!i?.inventory_item_id) continue
      const k = levelSchluessel(i.inventory_item_id, f.location_id)
      // Nur Orte mit Level zählen — sonst entstünde ein Phantombestand.
      if (!karte.has(k)) continue
      karte.set(k, (karte.get(k) ?? 0) + vorzeichen * betrag(i.quantity))
    }
  }
  return karte
}

export type LagerPosition = {
  variant_id: string
  sku: string
  gtin: string
  produkt: string
  variante: string
  /** Bestand zum Stichtag (kann bei Rückrechnung negativ ausfallen). */
  menge: number
  /** Heutiger Bestand, zum Vergleich. */
  menge_heute: number
  einstandspreis: number | null
  /** menge × einstandspreis; null, wenn der Einstandspreis fehlt. */
  wert: number | null
  /** false: manage_inventory ist aus, Menge ist nur der gezählte Stand. */
  bestand_verwaltet: boolean
}

export type LagerSumme = {
  positionen: number
  stueck: number
  wert: number
  ohne_einstandspreis: number
  stueck_ohne_einstandspreis: number
  negativ: number
  nicht_verwaltet: number
}

export type LagerAntwort = {
  stichtag: string
  /** true: heutiger Live-Stand, keine Rückrechnung. */
  live: boolean
  summe: LagerSumme
  positionen: LagerPosition[]
  hinweise: string[]
}

/**
 * Lagerbestand je Variante. Eine Variante mit mehreren Lagerartikeln
 * (Stückliste) zählt so viele Einheiten, wie der knappste Artikel hergibt
 * (Bestand ÷ required_quantity, abgerundet). Varianten ohne Lagerartikel
 * erscheinen nicht (kein Bestand geführt) und werden in den Hinweisen gezählt.
 */
export function berechneLagerbestand(
  varianten: RohVariante[],
  levels: RohLevel[],
  fulfillments: RohFulfillment[],
  info: StichtagGueltig
): LagerAntwort {
  const damals = bestandZumStichtag(levels, fulfillments, info.heute ? null : info.grenze)
  const heute = bestandZumStichtag(levels, [], null)

  const summeFuer = (karte: Map<string, number>, itemId: string) => {
    let s = 0
    for (const [k, v] of karte) if (k.startsWith(`${itemId}|`)) s += v
    return s
  }
  const einheiten = (karte: Map<string, number>, v: RohVariante): number => {
    const items = (v.inventory_items ?? []).filter((i) => i?.inventory_item_id)
    let min = Infinity
    for (const i of items) {
      const req = betrag(i!.required_quantity) || 1
      min = Math.min(min, Math.floor(summeFuer(karte, i!.inventory_item_id!) / req))
    }
    return min === Infinity ? 0 : min
  }

  const positionen: LagerPosition[] = []
  let ohneLagerartikel = 0
  for (const v of varianten) {
    const hatArtikel = (v.inventory_items ?? []).some((i) => i?.inventory_item_id)
    if (!hatArtikel) {
      ohneLagerartikel++
      continue
    }
    const menge = einheiten(damals, v)
    const ek = leseEinstandspreis(v.metadata)
    positionen.push({
      variant_id: v.id,
      sku: v.sku ?? "",
      gtin: v.barcode || v.ean || "",
      produkt: v.product?.title ?? "",
      variante: v.title ?? "",
      menge,
      menge_heute: einheiten(heute, v),
      einstandspreis: ek,
      wert: ek === null ? null : rappen(Math.max(0, menge) * ek),
      bestand_verwaltet: v.manage_inventory !== false,
    })
  }
  positionen.sort(
    (a, b) =>
      a.produkt.localeCompare(b.produkt, "de") ||
      a.variante.localeCompare(b.variante, "de") ||
      a.sku.localeCompare(b.sku, "de")
  )

  const summe: LagerSumme = {
    positionen: positionen.length,
    stueck: 0,
    wert: 0,
    ohne_einstandspreis: 0,
    stueck_ohne_einstandspreis: 0,
    negativ: 0,
    nicht_verwaltet: 0,
  }
  for (const p of positionen) {
    summe.stueck += Math.max(0, p.menge)
    if (p.wert === null) {
      summe.ohne_einstandspreis++
      summe.stueck_ohne_einstandspreis += Math.max(0, p.menge)
    } else summe.wert += p.wert
    if (p.menge < 0) summe.negativ++
    if (!p.bestand_verwaltet) summe.nicht_verwaltet++
  }
  summe.wert = rappen(summe.wert)

  const hinweise: string[] = []
  if (!info.heute) {
    hinweise.push(
      "Rückgerechnet aus dem heutigen Bestand und den Versandmengen nach dem Stichtag. Manuelle Bestandskorrekturen, Wareneingänge und Retouren nach dem Stichtag sind nicht berücksichtigt."
    )
  }
  if (summe.ohne_einstandspreis > 0) {
    hinweise.push(
      `Einstandspreis fehlt bei ${summe.ohne_einstandspreis} Positionen (${summe.stueck_ohne_einstandspreis} Stück): der Gesamtwert ist unvollständig.`
    )
  }
  if (summe.negativ > 0) {
    hinweise.push(
      `${summe.negativ} Positionen ergeben einen negativen Bestand und werden mit 0 bewertet — vermutlich wurde der Bestand nach dem Stichtag korrigiert.`
    )
  }
  if (summe.nicht_verwaltet > 0) {
    hinweise.push(
      `${summe.nicht_verwaltet} Positionen haben «Bestand verwalten» aus: ihre Menge sinkt beim Verkauf nicht von selbst.`
    )
  }
  if (ohneLagerartikel > 0) {
    hinweise.push(`${ohneLagerartikel} Varianten ohne Lagerartikel sind nicht aufgeführt.`)
  }
  return { stichtag: info.stichtag, live: info.heute, summe, positionen, hinweise }
}

export const LAGER_KOPF = [
  "Stichtag",
  "Produkt",
  "Variante",
  "SKU",
  "GTIN",
  "Menge",
  "Einstandspreis CHF",
  "Wert CHF",
  "Hinweis",
]

export type CsvPosition = Pick<
  LagerPosition,
  "sku" | "gtin" | "produkt" | "variante" | "menge" | "einstandspreis" | "wert"
>

/** CSV des Lagerbestands; fehlender Einstandspreis = leere Zellen + Hinweis. */
export function lagerCsv(
  stichtag: string,
  positionen: CsvPosition[],
  summe: { stueck: number; wert: number }
): string {
  const zeilen: Array<Array<string | number | null>> = positionen.map((p) => [
    stichtag,
    p.produkt,
    p.variante,
    p.sku,
    p.gtin,
    p.menge,
    p.einstandspreis === null ? "" : geldText(p.einstandspreis),
    p.wert === null ? "" : geldText(p.wert),
    p.einstandspreis === null ? "Einstandspreis fehlt" : p.menge < 0 ? "Bestand negativ" : "",
  ])
  zeilen.push([stichtag, "Total", "", "", "", summe.stueck, "", geldText(summe.wert), ""])
  return csvDokument(LAGER_KOPF, zeilen)
}

// ------------------------------------------------------------- Umsatz

type RohZahlung = {
  id?: string | null
  provider_id?: string | null
  captures?: Array<{ amount?: Betrag; created_at?: string | Date | null } | null> | null
  refunds?: Array<{ amount?: Betrag; created_at?: string | Date | null } | null> | null
}

export type RohBestellungBuch = Omit<RohBestellung, "payment_collections"> & {
  payment_collections?: Array<{
    status?: string | null
    payments?: Array<RohZahlung | null> | null
  } | null> | null
}

/** Zusätzliche Felder (zu BESTELL_FELDER) für Anbieter und Zahlungsdaten. */
export const BUCHHALTUNG_ZUSATZFELDER = [
  "payment_collections.payments.id",
  "payment_collections.payments.provider_id",
  "payment_collections.payments.captures.created_at",
  "payment_collections.payments.refunds.created_at",
]

export type UmsatzMonat = {
  monat: string
  bestellungen: number
  waren: number
  versand: number
  brutto: number
  rueckerstattungen: number
  netto: number
}

export type UmsatzBestellung = {
  id: string
  nummer: string
  datum: string
  kunde: string
  email: string
  waren: number
  versand: number
  total: number
  rueckerstattet: number
  anbieter: string
  zahlungs_ids: string
}

export type Zahlungsposten = {
  datum: string
  typ: "Zahlung" | "Rückerstattung"
  bestellung: string
  /** Rückerstattungen negativ. */
  betrag: number
  anbieter: string
  zahlungs_id: string
  bestellstatus: string
}

const zeitpunkt = (b: { created_at: string | Date }) => new Date(b.created_at).getTime()

const zahlungen = (b: RohBestellungBuch): RohZahlung[] =>
  (b.payment_collections ?? []).flatMap(
    (pc) => (pc?.payments ?? []).filter(Boolean) as RohZahlung[]
  )

function nummer(b: RohBestellungBuch): string {
  return b.display_id != null ? String(b.display_id) : b.id
}

/** Bezahlte Bestellungen mit Bestelldatum im Jahr (Zürcher Zeit), nach Datum. */
export function bezahlteImJahr(
  bestellungen: RohBestellungBuch[],
  jahr: number
): RohBestellungBuch[] {
  const { von, bis } = jahresGrenzen(jahr)
  return bestellungen
    .filter((b) => istBezahlt(b as RohBestellung) && zeitpunkt(b) >= von && zeitpunkt(b) < bis)
    .sort((a, b) => zeitpunkt(a) - zeitpunkt(b) || nummer(a).localeCompare(nummer(b)))
}

/**
 * Zwölf Monate (auch leere) plus Jahressumme. Rückerstattungen werden dem
 * Monat der Bestellung zugeordnet (wie im Verkaufs-Dashboard).
 */
export function umsatzProMonat(
  bestellungen: RohBestellungBuch[],
  jahr: number
): { monate: UmsatzMonat[]; summe: UmsatzMonat } {
  const leer = (monat: string): UmsatzMonat => ({
    monat,
    bestellungen: 0,
    waren: 0,
    versand: 0,
    brutto: 0,
    rueckerstattungen: 0,
    netto: 0,
  })
  const monate = Array.from({ length: 12 }, (_, i) =>
    leer(`${jahr}-${String(i + 1).padStart(2, "0")}`)
  )
  for (const b of bezahlteImJahr(bestellungen, jahr)) {
    const m = monate.find((x) => x.monat === monatsSchluessel(zeitpunkt(b)))
    if (!m) continue
    const total = betrag(b.total)
    const versand = betrag(b.shipping_total)
    m.bestellungen++
    m.brutto += total
    m.versand += versand
    m.waren += total - versand
    m.rueckerstattungen += summeRueckerstattungen(b as RohBestellung)
  }
  const summe = leer(String(jahr))
  for (const m of monate) {
    m.netto = m.brutto - m.rueckerstattungen
    summe.bestellungen += m.bestellungen
    summe.waren += m.waren
    summe.versand += m.versand
    summe.brutto += m.brutto
    summe.rueckerstattungen += m.rueckerstattungen
  }
  summe.netto = summe.brutto - summe.rueckerstattungen
  for (const m of [...monate, summe]) {
    m.waren = rappen(m.waren)
    m.versand = rappen(m.versand)
    m.brutto = rappen(m.brutto)
    m.rueckerstattungen = rappen(m.rueckerstattungen)
    m.netto = rappen(m.netto)
  }
  return { monate, summe }
}

/** Alle bezahlten Bestellungen des Jahres als Liste. */
export function umsatzBestellungen(
  bestellungen: RohBestellungBuch[],
  jahr: number
): UmsatzBestellung[] {
  return bezahlteImJahr(bestellungen, jahr).map((b) => {
    const total = betrag(b.total)
    const versand = betrag(b.shipping_total)
    const z = zahlungen(b)
    return {
      id: b.id,
      nummer: nummer(b),
      datum: zuerichTag(zeitpunkt(b)),
      kunde: kundenName(b as RohBestellung),
      email: b.customer?.email || b.email || "",
      waren: rappen(total - versand),
      versand: rappen(versand),
      total: rappen(total),
      rueckerstattet: rappen(summeRueckerstattungen(b as RohBestellung)),
      anbieter: [...new Set(z.map((p) => p.provider_id).filter(Boolean))].join(" | "),
      zahlungs_ids: z
        .map((p) => p.id)
        .filter(Boolean)
        .join(" | "),
    }
  })
}

export const UMSATZ_KOPF = [
  "Bestellung",
  "Datum",
  "Kunde",
  "E-Mail",
  "Waren CHF",
  "Versand CHF",
  "Total CHF",
  "Rückerstattet CHF",
  "Netto CHF",
  "Zahlungsanbieter",
  "Zahlungs-ID",
]

/** CSV aller bezahlten Bestellungen des Jahres, mit Summenzeile. */
export function umsatzCsv(liste: UmsatzBestellung[]): string {
  const zeilen: Array<Array<string | number | null>> = liste.map((b) => [
    b.nummer,
    b.datum,
    b.kunde,
    b.email,
    geldText(b.waren),
    geldText(b.versand),
    geldText(b.total),
    geldText(b.rueckerstattet),
    geldText(b.total - b.rueckerstattet),
    b.anbieter,
    b.zahlungs_ids,
  ])
  const s = (f: (b: UmsatzBestellung) => number) => geldText(liste.reduce((a, b) => a + f(b), 0))
  zeilen.push([
    "Total",
    "",
    "",
    "",
    s((b) => b.waren),
    s((b) => b.versand),
    s((b) => b.total),
    s((b) => b.rueckerstattet),
    s((b) => b.total - b.rueckerstattet),
    "",
    "",
  ])
  return csvDokument(UMSATZ_KOPF, zeilen)
}

/**
 * Zahlungsliste nach Zahlungsdatum: Captures und Rückerstattungen, deren
 * Datum (Zürcher Zeit) ins Jahr fällt — unabhängig vom Bestelldatum und vom
 * Bestellstatus (eingegangenes Geld ist eingegangen). Captures/Refunds ohne
 * Datum fallen auf das Bestelldatum zurück.
 */
export function zahlungsposten(bestellungen: RohBestellungBuch[], jahr: number): Zahlungsposten[] {
  const { von, bis } = jahresGrenzen(jahr)
  const aus: Zahlungsposten[] = []
  const ms = (d: string | Date | null | undefined, b: RohBestellungBuch) =>
    d ? new Date(d).getTime() : zeitpunkt(b)
  for (const b of bestellungen) {
    for (const p of zahlungen(b)) {
      const basis = {
        bestellung: nummer(b),
        anbieter: p.provider_id ?? "",
        zahlungs_id: p.id ?? "",
        bestellstatus: b.status ?? "",
      }
      for (const c of p.captures ?? []) {
        const t = ms(c?.created_at, b)
        if (c && t >= von && t < bis) {
          aus.push({
            ...basis,
            datum: zuerichZeit(t),
            typ: "Zahlung",
            betrag: rappen(betrag(c.amount)),
          })
        }
      }
      for (const r of p.refunds ?? []) {
        const t = ms(r?.created_at, b)
        if (r && t >= von && t < bis) {
          aus.push({
            ...basis,
            datum: zuerichZeit(t),
            typ: "Rückerstattung",
            betrag: -rappen(betrag(r.amount)),
          })
        }
      }
    }
  }
  return aus.sort(
    (a, b) => a.datum.localeCompare(b.datum) || a.bestellung.localeCompare(b.bestellung)
  )
}

export function zahlungsSumme(posten: Zahlungsposten[]) {
  let eingaenge = 0
  let rueck = 0
  for (const p of posten) {
    if (p.typ === "Zahlung") eingaenge += p.betrag
    else rueck += -p.betrag
  }
  return {
    anzahl: posten.length,
    eingaenge: rappen(eingaenge),
    rueckerstattungen: rappen(rueck),
    saldo: rappen(eingaenge - rueck),
  }
}

export const ZAHLUNGEN_KOPF = [
  "Datum",
  "Art",
  "Bestellung",
  "Betrag CHF",
  "Zahlungsanbieter",
  "Zahlungs-ID",
  "Bestellstatus",
]

export function zahlungenCsv(posten: Zahlungsposten[]): string {
  const zeilen: Array<Array<string | number | null>> = posten.map((p) => [
    p.datum,
    p.typ,
    p.bestellung,
    geldText(p.betrag),
    p.anbieter,
    p.zahlungs_id,
    p.bestellstatus,
  ])
  zeilen.push(["Saldo", "", "", geldText(zahlungsSumme(posten).saldo), "", "", ""])
  return csvDokument(ZAHLUNGEN_KOPF, zeilen)
}
