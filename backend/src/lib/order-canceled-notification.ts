/**
 * Inhalt der Storno-Mails: an die Kundschaft und kurz an den Betreiber.
 *
 * Medusas `cancelOrderWorkflow` erstattet erfasste Zahlungen beim Stornieren
 * selbst zurück und gibt nicht erfasste frei. Dafür kommt KEIN
 * `payment.refunded` (das löst nur die einzelne Rückerstattung im Admin aus),
 * die Storno-Mail ist also die einzige Nachricht zur Zahlung und muss den Satz
 * dazu selbst tragen.
 */

import type { EmailContent } from "./notify"
import { escapeHtml, formatChf } from "./email-format"
import {
  CONTACT_EMAIL,
  type OrderMailSettings,
  type OrderView,
  STYLE_CELL,
  adminOrderUrl,
  htmlDocument,
  itemLabel,
  orderNumber,
} from "./order-notification"

export interface PaymentAmount {
  amount?: unknown
}

export interface OrderPayment {
  id?: string | null
  captures?: Array<PaymentAmount | null> | null
  refunds?: Array<PaymentAmount | null> | null
}

export interface CanceledOrderView extends OrderView {
  payment_collections?: Array<{
    payments?: Array<OrderPayment | null> | null
  } | null> | null
}

export interface PaymentSummary {
  /** Falsch, wenn die Zahlungsdaten der Bestellung nicht geladen sind. */
  known: boolean
  captured: number
  refunded: number
}

/** Betrag aus Query-Ergebnissen: Zahl, Zeichenkette oder BigNumber-Objekt. */
export function toAmount(value: unknown): number {
  if (value && typeof value === "object") {
    const big = value as { numeric?: unknown; value?: unknown }
    return toAmount(big.numeric ?? big.value ?? 0)
  }
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function sum(entries: Array<PaymentAmount | null> | null | undefined): number {
  return (entries ?? []).reduce((total, entry) => total + toAmount(entry?.amount), 0)
}

/** Was für die Bestellung tatsächlich abgebucht und was davon schon erstattet wurde. */
export function paymentSummary(order: CanceledOrderView): PaymentSummary {
  if (!Array.isArray(order.payment_collections)) {
    return { known: false, captured: 0, refunded: 0 }
  }
  let captured = 0
  let refunded = 0
  for (const collection of order.payment_collections) {
    for (const payment of collection?.payments ?? []) {
      captured += sum(payment?.captures)
      refunded += sum(payment?.refunds)
    }
  }
  return { known: true, captured, refunded }
}

/**
 * Der Satz zur Zahlung. Er stimmt in jedem Fall: Wurde abgebucht, kommt der
 * Betrag zurück; wurde nichts abgebucht, steht das da; sind die Zahlungsdaten
 * nicht bekannt, bleibt er bei «falls».
 */
export function paymentNote(order: CanceledOrderView): string {
  const { known, captured } = paymentSummary(order)
  if (!known) {
    return "Falls du bereits bezahlt hast, erhältst du den Betrag auf das ursprüngliche Zahlungsmittel zurück. Bis er bei dir ankommt, kann es ein paar Werktage dauern."
  }
  if (captured > 0) {
    return `Du hast für diese Bestellung ${formatChf(captured)} bezahlt. Den Betrag erhältst du auf das ursprüngliche Zahlungsmittel zurück. Bis er bei dir ankommt, kann es ein paar Werktage dauern.`
  }
  return "Für diese Bestellung wurde dir nichts belastet. Eine allfällige Reservation auf deinem Zahlungsmittel wird freigegeben."
}

interface Line {
  label: string
  quantity: number
}

function lines(order: OrderView): Line[] {
  return (order.items ?? []).map((item) => {
    const quantity = Number(item.quantity ?? 1)
    return { label: itemLabel(item), quantity: Number.isFinite(quantity) ? quantity : 1 }
  })
}

export interface CanceledMailSettings {
  storeName: string
}

export function renderOrderCanceled(
  order: CanceledOrderView,
  settings: CanceledMailSettings
): EmailContent {
  const nr = orderNumber(order)
  const store = settings.storeName
  const name = order.shipping_address?.first_name?.trim()
  const greeting = name ? `Hallo ${name}` : "Hallo"
  const items = lines(order)
  const intro = `Deine Bestellung ${nr} bei ${store} wurde storniert. Wir verschicken sie nicht.`
  const payment = paymentNote(order)

  const subject = `Deine Bestellung ${nr} bei ${store} wurde storniert`

  const text = [
    greeting,
    ``,
    intro,
    ``,
    `Bestellnummer: ${nr}`,
    ...(items.length
      ? [``, `Stornierte Artikel:`, ...items.map((line) => `${line.quantity} × ${line.label}`)]
      : []),
    ``,
    payment,
    ``,
    `Fragen zur Stornierung? Schreib uns an ${CONTACT_EMAIL}.`,
    ``,
    `Liebe Grüsse`,
    store,
  ].join("\n")

  const html = htmlDocument(`<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(intro)}</p>
<h1 style="font-size:18px;margin:24px 0 8px">Bestellung ${escapeHtml(nr)}</h1>
${
  items.length
    ? `<p style="margin:0 0 4px;font-weight:bold">Stornierte Artikel</p>
<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">
${items.map((line) => `<tr><td style="${STYLE_CELL}">${line.quantity} × ${escapeHtml(line.label)}</td></tr>`).join("\n")}
</table>
`
    : ""
}<p>${escapeHtml(payment)}</p>
<p>Fragen zur Stornierung? Schreib uns an <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
<p>Liebe Grüsse<br>${escapeHtml(store)}</p>`)

  return { subject, text, html }
}

/** Kurze Meldung an den Betreiber, mit dem Stand der Zahlung zum Nachprüfen. */
export function renderOrderCanceledNotification(
  order: CanceledOrderView,
  settings: Pick<OrderMailSettings, "backendUrl">
): EmailContent {
  const nr = orderNumber(order)
  const link = adminOrderUrl(settings.backendUrl, order.id)
  const { known, captured, refunded } = paymentSummary(order)
  const open = Math.max(captured - refunded, 0)
  const payment = !known
    ? "Zahlung: Stand unbekannt, bitte im Admin prüfen."
    : captured <= 0
      ? "Zahlung: nichts abgebucht."
      : open > 0.004
        ? `Zahlung: ${formatChf(captured)} abgebucht, ${formatChf(refunded)} erstattet. Offen: ${formatChf(open)}, bitte im Admin prüfen.`
        : `Zahlung: ${formatChf(captured)} abgebucht und vollständig erstattet.`
  const items = lines(order)

  const subject = `Bestellung ${nr} storniert`

  const text = [
    `Bestellung ${nr} storniert`,
    payment,
    ``,
    ...items.map((line) => `${line.quantity} × ${line.label}`),
    ``,
    `Im Admin öffnen: ${link}`,
  ].join("\n")

  const html = htmlDocument(`<h1 style="font-size:18px;margin:0 0 8px">Bestellung ${escapeHtml(nr)} storniert</h1>
<p style="margin:0 0 16px">${escapeHtml(payment)}</p>
<ul style="margin:0 0 16px;padding-left:20px">
${items.map((line) => `<li>${line.quantity} × ${escapeHtml(line.label)}</li>`).join("\n")}
</ul>
<p><a href="${escapeHtml(link)}">Im Admin öffnen</a></p>`)

  return { subject, text, html }
}
