import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describeError, sendEmail, sendPush } from "../lib/notify"
import {
  type OrderMailSettings,
  type OrderView,
  orderNotificationRecipients,
  renderOrderConfirmation,
  renderOrderNotification,
  renderOrderPush,
} from "../lib/order-notification"

/**
 * Bei jeder Bestellung: Bestätigung an die Kundin, Mail an den Betreiber,
 * Push über ntfy. Nichts davon darf die Bestellung scheitern lassen.
 */

// Die Menge steht in `items.detail`, und die Totale rechnet Medusa nur richtig,
// wenn Positionen samt Steuerzeilen und Rabatten geladen sind.
const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "total",
  "shipping_total",
  "items.*",
  "items.detail.*",
  "items.tax_lines.*",
  "items.adjustments.*",
  "shipping_methods.*",
  "shipping_address.*",
]

export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  let order: OrderView | undefined
  try {
    const { data: orders } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: data.id },
    })
    order = orders[0] as unknown as OrderView | undefined
  } catch (err) {
    logger.error(`[order.placed] Bestellung ${data.id} nicht geladen: ${describeError(err)}`)
    return
  }
  if (!order) {
    logger.error(`[order.placed] Bestellung ${data.id} nicht gefunden.`)
    return
  }

  const current = order
  const settings: OrderMailSettings = {
    storeName: process.env.STORE_NAME || "jibbit",
    storeUrl: process.env.STORE_URL || "https://jibbit.ch",
    backendUrl: process.env.MEDUSA_BACKEND_URL || "http://localhost:9000",
  }
  const mail = { trigger: "order.placed", resourceId: current.id, data: { order_id: current.id } }

  const tasks: Array<() => Promise<unknown>> = [
    ...orderNotificationRecipients(process.env.ORDER_NOTIFICATION_TO).map(
      (to) => async () =>
        sendEmail(container, {
          ...mail,
          to,
          template: "order-notification",
          content: renderOrderNotification(current, settings),
        })
    ),
    async () => sendPush(logger, process.env.NTFY_URL, renderOrderPush(current, settings)),
  ]
  if (current.email) {
    tasks.push(async () =>
      sendEmail(container, {
        ...mail,
        to: current.email as string,
        template: "order-confirmation",
        content: renderOrderConfirmation(current, settings),
      })
    )
  } else {
    logger.warn(`[order.placed] Bestellung ${current.id} ohne E-Mail — keine Bestätigung versendet.`)
  }

  const results = await Promise.allSettled(tasks.map((task) => task()))
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error(`[order.placed] Benachrichtigung für ${current.id} fehlgeschlagen: ${describeError(result.reason)}`)
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
