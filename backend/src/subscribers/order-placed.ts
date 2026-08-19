import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Schickt bei jeder neuen Bestellung eine Mail an den Shop-Betreiber.
 *
 * Optional (ORDER_CONFIRMATION_TO_CUSTOMER=true) zusätzlich eine
 * Bestellbestätigung an die Kundin. Standardmässig AUS, damit Testbestellungen
 * während des Aufbaus niemanden anschreiben — vor dem Livegang bewusst setzen.
 *
 * Fehler beim Mailversand werden geloggt, aber nicht geworfen: eine nicht
 * zustellbare Mail darf eine bereits bezahlte Bestellung nicht scheitern lassen.
 */

type OrderLike = {
  id: string
  // Query gibt display_id als String zurück, die Order-Entity als Zahl —
  // hier interessiert nur die Darstellung, also beides zulassen.
  display_id?: string | number
  email?: string
  currency_code?: string
  total?: unknown
  subtotal?: unknown
  shipping_total?: unknown
  tax_total?: unknown
  created_at?: string | Date
  items?: Array<{
    title?: string
    product_title?: string
    variant_title?: string
    variant_sku?: string
    quantity?: number
    unit_price?: unknown
    total?: unknown
  }>
  shipping_address?: Record<string, unknown> | null
  shipping_methods?: Array<{ name?: string; amount?: unknown }> | null
}

