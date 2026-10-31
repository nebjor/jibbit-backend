import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { getShopConfig } from "../lib/shop-config"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describeError, sendEmail } from "../lib/notify"
import {
  type CanceledOrderView,
  renderOrderCanceled,
  renderOrderCanceledNotification,
} from "../lib/order-canceled-notification"
import { orderNotificationRecipients } from "../lib/order-notification"

/**
 * Storno-Mail an die Kundin und kurze Meldung an den Betreiber.
 *
 * `order.canceled` kommt aus Medusas `cancelOrderWorkflow` und trägt nur die
 * ID der Bestellung. Ein `no_notification` kennt dieses Event in 2.13.6 nicht;
 * sollte es je mitkommen, wird es beachtet. Nichts hier darf das Stornieren
 * im Admin scheitern lassen.
 */

type OrderCanceledEvent = {
  id: string
  no_notification?: boolean | null
}

// Die Menge steht in `items.detail`. Abbuchungen und Rückerstattungen braucht
// es für den Satz zur Zahlung.
const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "items.*",
  "items.detail.*",
  "shipping_address.*",
  "payment_collections.id",
  "payment_collections.payments.id",
  "payment_collections.payments.captures.id",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.refunds.id",
  "payment_collections.payments.refunds.amount",
]

export default async function orderCanceledHandler({
  event: { data },
  container,
}: SubscriberArgs<OrderCanceledEvent>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = data?.id
  if (!orderId) {
    logger.warn("[order.canceled] Event ohne Bestell-ID — nichts versendet.")
    return
  }

  let order: CanceledOrderView | undefined
  try {
    const { data: orders } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: orderId },
    })
    order = orders[0] as unknown as CanceledOrderView | undefined
  } catch (err) {
    logger.error(`[order.canceled] Bestellung ${orderId} nicht geladen: ${describeError(err)}`)
    return
  }
  if (!order) {
    logger.error(`[order.canceled] Bestellung ${orderId} nicht gefunden.`)
    return
  }

  const current = order
  const mail = { trigger: "order.canceled", resourceId: current.id, data: { order_id: current.id } }

  // Der Betreiber erfährt es immer, auch wenn die Kundin keine Mail bekommt.
  const tasks: Array<() => Promise<unknown>> = orderNotificationRecipients(
    process.env.ORDER_NOTIFICATION_TO
  ).map(
    (to, index) => async () =>
      sendEmail(container, {
        ...mail,
        to,
        template: "order-canceled-notification",
        content: renderOrderCanceledNotification(current, {
          backendUrl: process.env.MEDUSA_BACKEND_URL || "http://localhost:9000",
        }),
        // Position statt Adresse: Der Schlüssel steht in der Datenbank.
        idempotencyKey: `order-canceled-notification:${current.id}:${index}`,
      })
  )

  if (data.no_notification) {
    logger.info(`[order.canceled] Bestellung ${current.id}: Benachrichtigung abgewählt.`)
  } else if (!current.email) {
    logger.warn(`[order.canceled] Bestellung ${current.id} ohne E-Mail — keine Storno-Mail versendet.`)
  } else {
    tasks.push(async () =>
      sendEmail(container, {
        ...mail,
        to: current.email as string,
        template: "order-canceled",
        content: renderOrderCanceled(current, { storeName: getShopConfig().storeName }),
        // Eine Bestellung wird nur einmal storniert; ein wiederholtes Event
        // löst keine zweite Mail aus.
        idempotencyKey: `order-canceled:${current.id}`,
      })
    )
  }

  const results = await Promise.allSettled(tasks.map((task) => task()))
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error(
        `[order.canceled] Benachrichtigung für ${current.id} fehlgeschlagen: ${describeError(result.reason)}`
      )
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
