/**
 * Preistabelle eines Produkts — reine Logik ohne @medusajs-Importe.
 *
 * Ein Produkt = eine Variante. Gespeichert wird in Medusas eigenen Preisen:
 *   - Basispreis der Variante  = regulärer Preis (eine Zeile, im Shop durchgestrichen)
 *   - Preisliste «Aktionspreise …» (Typ sale; Titel aus der Shop-Konfiguration) = die Staffel
 *     «ab Menge → Stückpreis» (price.min_quantity/max_quantity)
 * Medusa wählt pro Menge die passende Staffel und liefert original_amount
 * (regulär) und calculated_amount (Aktion) — der Warenkorb rechnet damit.
 */

import { getShopConfig } from "./shop-config"

export const PREISTABELLE_CURRENCY = "chf"
export const PREISTABELLE_MAX_ZEILEN = 20
export const PREISTABELLE_METADATA_KEY = "preistabelle"
export const LABEL_MAX = 30

/**
 * Titel aus SHOP_PRICE_LIST_TITLE (jibbit-Default «Aktionspreise jibbit.ch»).
 * Bestehende Preislisten werden per Titel gefunden — den Wert also nie ändern,
 * ohne die Liste in der Datenbank mit umzubenennen.
 */
export function aktionspreisliste() {
  return {
    title: getShopConfig().priceListTitle,
    description: "Mengenstaffeln aus der Preistabelle der Produkte",
  }
}

export type PreisZeile = {
  min_quantity: number
  amount: number
  /** Optional: id eines Produktbilds, z.B. das Foto der 24er-Box. */
  image_id?: string | null
  /** Optional: Bezeichnung im Shop statt «24 Stück». */
  label?: string | null
}

export type Preistabelle = {
  regulaerer_preis?: number | null
  zeilen: PreisZeile[]
}

export type StufenExtra = {
  min_quantity: number
  image_id?: string
  label?: string
}

/** Teilmenge einer Medusa-Preiszeile. */
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
const hatRappenGenauigkeit = (n: number) => Math.abs(n * 100 - rappen(n)) < 1e-6
const zahlOderNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))

function sortiere(zeilen: PreisZeile[]): PreisZeile[] {
  return zeilen
    .map((z) => ({ min_quantity: Number(z.min_quantity), amount: Number(z.amount) }))
    .sort((a, b) => a.min_quantity - b.min_quantity)
}

export function pruefePreistabelle({ regulaerer_preis, zeilen }: Preistabelle): string[] {
  if (!Array.isArray(zeilen) || !zeilen.length) {
    return ["Die Preistabelle braucht mindestens eine Zeile (ab 1 Stück)."]
  }
  const fehler: string[] = []
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
    if (gesehen.has(menge)) fehler.push(`Die Menge ${menge} steht doppelt in der Tabelle.`)
    gesehen.add(menge)
    if (z?.label != null && String(z.label).trim().length > LABEL_MAX) {
      fehler.push(`Ab ${menge} Stk.: die Bezeichnung ist länger als ${LABEL_MAX} Zeichen.`)
    }
    if (!Number.isFinite(preis) || preis <= 0) {
      fehler.push(`Ab ${menge} Stk.: der Stückpreis muss grösser als 0 sein.`)
    } else if (!hatRappenGenauigkeit(preis)) {
      fehler.push(`Ab ${menge} Stk.: höchstens zwei Nachkommastellen (Rappen).`)
    }
  }
  if (!gesehen.has(1)) {
    fehler.push("Es fehlt die Zeile «ab 1 Stück» — ohne sie hat der Artikel keinen Preis.")
  }
  if (fehler.length) return fehler

  const sortiert = sortiere(zeilen)
  for (let i = 1; i < sortiert.length; i++) {
    if (rappen(sortiert[i].amount) > rappen(sortiert[i - 1].amount)) {
      fehler.push(
        `Ab ${sortiert[i].min_quantity} Stk. ist der Stückpreis höher als ab ` +
          `${sortiert[i - 1].min_quantity} Stk. — grössere Mengen dürfen nicht teurer sein.`
      )
    }
  }

  if (regulaerer_preis != null) {
    const r = Number(regulaerer_preis)
    if (!Number.isFinite(r) || r <= 0 || !hatRappenGenauigkeit(r)) {
      fehler.push("Der reguläre Preis muss ein Betrag in Franken und Rappen sein.")
    } else if (rappen(r) < rappen(sortiert[0].amount)) {
      fehler.push("Der reguläre Preis darf nicht tiefer sein als der Preis ab 1 Stück.")
    }
  }
  return fehler
}

