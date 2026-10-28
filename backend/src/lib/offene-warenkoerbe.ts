/**
 * Offene Warenkörbe (carts ohne completed_at, mit mindestens einer Position)
 * für das Admin — reine Funktionen, ohne Datenbankzugriff, damit sie sich
 * ohne Medusa-Instanz testen lassen.
 */

export const STANDARD_LIMIT = 20
export const MAX_LIMIT = 100

export type WarenkorbFilter = {
  limit: number
  offset: number
  /** Nur Warenkörbe mit hinterlegter E-Mail-Adresse. */
  nurMitEmail: boolean
  /** Nur Warenkörbe, die seit mindestens so vielen Stunden ruhen. */
  mindestAlterStunden: number | null
}

function zahl(wert: unknown): number | null {
  if (typeof wert !== "string" || wert.trim() === "") return null
  const n = Number(wert)
  return Number.isFinite(n) ? n : null
}

/** Liest limit/offset/nur_mit_email/min_alter_stunden aus der Query-String-Map. */
export function parseWarenkorbFilter(q: Record<string, unknown>): WarenkorbFilter {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(zahl(q.limit) ?? STANDARD_LIMIT)))
  const offset = Math.max(0, Math.floor(zahl(q.offset) ?? 0))
  const alter = zahl(q.min_alter_stunden)
  return {
    limit,
    offset,
    nurMitEmail: q.nur_mit_email === "true" || q.nur_mit_email === "1",
    mindestAlterStunden: alter !== null && alter > 0 ? alter : null,
  }
}

type Betrag = number | string | { value?: string | number } | null | undefined

function betrag(b: Betrag): number {
  if (b === null || b === undefined) return 0
  if (typeof b === "object") return Number(b.value ?? 0) || 0
  return Number(b) || 0
}

/** Rohdaten aus query.graph("cart") — nur die Felder, die wir lesen. */
export type RohWarenkorb = {
  id: string
  created_at: string | Date
  updated_at: string | Date
  email?: string | null
  currency_code?: string | null
  region?: { name?: string | null } | null
  customer?: {
    id?: string
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  } | null
  items?: Array<{
    id: string
    title?: string | null
    product_title?: string | null
    variant_title?: string | null
    variant_sku?: string | null
    quantity?: number | null
    unit_price?: Betrag
    thumbnail?: string | null
  } | null> | null
  shipping_address?: { city?: string | null; country_code?: string | null } | null
  payment_collection?: { payment_sessions?: Array<{ id: string } | null> | null } | null
  subtotal?: Betrag
  total?: Betrag
}

export function formatiereWarenkorb(c: RohWarenkorb) {
  const items = (c.items ?? []).filter((i): i is NonNullable<typeof i> => !!i)
  const kunde = c.customer
  const name = [kunde?.first_name, kunde?.last_name].filter(Boolean).join(" ") || null
  const kasseBegonnen = !!c.payment_collection?.payment_sessions?.some((s) => !!s)

  return {
    id: c.id,
    created_at: c.created_at,
    updated_at: c.updated_at,
    email: c.email || kunde?.email || null,
    customer: kunde?.id
      ? { id: kunde.id, name, email: kunde.email ?? null }
      : null,
    region: c.region?.name ?? null,
    currency_code: c.currency_code ?? null,
    item_count: items.reduce((summe, i) => summe + (i.quantity ?? 0), 0),
    items: items.map((i) => ({
      id: i.id,
      title: i.product_title || i.title || "",
      variant_title: i.variant_title ?? null,
      sku: i.variant_sku ?? null,
      quantity: i.quantity ?? 0,
      unit_price: betrag(i.unit_price),
      thumbnail: i.thumbnail ?? null,
    })),
    subtotal: betrag(c.subtotal),
    total: betrag(c.total),
    shipping_city: c.shipping_address?.city ?? null,
    shipping_country: c.shipping_address?.country_code ?? null,
    checkout_started: kasseBegonnen,
    status: kasseBegonnen ? "kasse_begonnen" : "nur_warenkorb",
  }
}

export type OffenerWarenkorb = ReturnType<typeof formatiereWarenkorb>
