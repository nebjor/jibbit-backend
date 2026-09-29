/**
 * Inhalt der Versandbestätigung an die Kundschaft.
 *
 * Eine Sendung ist in Medusa ein Fulfillment, das als versendet markiert
 * wurde. Sie kann die ganze Bestellung enthalten oder nur einen Teil davon;
 * die Mail nennt deshalb die Artikel der SENDUNG, nicht die der Bestellung.
 */

import type { EmailContent } from "./notify"
import { escapeHtml } from "./email-format"
import {
  CONTACT_EMAIL,
  type OrderAddress,
  type OrderItem,
  type OrderView,
  STYLE_CELL,
  STYLE_MUTED,
  addressLines,
  htmlDocument,
  itemLabel,
  orderNumber,
} from "./order-notification"

/** Sendungsverfolgung der Schweizerischen Post; die Sendungsnummer wird angehängt. */
export const SWISS_POST_TRACKING_URL = "https://service.post.ch/ekp-web/ui/entry/search/"

export interface ShipmentItem {
  title?: string | null
  quantity?: unknown
  line_item_id?: string | null
  inventory_item_id?: string | null
}

export interface ShipmentLabel {
  tracking_number?: string | null
  tracking_url?: string | null
}

export interface ShipmentOrderItem extends OrderItem {
  id?: string | null
  variant?: {
    inventory_items?: Array<{
      required_quantity?: unknown
      inventory_item_id?: string | null
      inventory?: { id?: string | null } | null
    } | null> | null
  } | null
}

export interface ShipmentOrderView extends OrderView {
  items?: ShipmentOrderItem[] | null
}

export interface ShipmentView {
  id: string
  items?: Array<ShipmentItem | null> | null
  labels?: Array<ShipmentLabel | null> | null
  delivery_address?: OrderAddress | null
}

export interface ShippingMailSettings {
  storeName: string
}

export interface ShippedLine {
  label: string
  quantity: number
}