/** Basispreis der Variante: der reguläre Preis, ohne ihn der Preis ab 1 Stück. */
export function basisPreis(t: Preistabelle, currency = PREISTABELLE_CURRENCY): PreisInput {
  return {
    amount: Number(t.regulaerer_preis ?? sortiere(t.zeilen)[0].amount),
    currency_code: currency,
    min_quantity: null,
    max_quantity: null,
  }
}

/**
 * Staffel für die Aktionspreisliste: lückenlos, oberste Zeile offen. Ein
 * einziger Preis ohne regulären Preis braucht keine Liste — er steht dann
 * nur als Basispreis.
 */
export function staffelPreise(t: Preistabelle, currency = PREISTABELLE_CURRENCY): PreisInput[] {
  const sortiert = sortiere(t.zeilen)
  if (sortiert.length === 1 && t.regulaerer_preis == null) return []
  return sortiert.map((z, i) => ({
    amount: z.amount,
    currency_code: currency,
    min_quantity: z.min_quantity,
    max_quantity: i < sortiert.length - 1 ? sortiert[i + 1].min_quantity - 1 : null,
  }))
}

const istChfOhneRegeln = (p: PreisRow, currency: string) =>
  !(Number(p.rules_count ?? 0) > 0) && String(p.currency_code).toLowerCase() === currency

/**
 * Medusa-Preise → Tabelle. `basis` sind die Basispreise der Variante,
 * `liste` ihre Preise in der Aktionspreisliste.
 */
export function tabelleAusPreisen(
  basis: PreisRow[],
  liste: PreisRow[],
  currency = PREISTABELLE_CURRENCY
): Preistabelle & { hinweise: string[] } {
  const zeilenAus = (rows: PreisRow[]) =>
    rows
      .filter((p) => istChfOhneRegeln(p, currency))
      .map((p) => ({
        min_quantity: Number(p.min_quantity ?? 1) || 1,
        max_quantity: zahlOderNull(p.max_quantity),
        amount: Number(p.amount),
      }))
      .sort((a, b) => a.min_quantity - b.min_quantity)

  const basisZeilen = zeilenAus(basis.filter((p) => !p.price_list_id))
  const staffel = zeilenAus(liste)
  const zeilen = staffel.length ? staffel : basisZeilen
  const hinweise: string[] = []

  if (staffel.length && basisZeilen.length > 1) {
    hinweise.push("Der Basispreis enthält noch alte Staffeln. Einmal speichern bereinigt das.")
  }
  if (zeilen.length && zeilen[0].min_quantity !== 1) {
    hinweise.push("Es gibt keinen Preis ab 1 Stück — der Artikel ist so nicht bestellbar.")
  }
  const luecke = zeilen.findIndex(
    (z, i) => i < zeilen.length - 1 && z.max_quantity !== zeilen[i + 1].min_quantity - 1
  )
  if (luecke >= 0 || (zeilen.length > 1 && zeilen[zeilen.length - 1].max_quantity !== null)) {
    hinweise.push("Die gespeicherten Staffeln sind nicht lückenlos. Einmal speichern bereinigt das.")
  }

  const regulaer = staffel.length && basisZeilen.length ? basisZeilen[0].amount : null
  return {
    regulaerer_preis: regulaer !== null && regulaer > (zeilen[0]?.amount ?? 0) ? regulaer : null,
    zeilen: zeilen.map(({ min_quantity, amount }) => ({ min_quantity, amount })),
    hinweise,
  }
}

