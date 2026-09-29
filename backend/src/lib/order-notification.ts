import type { EmailContent, PushMessage } from "./notify"
import { adminUrl, escapeHtml, formatChf } from "./email-format"

export const DEFAULT_ORDER_NOTIFICATION_TO = "joris@jibbit.ch"
export const CONTACT_EMAIL = "info@jibbit.ch"
export const VAT_NOTE = "keine MWST ausgewiesen (nicht mehrwertsteuerpflichtig)"

export interface OrderAddress {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  postal_code?: string | null
  city?: string | null
  country_code?: string | null
  phone?: string | null
}

export interface OrderItem {
  title?: string | null
  product_title?: string | null
  variant_title?: string | null
  quantity?: unknown
  unit_price?: unknown
}

export interface OrderView {
  id: string
  display_id?: string | number | null
  email?: string | null
  total?: unknown
  shipping_total?: unknown
  items?: OrderItem[] | null
  shipping_address?: OrderAddress | null
  shipping_methods?: Array<{ name?: string | null } | null> | null
}

export interface OrderMailSettings {
  storeName: string
  backendUrl: string | undefined
}

/** Empfänger der Betreiber-Mail: kommagetrennt aus ORDER_NOTIFICATION_TO, sonst der Default. */
export function orderNotificationRecipients(value: string | undefined): string[] {
  const list = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean)
  return list.length ? list : [DEFAULT_ORDER_NOTIFICATION_TO]
}

export function orderNumber(order: OrderView): string {
  return order.display_id != null && order.display_id !== "" ? `#${order.display_id}` : order.id
}

export function adminOrderUrl(backendUrl: string | undefined, orderId: string): string {
  return adminUrl(backendUrl, `/orders/${encodeURIComponent(orderId)}`).toString()
}

interface Line {
  label: string
  quantity: number
  unitPrice: number
}

const PLACEHOLDER_VARIANTS = new Set(["Standard", "Default", "Default variant"])

/** Artikelname für die Mail: Produkt, dazu die Variante, wenn sie etwas aussagt. */
export function itemLabel(item: OrderItem): string {
  const product = item.product_title || item.title || "Artikel"
  const variant =
    item.variant_title && item.variant_title !== product && !PLACEHOLDER_VARIANTS.has(item.variant_title)
      ? ` – ${item.variant_title}`
      : ""
  return `${product}${variant}`
}

function lines(order: OrderView): Line[] {
  return (order.items ?? []).map((item) => {
    const quantity = Number(item.quantity ?? 1)
    return {
      label: itemLabel(item),
      quantity: Number.isFinite(quantity) ? quantity : 1,
      unitPrice: Number(item.unit_price ?? 0),
    }
  })
}

export function itemCount(order: OrderView): number {
  return lines(order).reduce((sum, line) => sum + line.quantity, 0)
}

