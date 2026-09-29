import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { EmailContent } from "../lib/notify"
import { describeError, sendEmail } from "../lib/notify"
import {
  type ShipmentOrderView,
  type ShipmentView,
  renderShippingConfirmation,
} from "../lib/shipping-notification"

/**
 * Versandbestätigung an die Kundin, sobald ein Fulfillment im Admin als
 * versendet markiert wird.
 *
 * `shipment.created` kommt aus Medusas `createOrderShipmentWorkflow`; `id` ist
 * die ID des FULFILLMENTS, nicht der Bestellung. `no_notification` ist der
 * Schalter «Benachrichtigung senden» im Admin, umgekehrt. Nichts hier darf das
 * Versenden im Admin scheitern lassen.
 */

type ShipmentCreatedEvent = {
  id: string
  no_notification?: boolean | null
}

const FULFILLMENT_FIELDS = [
  "id",
  "canceled_at",
  "items.*",
  "labels.*",
  "delivery_address.*",
  "order.id",
]

// Die Menge steht in `items.detail`; die Lagerartikel braucht es, um bei Sets
// die Stückzahl der Sendung richtig zu rechnen.
const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "items.*",
  "items.detail.*",
  "items.variant.inventory_items.required_quantity",
  "items.variant.inventory_items.inventory.id",
  "shipping_address.*",
]

type LoadedShipment = ShipmentView & {
  canceled_at?: unknown
  order?: { id?: string | null } | null
}

export default async function shipmentCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<ShipmentCreatedEvent>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const fulfillmentId = data?.id
  if (!fulfillmentId) {
    logger.warn("[shipment.created] Event ohne Fulfillment-ID — nichts versendet.")
    return
  }
  if (data.no_notification) {
    logger.info(`[shipment.created] Sendung ${fulfillmentId}: Benachrichtigung im Admin abgewählt.`)
    return
  }

  let shipment: LoadedShipment | undefined
  let order: ShipmentOrderView | undefined
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: fulfillments } = await query.graph({
      entity: "fulfillment",
      fields: FULFILLMENT_FIELDS,
      filters: { id: fulfillmentId },
    })
    shipment = fulfillments[0] as unknown as LoadedShipment | undefined
    const orderId = shipment?.order?.id
    if (shipment && orderId) {
      const { data: orders } = await query.graph({
        entity: "order",
        fields: ORDER_FIELDS,
        filters: { id: orderId },
      })
      order = orders[0] as unknown as ShipmentOrderView | undefined
    }
  } catch (err) {
    logger.error(`[shipment.created] Sendung ${fulfillmentId} nicht geladen: ${describeError(err)}`)
    return
  }
  if (!shipment) {
    logger.error(`[shipment.created] Sendung ${fulfillmentId} nicht gefunden.`)
    return
  }
  if (!order) {
    logger.error(`[shipment.created] Sendung ${fulfillmentId}: keine Bestellung dazu gefunden.`)
    return
  }
  if (shipment.canceled_at) {
    logger.warn(`[shipment.created] Sendung ${fulfillmentId} ist storniert — nichts versendet.`)
    return
  }
  if (!order.email) {
    logger.warn(
      `[shipment.created] Bestellung ${order.id} ohne E-Mail — keine Versandbestätigung versendet.`
    )
    return
  }

  let content: EmailContent
  try {
    content = renderShippingConfirmation(shipment, order, {
      storeName: process.env.STORE_NAME || "jibbit",
    })
  } catch (err) {
    logger.error(
      `[shipment.created] Versandbestätigung für ${fulfillmentId} nicht gerendert: ${describeError(err)}`
    )
    return
  }

  await sendEmail(container, {
    to: order.email,
    template: "shipping-confirmation",
    content,
    trigger: "shipment.created",
    resourceId: shipment.id,
    data: { order_id: order.id, fulfillment_id: shipment.id },
    // Feuert das Event für dieselbe Sendung noch einmal, geht keine zweite Mail raus.
    idempotencyKey: `shipping-confirmation:${shipment.id}`,
  })
}

export const config: SubscriberConfig = {
  event: "shipment.created",
}