/**
 * Basispreise, die nicht zur Tabelle gehören (andere Währungen, Regionspreise).
 * Medusa löscht beim Speichern jeden Basispreis, der nicht mitgeschickt wird —
 * diese gehen deshalb mit ihrer id unverändert zurück.
 */
export function zuBehaltendePreise(
  basis: PreisRow[],
  currency = PREISTABELLE_CURRENCY
): (PreisInput & { id: string })[] {
  return basis
    .filter((p) => !p.price_list_id && p.id && !istChfOhneRegeln(p, currency))
    .map((p) => ({
      id: p.id as string,
      amount: Number(p.amount),
      currency_code: p.currency_code,
      min_quantity: zahlOderNull(p.min_quantity),
      max_quantity: zahlOderNull(p.max_quantity),
    }))
}

/** Zeilen mit Bild oder Bezeichnung — die landen in der Produkt-Metadata. */
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

/** Ersetzt nur `preistabelle` — Medusa überschreibt metadata beim Update als Ganzes. */
export function metadataMitExtras(
  bestehend: Record<string, unknown> | null | undefined,
  extras: StufenExtra[]
): Record<string, unknown> {
  const neu: Record<string, unknown> = { ...(bestehend ?? {}) }
  delete neu[PREISTABELLE_METADATA_KEY]
  if (extras.length) neu[PREISTABELLE_METADATA_KEY] = { stufen: extras }
  return neu
}

export function pruefeBilder(zeilen: PreisZeile[], produktBildIds: string[]): string[] {
  const bekannt = new Set(produktBildIds)
  return stufenExtras(zeilen)
    .filter((e) => e.image_id && !bekannt.has(e.image_id))
    .map((e) => `Ab ${e.min_quantity} Stk.: das gewählte Bild gehört nicht (mehr) zu diesem Produkt.`)
}

/**
 * Preis-ids, die ein Batch-Request auf eine Preisliste ändert oder löscht,
 * ohne selbst Mengen zu nennen — so sieht das Standard-Preisraster des
 * Admins aus, das je Währung nur eine Zelle kennt.
 */
export function listenpreisIdsOhneMengen(body: unknown): string[] {
  const b = body as { update?: unknown; delete?: unknown } | null
  if (!b || typeof b !== "object") return []
  const updates = Array.isArray(b.update) ? b.update : []
  const ohneMengen = updates
    .filter(
      (u: any) => u && typeof u.id === "string" && u.min_quantity == null && u.max_quantity == null
    )
    .map((u: any) => u.id as string)
  const geloescht = Array.isArray(b.delete)
    ? b.delete.filter((id): id is string => typeof id === "string")
    : []
  return [...ohneMengen, ...geloescht]
}

/**
 * Soll-Staffel gegen die gespeicherten Listenpreise, abgeglichen über die
 * «ab»-Menge. Medusa legt beim Batch-Create einen Preis mit gleicher Menge
 * auf die bestehende Zeile — neu anlegen und alt löschen zugleich würde die
 * Zeile deshalb entfernen.
 */
export function staffelAenderungen(soll: PreisInput[], ist: PreisRow[], variantId: string) {
  const istNachMenge = new Map(ist.map((p) => [Number(p.min_quantity ?? 1), p]))
  const create: (PreisInput & { variant_id: string })[] = []
  const update: (PreisInput & { id: string; variant_id: string })[] = []
  for (const p of soll) {
    const alt = istNachMenge.get(Number(p.min_quantity ?? 1))
    if (alt?.id) {
      update.push({ ...p, id: alt.id, variant_id: variantId })
      istNachMenge.delete(Number(p.min_quantity ?? 1))
    } else {
      create.push({ ...p, variant_id: variantId })
    }
  }
  return { create, update, delete: [...istNachMenge.values()].map((p) => p.id as string) }
}
