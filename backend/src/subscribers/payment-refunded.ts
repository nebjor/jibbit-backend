import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { EmailContent } from "../lib/notify"
import { describeError, sendEmail } from "../lib/notify"
import type { OrderView } from "../lib/order-notification"
import {
  type RefundedPaymentView,
  refundsToNotify,
  renderRefundConfirmation,
} from "../lib/refund-notification"

/**
 * Mail an die Kundin, wenn im Admin eine Zahlung (teilweise) zurückerstattet
 * wird.
 *
 * `payment.refunded` kommt aus Medusas `refundPaymentWorkflow`; `id` ist die ID
 * der ZAHLUNG. Der Weg zur Bestellung: Zahlung → Payment Collection →
 * Bestellung (Link `order_payment_collection`). Das Stornieren einer Bestellung
 * erstattet über `refundPaymentsWorkflow` und löst dieses Event NICHT aus;
 * dort sagt es die Storno-Mail. Nichts hier darf die Rückerstattung im Admin
 * scheitern lassen.
 */

type PaymentRefundedEvent = {
  id: string
  no_notification?: boolean | null
}

const PAYMENT_FIELDS = [
  "id",
  "refunds.id",
  "refunds.amount",
  "refunds.created_at",
  "payment_collection.order.id",
]

const ORDER_FIELDS = ["id", "display_id", "email", "shipping_address.first_name"]

export default async function paymentRefundedHandler({
  event: { data },
  container,
}: SubscriberArgs<PaymentRefundedEvent>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const paymentId = data?.id
  if (!paymentId) {
    logger.warn("[payment.refunded] Event ohne Zahlungs-ID — nichts versendet.")
    return
  }
  if (data.no_notification) {
    logger.info(`[payment.refunded] Zahlung ${paymentId}: Benachrichtigung abgewählt.`)
    return
  }

  let payment: RefundedPaymentView | undefined
  let order: OrderView | undefined
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: payments } = await query.graph({
      entity: "payment",
      fields: PAYMENT_FIELDS,
      filters: { id: paymentId },
    })
    payment = payments[0] as unknown as RefundedPaymentView | undefined
    const orderId = payment?.payment_collection?.order?.id
    if (payment && orderId) {
      const { data: orders } = await query.graph({
        entity: "order",
        fields: ORDER_FIELDS,
        filters: { id: orderId },
      })
      order = orders[0] as unknown as OrderView | undefined
    }
  } catch (err) {
    logger.error(`[payment.refunded] Zahlung ${paymentId} nicht geladen: ${describeError(err)}`)
    return
  }
  if (!payment) {
    logger.error(`[payment.refunded] Zahlung ${paymentId} nicht gefunden.`)
    return
  }
  if (!order) {
    logger.error(`[payment.refunded] Zahlung ${paymentId}: keine Bestellung dazu gefunden.`)
    return
  }
  if (!order.email) {
    logger.warn(
      `[payment.refunded] Bestellung ${order.id} ohne E-Mail — keine Rückerstattungs-Mail versendet.`
    )
    return
  }

  const refunds = refundsToNotify(payment)
  if (!refunds.length) {
    logger.warn(`[payment.refunded] Zahlung ${paymentId} ohne Rückerstattung — nichts versendet.`)
    return
  }

  for (const refund of refunds) {
    let content: EmailContent
    try {
      content = renderRefundConfirmation(refund, order, {
        storeName: process.env.STORE_NAME || "jibbit",
      })
    } catch (err) {
      logger.error(
        `[payment.refunded] Mail für Rückerstattung ${refund.id} nicht gerendert: ${describeError(err)}`
      )
      continue
    }
    await sendEmail(container, {
      to: order.email,
      template: "refund-confirmation",
      content,
      trigger: "payment.refunded",
      resourceId: refund.id,
      data: { order_id: order.id, payment_id: payment.id, refund_id: refund.id },
      // Je Rückerstattung genau eine Mail, egal wie oft das Event kommt.
      idempotencyKey: `refund-confirmation:${refund.id}`,
    })
  }
}

export const config: SubscriberConfig = {
  event: "payment.refunded",
}
