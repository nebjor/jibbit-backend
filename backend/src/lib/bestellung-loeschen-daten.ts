/**
 * Lesen und Schreiben für «Bestellung endgültig löschen». Regeln: siehe
 * `bestellung-loeschen.ts`; hier steht, was einen Container braucht.
 * `query.graph` blendet weich gelöschte Zeilen standardmässig aus — dasselbe
 * gilt für Dashboard und Buchhaltung, die ebenfalls `query.graph` nutzen.
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import type { BestellLage } from "./bestellung-loeschen"

const FELDER = [
  "id",
  "display_id",
  "status",
  "items.id",
  "fulfillments.id",
  "fulfillments.location_id",
  "fulfillments.canceled_at",
  "fulfillments.shipped_at",
  "fulfillments.items.line_item_id",
  "fulfillments.items.inventory_item_id",
  "fulfillments.items.quantity",
  "payment_collections.currency_code",
  "payment_collections.payments.id",
  "payment_collections.payments.currency_code",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.refunds.amount",
]

export type BestellRohdaten = {
  id: string
  display_id: number
  status: string
  items?: { id: string }[] | null
  fulfillments?:
    | {
        id: string
        location_id?: string | null
        canceled_at?: string | Date | null
        shipped_at?: string | Date | null
        items?:
          | { line_item_id: string; inventory_item_id?: string | null; quantity: unknown }[]
          | null
      }[]
    | null
  payment_collections?:
    | {
        currency_code?: string | null
        payments?:
          | {
              id: string
              currency_code?: string | null
              captures?: { amount: unknown }[] | null
              refunds?: { amount: unknown }[] | null
            }[]
          | null
      }[]
    | null
}

/** Beträge kommen je nach Quelle als Zahl, Text oder BigNumber-Objekt. */
const zahl = (v: unknown): number => {
  const roh = typeof v === "object" && v !== null && "value" in v ? (v as { value: unknown }).value : v
  const n = Number(roh)
  return Number.isFinite(n) ? n : 0
}
const summe = (l?: { amount: unknown }[] | null) => (l ?? []).reduce((s, x) => s + zahl(x.amount), 0)

export function bestellLageAusRohdaten(o: BestellRohdaten): BestellLage {
  return {
    id: o.id,
    display_id: o.display_id,
    status: o.status,
    line_item_ids: (o.items ?? []).map((i) => i.id),
    lieferungen: (o.fulfillments ?? []).map((f) => ({
      id: f.id,
      location_id: f.location_id ?? null,
      canceled_at: f.canceled_at ?? null,
      shipped_at: f.shipped_at ?? null,
      items: (f.items ?? []).map((p) => ({
        line_item_id: p.line_item_id,
        inventory_item_id: p.inventory_item_id ?? null,
        quantity: zahl(p.quantity),
      })),
    })),
    zahlungen: (o.payment_collections ?? []).flatMap((pc) =>
      (pc.payments ?? []).map((p) => ({
        id: p.id,
        erfasst: summe(p.captures),
        erstattet: summe(p.refunds),
        currency_code: p.currency_code ?? pc.currency_code ?? null,
      }))
    ),
  }
}

export async function ladeBestellLage(
  container: MedusaContainer,
  orderId: string
): Promise<BestellLage> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: FELDER, filters: { id: orderId } })
  const o = data[0] as unknown as BestellRohdaten | undefined
  if (!o) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Bestellung ${orderId} nicht gefunden.`)
  }
  return bestellLageAusRohdaten(o)
}

/** Weiches Löschen samt Wiederherstellung (für das Zurückrollen). */
export async function loescheBestellungWeich(container: MedusaContainer, orderId: string) {
  await container.resolve(Modules.ORDER).softDeleteOrders([orderId])
}
export async function stelleBestellungWiederHer(container: MedusaContainer, orderId: string) {
  await container.resolve(Modules.ORDER).restoreOrders([orderId])
}
