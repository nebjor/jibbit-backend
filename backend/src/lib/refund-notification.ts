/**
 * Inhalt der Rückerstattungs-Mail an die Kundschaft.
 *
 * `payment.refunded` nennt nur die ID der ZAHLUNG, nicht die der
 * Rückerstattung. Eine Zahlung kann mehrere Rückerstattungen haben
 * (Teilbeträge); welche davon eine Mail braucht, entscheidet `refundsToNotify`.
 */

import type { EmailContent } from "./notify"
import { getShopConfig } from "./shop-config"
import { escapeHtml, formatChf } from "./email-format"
import { toAmount } from "./order-canceled-notification"
import { type OrderView, htmlDocument, orderNumber } from "./order-notification"

/**
 * So weit zurück gilt eine Rückerstattung als «gehört zu diesem Event». Deckt
 * verzögert zugestellte und wiederholte Events ab, ohne bei der nächsten
 * Rückerstattung alte, längst erledigte noch einmal zu melden.
 */
export const REFUND_WINDOW_MS = 60 * 60 * 1000

export interface RefundView {
  id?: string | null
  amount?: unknown
  created_at?: unknown
}

export interface RefundedPaymentView {
  id: string
  refunds?: Array<RefundView | null> | null
  payment_collection?: { order?: { id?: string | null } | null } | null
}

export interface RefundToNotify {
  id: string
  amount: number
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime()
    return Number.isFinite(time) ? time : 0
  }
  return 0
}

/**
 * Rückerstattungen, die jetzt eine Mail bekommen: alle aus dem Zeitfenster,
 * älteste zuerst. Liegt keine im Fenster (Event kam sehr spät), die jüngste.
 *
 * Mehrere statt nur der jüngsten, weil zwei Rückerstattungen kurz
 * nacheinander sonst beide Events auf dieselbe (die jüngste) zeigen liessen und
 * die erste nie gemeldet würde. Doppelt geht trotzdem nichts raus: Der
 * Idempotenz-Schlüssel hängt an der ID der Rückerstattung.
 */
export function refundsToNotify(
  payment: RefundedPaymentView,
  now: number = Date.now()
): RefundToNotify[] {
  const refunds = (payment.refunds ?? [])
    .filter((refund): refund is RefundView & { id: string } => !!refund?.id)
    .map((refund) => ({
      id: refund.id,
      amount: toAmount(refund.amount),
      createdAt: timestamp(refund.created_at),
    }))
    .filter((refund) => refund.amount > 0)
    .sort((a, b) => a.createdAt - b.createdAt)

  const recent = refunds.filter((refund) => now - refund.createdAt <= REFUND_WINDOW_MS)
  const chosen = recent.length ? recent : refunds.slice(-1)
  return chosen.map(({ id, amount }) => ({ id, amount }))
}

export interface RefundMailSettings {
  storeName: string
}

export function renderRefundConfirmation(
  refund: RefundToNotify,
  order: OrderView,
  settings: RefundMailSettings
): EmailContent {
  const nr = orderNumber(order)
  const store = settings.storeName
  const name = order.shipping_address?.first_name?.trim()
  const greeting = name ? `Hallo ${name}` : "Hallo"
  const amount = formatChf(refund.amount)
  const intro = `Wir haben dir zu deiner Bestellung ${nr} bei ${store} ${amount} zurückerstattet.`
  const method =
    "Der Betrag geht auf das Zahlungsmittel zurück, mit dem du bezahlt hast. Bis er bei dir ankommt, kann es ein paar Werktage dauern."

  const subject = `Rückerstattung zu deiner Bestellung ${nr} bei ${store}`

  const text = [
    greeting,
    ``,
    intro,
    ``,
    `Bestellnummer: ${nr}`,
    `Rückerstatteter Betrag: ${amount}`,
    ``,
    method,
    ``,
    `Fragen zur Rückerstattung? Schreib uns an ${getShopConfig().contactEmail}.`,
    ``,
    `Liebe Grüsse`,
    store,
  ].join("\n")

  const html = htmlDocument(`<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(intro)}</p>
<h1 style="font-size:18px;margin:24px 0 8px">Bestellung ${escapeHtml(nr)}</h1>
<p style="margin:0 0 16px"><strong>Rückerstatteter Betrag: ${escapeHtml(amount)}</strong></p>
<p>${escapeHtml(method)}</p>
<p>Fragen zur Rückerstattung? Schreib uns an <a href="mailto:${getShopConfig().contactEmail}">${getShopConfig().contactEmail}</a>.</p>
<p>Liebe Grüsse<br>${escapeHtml(store)}</p>`)

  return { subject, text, html }
}
