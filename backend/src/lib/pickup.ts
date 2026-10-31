/**
 * Abholung im Laden («Abholung im Laden»).
 *
 * Die Abholung ist in Medusa eine gewöhnliche Shipping Option mit Preis 0
 * (flat) auf derselben Service-Zone wie der Versand. Erkannt wird sie NIE am
 * Namen, sondern an drei Markern, die alle dasselbe sagen:
 *
 *   1. `shipping_method.data.pickup === true` — stempelt der Provider beim
 *      Hinzufügen zum Warenkorb (`validateFulfillmentData`, siehe
 *      src/modules/swiss-shipping/service.ts), die Storefront schickt es
 *      zusätzlich mit. Wandert mit der Bestellung mit (completeCart kopiert
 *      `data`), darum der schnellste Weg.
 *   2. `order.metadata.pickup === true` — setzt die Storefront auf den Cart,
 *      Medusa kopiert die Cart-Metadaten auf die Bestellung.
 *   3. Die Shipping Option selbst: `type.code === "pickup"` oder
 *      `metadata.pickup === true`. Das ist die Quelle, falls jemand die Option
 *      im Admin ohne `data` neu anlegt — dafür braucht es eine zweite Abfrage
 *      (`resolvePickup`).
 *
 * Adresse und Abholzeiten stehen in der Shop-Konfiguration (Env), weil die Mails sie
 * brauchen und die Option in der Datenbank nur eine Zeile Freitext trägt. Die
 * Storefront hält dieselben Angaben in `lib/config.ts` (`PICKUP`, `BUSINESS`).
 * Ändert sich eine davon, müssen beide Orte mit — wie beim Versandtarif.
 */

import type { Logger } from "@medusajs/framework/types"

export const PICKUP_TYPE_CODE = "pickup"

/** Fulfillment-Option des swiss-shipping-Providers, siehe getFulfillmentOptions(). */
export const PICKUP_FULFILLMENT_OPTION_ID = "swiss-pickup"

// Adresse und Öffnungszeiten kommen aus der Shop-Konfiguration
// (SHOP_PICKUP_ADDRESS, SHOP_PICKUP_HOURS), siehe ./shop-config.ts.

export interface PickupShippingMethod {
  shipping_option_id?: string | null
  data?: Record<string, unknown> | null
}

export interface PickupOrderLike {
  metadata?: Record<string, unknown> | null
  shipping_methods?: Array<PickupShippingMethod | null> | null
}

export interface PickupShippingOptionLike {
  id?: string | null
  data?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  type?: { code?: string | null } | null
}

function flag(record: Record<string, unknown> | null | undefined): boolean {
  const value = record?.["pickup"]
  return value === true || value === "true"
}

/** Wahr, wenn die Shipping Option die Abholung ist (Marker 1 und 3, ohne Datenbank). */
export function isPickupShippingOption(option: PickupShippingOptionLike | null | undefined): boolean {
  if (!option) return false
  return (
    option.type?.code === PICKUP_TYPE_CODE ||
    flag(option.metadata) ||
    flag(option.data) ||
    option.data?.["id"] === PICKUP_FULFILLMENT_OPTION_ID
  )
}

/**
 * Wahr, wenn die Bestellung (oder der Cart) selbst schon sagt, dass sie
 * abgeholt wird — Marker 1 und 2. Braucht keine Datenbank.
 */
export function isPickupOrder(order: PickupOrderLike | null | undefined): boolean {
  if (!order) return false
  if (flag(order.metadata)) return true
  return (order.shipping_methods ?? []).some((method) => flag(method?.data))
}

interface QueryLike {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }) => Promise<{ data: unknown[] }>
}

/**
 * Abholung ja/nein für eine geladene Bestellung. Erst die Marker an der
 * Bestellung; sagen die nichts, werden die Shipping Options der
 * Versandmethoden nachgeladen (Marker 3). Scheitert die Abfrage, gilt
 * «kein Abholauftrag» — eine Versandmail ist dann falsch beschriftet, aber
 * sie geht raus; nichts hier darf eine Mail verhindern.
 */
export async function resolvePickup(
  query: QueryLike,
  order: PickupOrderLike,
  logger?: Pick<Logger, "warn">
): Promise<boolean> {
  if (isPickupOrder(order)) return true

  const optionIds = (order.shipping_methods ?? [])
    .map((method) => method?.shipping_option_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  if (!optionIds.length) return false

  try {
    const { data } = await query.graph({
      entity: "shipping_option",
      fields: ["id", "data", "metadata", "type.code"],
      filters: { id: optionIds },
    })
    return (data as PickupShippingOptionLike[]).some(isPickupShippingOption)
  } catch (err) {
    logger?.warn(
      `[pickup] Shipping Options ${optionIds.join(", ")} nicht geladen — Bestellung gilt als Versand: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return false
  }
}