export function addressLines(address: OrderAddress | null | undefined): string[] {
  if (!address) return []
  return [
    [address.first_name, address.last_name].filter(Boolean).join(" "),
    address.company,
    address.address_1,
    address.address_2,
    [address.postal_code, address.city].filter(Boolean).join(" "),
    address.country_code ? address.country_code.toUpperCase() : "",
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
}

function customerName(order: OrderView): string {
  const a = order.shipping_address
  return [a?.first_name, a?.last_name].filter(Boolean).join(" ").trim()
}

function shippingLabel(order: OrderView): string {
  const method = order.shipping_methods?.find((m) => m?.name)?.name
  return method ? `Versand (${method})` : "Versand"
}

const STYLE_BODY =
  "margin:0;padding:24px;background:#ffffff;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1a15"
export const STYLE_CELL = "padding:6px 0;border-bottom:1px solid #eeeeee;vertical-align:top"
export const STYLE_MUTED = "color:#6b6557"

export function htmlDocument(inner: string): string {
  return `<!doctype html>
<html lang="de-CH"><body style="${STYLE_BODY}">
<div style="max-width:560px;margin:0 auto">
${inner}
</div>
</body></html>`
}

function itemsTable(order: OrderView): string {
  const rows = lines(order)
    .map(
      (line) => `<tr>
<td style="${STYLE_CELL}">${line.quantity} × ${escapeHtml(line.label)}<br><span style="${STYLE_MUTED};font-size:13px">à ${escapeHtml(formatChf(line.unitPrice))}</span></td>
<td style="${STYLE_CELL};text-align:right;white-space:nowrap">${escapeHtml(formatChf(line.unitPrice * line.quantity))}</td>
</tr>`
    )
    .join("\n")
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px">
${rows}
<tr><td style="padding:6px 0">${escapeHtml(shippingLabel(order))}</td><td style="padding:6px 0;text-align:right;white-space:nowrap">${escapeHtml(formatChf(order.shipping_total))}</td></tr>
<tr><td style="padding:8px 0;border-top:1px solid #cccccc;font-weight:bold">Total</td><td style="padding:8px 0;border-top:1px solid #cccccc;text-align:right;font-weight:bold;white-space:nowrap">${escapeHtml(formatChf(order.total))}</td></tr>
</table>`
}

function itemsText(order: OrderView): string[] {
  return [
    ...lines(order).map(
      (line) =>
        `${line.quantity} × ${line.label}, à ${formatChf(line.unitPrice)} = ${formatChf(line.unitPrice * line.quantity)}`
    ),
    `${shippingLabel(order)}: ${formatChf(order.shipping_total)}`,
    `Total: ${formatChf(order.total)}`,
  ]
}

export function renderOrderConfirmation(order: OrderView, settings: OrderMailSettings): EmailContent {
  const nr = orderNumber(order)
  const store = settings.storeName
  const name = order.shipping_address?.first_name?.trim()
  const greeting = name ? `Hallo ${name}` : "Hallo"
  const address = addressLines(order.shipping_address)

  const subject = `Deine Bestellung ${nr} bei ${store}`

  const text = [
    greeting,
    ``,
    `Vielen Dank für deine Bestellung bei ${store}. Wir haben sie erhalten und schicken sie so bald wie möglich los.`,
    ``,
    `Bestellnummer: ${nr}`,
    ``,
    ...itemsText(order),
    `Hinweis: ${VAT_NOTE}.`,
    ...(address.length ? [``, `Lieferadresse:`, ...address] : []),
    ``,
    `Fragen zu deiner Bestellung? Schreib uns an ${CONTACT_EMAIL}.`,
    ``,
    `Liebe Grüsse`,
    store,
  ].join("\n")

  const html = htmlDocument(`<p>${escapeHtml(greeting)}</p>
<p>Vielen Dank für deine Bestellung bei ${escapeHtml(store)}. Wir haben sie erhalten und schicken sie so bald wie möglich los.</p>
<h1 style="font-size:18px;margin:24px 0 8px">Bestellung ${escapeHtml(nr)}</h1>
${itemsTable(order)}
<p style="${STYLE_MUTED};font-size:13px;margin:0 0 20px">Hinweis: ${escapeHtml(VAT_NOTE)}.</p>
${
  address.length
    ? `<p style="margin:0 0 4px;font-weight:bold">Lieferadresse</p>
<p style="margin:0 0 20px">${address.map(escapeHtml).join("<br>")}</p>`
    : ""
}<p>Fragen zu deiner Bestellung? Schreib uns an <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
<p>Liebe Grüsse<br>${escapeHtml(store)}</p>`)

  return { subject, text, html }
}

export function renderOrderNotification(order: OrderView, settings: OrderMailSettings): EmailContent {
  const nr = orderNumber(order)
  const link = adminOrderUrl(settings.backendUrl, order.id)
  const customer = [customerName(order), order.email].filter(Boolean).join(", ") || "unbekannt"
  const city = [order.shipping_address?.postal_code, order.shipping_address?.city]
    .filter(Boolean)
    .join(" ")

  const subject = `Neue Bestellung ${nr} – ${formatChf(order.total)}`

  const text = [
    `Neue Bestellung ${nr}`,
    `Total: ${formatChf(order.total)}`,
    `Kunde: ${customer}${city ? ` (${city})` : ""}`,
    ``,
    ...lines(order).map((line) => `${line.quantity} × ${line.label}`),
    ``,
    `Im Admin öffnen: ${link}`,
  ].join("\n")

  const html = htmlDocument(`<h1 style="font-size:18px;margin:0 0 8px">Neue Bestellung ${escapeHtml(nr)}</h1>
<p style="margin:0 0 4px"><strong>Total: ${escapeHtml(formatChf(order.total))}</strong></p>
<p style="margin:0 0 16px">Kunde: ${escapeHtml(customer)}${city ? ` (${escapeHtml(city)})` : ""}</p>
<ul style="margin:0 0 16px;padding-left:20px">
${lines(order)
  .map((line) => `<li>${line.quantity} × ${escapeHtml(line.label)}</li>`)
  .join("\n")}
</ul>
<p><a href="${escapeHtml(link)}">Im Admin öffnen</a></p>`)

  return { subject, text, html }
}

export function renderOrderPush(order: OrderView, settings: OrderMailSettings): PushMessage {
  const count = itemCount(order)
  return {
    title: `Neue Bestellung ${orderNumber(order)}`,
    message: `${formatChf(order.total)} · ${count} Artikel`,
    click: adminOrderUrl(settings.backendUrl, order.id),
    tags: "package",
  }
}