export interface Tracking {
  number: string
  url: string
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Artikel der Sendung, je Bestellposition eine Zeile.
 *
 * Die Menge rechnet wie Medusas `createOrderShipmentWorkflow`: Braucht eine
 * Variante mehrere Lagerartikel (Set) oder `required_quantity` > 1, gibt es je
 * Lagerartikel eine Fulfillment-Position mit vervielfachter Menge. Gezählt wird
 * darum nur die erste Position je Bestellzeile, geteilt durch
 * `required_quantity`.
 */
export function shippedLines(shipment: ShipmentView, order: ShipmentOrderView): ShippedLine[] {
  const orderItems = new Map<string, ShipmentOrderItem>()
  for (const item of order.items ?? []) {
    if (item?.id) orderItems.set(item.id, item)
  }

  const seen = new Set<string>()
  const result: ShippedLine[] = []
  for (const item of shipment.items ?? []) {
    if (!item) continue
    const lineItemId = item.line_item_id || undefined
    if (lineItemId) {
      if (seen.has(lineItemId)) continue
      seen.add(lineItemId)
    }

    const orderItem = lineItemId ? orderItems.get(lineItemId) : undefined
    let quantity = positive(item.quantity, 1)
    const inventoryItem = orderItem?.variant?.inventory_items?.find(
      (entry) =>
        !!entry &&
        !!item.inventory_item_id &&
        (entry.inventory?.id ?? entry.inventory_item_id) === item.inventory_item_id
    )
    if (inventoryItem) {
      quantity = quantity / positive(inventoryItem.required_quantity, 1)
    }

    result.push({
      label: orderItem ? itemLabel(orderItem) : item.title?.trim() || "Artikel",
      quantity,
    })
  }
  return result
}

/** Wahr, wenn die Sendung nicht alle Artikel der Bestellung enthält. */
export function isPartialShipment(shipment: ShipmentView, order: ShipmentOrderView): boolean {
  const ordered = (order.items ?? []).reduce((sum, item) => sum + positive(item?.quantity, 1), 0)
  const shipped = shippedLines(shipment, order).reduce((sum, line) => sum + line.quantity, 0)
  return shipped < ordered
}

function httpUrl(value: string | null | undefined): string | undefined {
  // Das Admin-Dashboard schickt "#", wenn das Feld leer bleibt.
  if (!value?.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function swissPostTrackingUrl(trackingNumber: string): string {
  return `${SWISS_POST_TRACKING_URL}${encodeURIComponent(trackingNumber.trim())}`
}

/**
 * Sendungsnummern mit Link. Ist im Admin ein eigener Link hinterlegt, gilt
 * der; sonst führt der Link zur Sendungsverfolgung der Post.
 */
export function trackings(shipment: ShipmentView): Tracking[] {
  const result = new Map<string, Tracking>()
  for (const label of shipment.labels ?? []) {
    const number = label?.tracking_number?.trim()
    if (!number || number === "#" || result.has(number)) continue
    result.set(number, { number, url: httpUrl(label?.tracking_url) ?? swissPostTrackingUrl(number) })
  }
  return [...result.values()]
}

export function renderShippingConfirmation(
  shipment: ShipmentView,
  order: ShipmentOrderView,
  settings: ShippingMailSettings
): EmailContent {
  const nr = orderNumber(order)
  const store = settings.storeName
  const address = addressLines(shipment.delivery_address ?? order.shipping_address)
  const name = (shipment.delivery_address ?? order.shipping_address)?.first_name?.trim()
  const greeting = name ? `Hallo ${name}` : "Hallo"
  const lines = shippedLines(shipment, order)
  const tracking = trackings(shipment)
  const partial = isPartialShipment(shipment, order)

  const intro = partial
    ? `Ein Teil deiner Bestellung ${nr} ist unterwegs: Wir haben die Sendung der Post übergeben.`
    : `Deine Bestellung ${nr} ist unterwegs: Wir haben sie der Post übergeben.`
  const partialNote = "Die übrigen Artikel deiner Bestellung kommen in einer separaten Sendung."
  const trackingTitle = tracking.length > 1 ? "Sendungsnummern" : "Sendungsnummer"
  const trackingHint = "Bis die Post die Sendung erfasst hat und der Link etwas anzeigt, kann es ein paar Stunden dauern."
  const noTracking =
    "Diese Sendung ist ohne Sendungsverfolgung unterwegs, zum Beispiel als Brief. Eine Sendungsnummer gibt es deshalb nicht."

  const subject = partial
    ? `Ein Teil deiner Bestellung ${nr} bei ${store} ist unterwegs`
    : `Deine Bestellung ${nr} bei ${store} ist unterwegs`

  const text = [
    greeting,
    ``,
    intro,
    ``,
    `Bestellnummer: ${nr}`,
    ``,
    `In dieser Sendung:`,
    ...lines.map((line) => `${line.quantity} × ${line.label}`),
    ...(partial ? [``, partialNote] : []),
    ``,
    ...(tracking.length
      ? [`${trackingTitle}:`, ...tracking.map((t) => `${t.number}: ${t.url}`), trackingHint]
      : [noTracking]),
    ...(address.length ? [``, `Lieferadresse:`, ...address] : []),
    ``,
    `Fragen zu deiner Sendung? Schreib uns an ${CONTACT_EMAIL}.`,
    ``,
    `Liebe Grüsse`,
    store,
  ].join("\n")

  const html = htmlDocument(`<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(intro)}</p>
<h1 style="font-size:18px;margin:24px 0 8px">Bestellung ${escapeHtml(nr)}</h1>
<p style="margin:0 0 4px;font-weight:bold">In dieser Sendung</p>
<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">
${lines.map((line) => `<tr><td style="${STYLE_CELL}">${line.quantity} × ${escapeHtml(line.label)}</td></tr>`).join("\n")}
</table>
${partial ? `<p style="margin:0 0 20px">${escapeHtml(partialNote)}</p>\n` : ""}${
    tracking.length
      ? `<p style="margin:0 0 4px;font-weight:bold">${trackingTitle}</p>
<p style="margin:0 0 4px">${tracking
          .map((t) => `<a href="${escapeHtml(t.url)}">${escapeHtml(t.number)}</a>`)
          .join("<br>")}</p>
<p style="${STYLE_MUTED};font-size:13px;margin:0 0 20px">${escapeHtml(trackingHint)}</p>`
      : `<p style="margin:0 0 20px">${escapeHtml(noTracking)}</p>`
  }
${
  address.length
    ? `<p style="margin:0 0 4px;font-weight:bold">Lieferadresse</p>
<p style="margin:0 0 20px">${address.map(escapeHtml).join("<br>")}</p>`
    : ""
}<p>Fragen zu deiner Sendung? Schreib uns an <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
<p>Liebe Grüsse<br>${escapeHtml(store)}</p>`)

  return { subject, text, html }
}
