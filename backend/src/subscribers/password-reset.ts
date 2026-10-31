import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { getShopConfig } from "../lib/shop-config"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { EmailContent } from "../lib/notify"
import { describeError, sendEmail } from "../lib/notify"
import {
  RESET_TOKEN_TTL_MINUTES,
  renderAdminPasswordResetEmail,
  renderPasswordResetEmail,
} from "../lib/password-reset-email"

/**
 * Passwort-zurücksetzen-E-Mail für Kundschaft (Storefront-Link) und
 * Admin-Benutzer (Link ins Dashboard).
 *
 * Die Reset-Routen antworten immer mit 201, egal ob es die Adresse gibt; der
 * Versand hängt am Event-Bus. Weder `data.token` (15 Minuten ein Zugang) noch
 * `data.entity_id` (die E-Mail-Adresse) dürfen ins Log.
 */

type PasswordResetEvent = {
  entity_id: string
  actor_type: string
  token: string
  metadata?: Record<string, unknown>
}

async function customerFirstName(container: SubscriberArgs["container"], email: string) {
  try {
    const [customer] = await container
      .resolve(Modules.CUSTOMER)
      .listCustomers({ email }, { select: ["first_name"], take: 1 })
    return customer?.first_name ?? null
  } catch {
    return null
  }
}

export default async function passwordResetHandler({
  event: { data },
  container,
}: SubscriberArgs<PasswordResetEvent>) {
  const actor = data?.actor_type
  if (actor !== "customer" && actor !== "user") {
    return
  }

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const email = data.entity_id
  if (!email || !data.token) {
    logger.warn("[auth] password_reset ohne Empfänger oder Token — nichts versendet.")
    return
  }

  const storeName = getShopConfig().storeName
  let content: EmailContent
  try {
    content =
      actor === "customer"
        ? renderPasswordResetEmail({
            storeUrl: process.env.STORE_URL,
            storeName,
            token: data.token,
            firstName: await customerFirstName(container, email),
          })
        : renderAdminPasswordResetEmail({
            backendUrl: process.env.MEDUSA_BACKEND_URL,
            storeName,
            token: data.token,
          })
  } catch (err) {
    logger.error(`[auth] Passwort-E-Mail nicht gerendert: ${describeError(err)}`)
    return
  }

  await sendEmail(container, {
    to: email,
    template: actor === "customer" ? "customer-password-reset" : "admin-password-reset",
    content,
    trigger: "auth.password_reset",
    data: { ttl_minutes: RESET_TOKEN_TTL_MINUTES },
  })
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}