const money = (value: unknown, currency = "CHF"): string => {
  const n = Number(value ?? 0)
  return new Intl.NumberFormat("de-CH", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(Number.isFinite(n) ? n : 0)
}

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const addressLines = (
  address: Record<string, unknown> | null | undefined
): string[] => {
  if (!address) {
    return []
  }

  const name = [address.first_name, address.last_name].filter(Boolean).join(" ")
  const city = [address.postal_code, address.city].filter(Boolean).join(" ")

  return [
    name,
    address.company,
    address.address_1,
    address.address_2,
    city,
    address.country_code ? String(address.country_code).toUpperCase() : "",
    address.phone,
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
}

const buildEmail = (order: OrderLike, forOwner: boolean) => {
  const currency = order.currency_code ?? "CHF"
  const ref = order.display_id ? `#${order.display_id}` : order.id
  const items = order.items ?? []

  const rows = items
    .map((item) => {
      const label = item.product_title ?? item.title ?? "Artikel"
      const variant =
        item.variant_title && item.variant_title !== label
          ? ` — ${item.variant_title}`
          : ""
      const sku = item.variant_sku ? ` (${item.variant_sku})` : ""

      return `<tr>
        <td style="padding:6px 12px 6px 0;border-bottom:1px solid #eee">${esc(label)}${esc(variant)}${esc(sku)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${esc(item.quantity ?? 1)}</td>
        <td style="padding:6px 0 6px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${esc(money(item.total, currency))}</td>
      </tr>`
    })
    .join("\n")

  const shipping = addressLines(order.shipping_address)
  const method = order.shipping_methods?.[0]?.name

  const subject = forOwner
    ? `Neue Bestellung ${ref} — ${money(order.total, currency)}`
    : `Deine Bestellung bei jibbit.ch ${ref}`

  const intro = forOwner
    ? `<p style="margin:0 0 1.25rem">Neue Bestellung auf jibbit.ch.</p>`
    : `<p style="margin:0 0 1.25rem">Danke f&uuml;r deine Bestellung! Wir haben sie erhalten und melden uns, sobald sie unterwegs ist.</p>`

  const html = `<!doctype html>
<html lang="de"><body style="margin:0;padding:24px;background:#fdfdfb;
  font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1a15">
  <div style="max-width:560px;margin:0 auto">
    <h1 style="font-size:1.2rem;margin:0 0 .25rem">Bestellung ${esc(ref)}</h1>
    <p style="margin:0 0 1.5rem;color:#7a7466;font-size:.9rem">
      ${esc(new Date(order.created_at ?? Date.now()).toLocaleString("de-CH"))}
    </p>
    ${intro}
    <table style="width:100%;border-collapse:collapse;margin:0 0 1.25rem">
      <thead><tr>
        <th style="text-align:left;padding:0 12px 6px 0;font-size:.72rem;letter-spacing:.1em;
          text-transform:uppercase;color:#7a7466;border-bottom:1px solid #ddd">Artikel</th>
        <th style="text-align:center;padding:0 12px 6px;font-size:.72rem;letter-spacing:.1em;
          text-transform:uppercase;color:#7a7466;border-bottom:1px solid #ddd">Anz.</th>
        <th style="text-align:right;padding:0 0 6px 12px;font-size:.72rem;letter-spacing:.1em;
          text-transform:uppercase;color:#7a7466;border-bottom:1px solid #ddd">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;margin:0 0 1.5rem">
      <tr><td style="padding:2px 0;color:#7a7466">Zwischensumme</td>
          <td style="padding:2px 0;text-align:right">${esc(money(order.subtotal, currency))}</td></tr>
      <tr><td style="padding:2px 0;color:#7a7466">Versand${method ? ` (${esc(method)})` : ""}</td>
          <td style="padding:2px 0;text-align:right">${esc(money(order.shipping_total, currency))}</td></tr>
      <tr><td style="padding:2px 0;color:#7a7466">MwSt.</td>
          <td style="padding:2px 0;text-align:right">${esc(money(order.tax_total, currency))}</td></tr>
      <tr><td style="padding:8px 0 0;font-weight:600;border-top:1px solid #ddd">Total</td>
          <td style="padding:8px 0 0;text-align:right;font-weight:600;border-top:1px solid #ddd">${esc(money(order.total, currency))}</td></tr>
    </table>
    ${
      shipping.length
        ? `<p style="margin:0 0 .35rem;font-size:.72rem;letter-spacing:.1em;
             text-transform:uppercase;color:#7a7466">Lieferadresse</p>
           <p style="margin:0 0 1.5rem">${shipping.map(esc).join("<br>")}</p>`
        : ""
    }
    ${
      forOwner && order.email
        ? `<p style="margin:0;color:#7a7466;font-size:.9rem">Kunde: ${esc(order.email)}</p>`
        : ""
    }
  </div>
</body></html>`

  const text = [
    `Bestellung ${ref}`,
    "",
    ...items.map(
      (item) =>
        `${item.quantity ?? 1}x ${item.product_title ?? item.title ?? "Artikel"}` +
        `  ${money(item.total, currency)}`
    ),
    "",
    `Zwischensumme: ${money(order.subtotal, currency)}`,
    `Versand:       ${money(order.shipping_total, currency)}`,
    `MwSt.:         ${money(order.tax_total, currency)}`,
    `Total:         ${money(order.total, currency)}`,
    ...(shipping.length ? ["", "Lieferadresse:", ...shipping] : []),
    ...(forOwner && order.email ? ["", `Kunde: ${order.email}`] : []),
  ].join("\n")

  return { subject, html, text }
}

export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const notification = container.resolve(Modules.NOTIFICATION)

  const ownerEmail = process.env.ORDER_NOTIFICATION_TO?.trim()
  const notifyCustomer = process.env.ORDER_CONFIRMATION_TO_CUSTOMER === "true"

  if (!ownerEmail && !notifyCustomer) {
    logger.warn(
      "order.placed: ORDER_NOTIFICATION_TO ist nicht gesetzt — keine Mail verschickt."
    )
    return
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "currency_code",
      "total",
      "subtotal",
      "shipping_total",
      "tax_total",
      "created_at",
      "items.*",
      "shipping_address.*",
      "shipping_methods.*",
    ],
    filters: { id: data.id },
  })

  const order = orders?.[0] as unknown as OrderLike | undefined

  if (!order) {
    logger.error(`order.placed: Bestellung ${data.id} nicht gefunden.`)
    return
  }

  if (ownerEmail) {
    const content = buildEmail(order, true)

    try {
      await notification.createNotifications({
        to: ownerEmail,
        channel: "email",
        template: "order-placed-owner",
        trigger_type: "order.placed",
        resource_id: order.id,
        content,
        data: { order_id: order.id, display_id: order.display_id },
      })
      logger.info(`order.placed: Betreiber-Mail für ${order.id} an ${ownerEmail}.`)
    } catch (error) {
      logger.error(
        `order.placed: Betreiber-Mail für ${order.id} fehlgeschlagen — ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  if (notifyCustomer && order.email) {
    const content = buildEmail(order, false)

    try {
      await notification.createNotifications({
        to: order.email,
        channel: "email",
        template: "order-confirmation",
        trigger_type: "order.placed",
        resource_id: order.id,
        content,
        data: { order_id: order.id, display_id: order.display_id },
      })
      logger.info(`order.placed: Bestätigung für ${order.id} an ${order.email}.`)
    } catch (error) {
      logger.error(
        `order.placed: Kundenbestätigung für ${order.id} fehlgeschlagen — ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
