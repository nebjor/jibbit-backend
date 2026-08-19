import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  RESET_TOKEN_TTL_MINUTES,
  renderPasswordResetEmail,
} from "../lib/password-reset-email"

/**
 * Verschickt die Passwort-zurücksetzen-E-Mail.
 *
 * Ausgelöst von `generateResetPasswordTokenWorkflow` über das Ereignis
 * `auth.password_reset`. Die Route dahinter
 * (`POST /auth/customer/emailpass/reset-password`) läuft mit
 * `throwOnError: false` und antwortet IMMER mit 201 — egal ob es die Adresse
 * gibt. Genau deshalb darf hier nichts passieren, was diese Antwort
 * beeinflussen könnte; der Versand hängt am Event-Bus und nicht am Request.
 *
 * WAS HIER NICHT INS LOG DARF
 * Weder `data.token` noch `data.entity_id` (die E-Mail-Adresse). Das Token ist
 * 15 Minuten lang ein vollwertiger Zugang zum Konto, die Adresse ein
 * Personendatum nach DSG. Fehler werden deshalb ohne beides protokolliert.
 */

type PasswordResetEvent = {
  entity_id: string
  actor_type: string
  token: string
  metadata?: Record<string, unknown>
}

export default async function customerPasswordResetHandler({
  event: { data },
  container,
}: SubscriberArgs<PasswordResetEvent>) {
  // Dasselbe Ereignis feuert auch für Admin-Benutzer. Deren Reset-Link zeigt
  // in die Admin-Oberfläche, nicht in die Storefront — hier ist nur der
  // Kundenfall zuständig.
  if (data?.actor_type !== "customer") {
    return
  }

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const notification = container.resolve(Modules.NOTIFICATION)

  const email = data.entity_id
  if (!email || !data.token) {
    logger.warn("[auth] password_reset ohne Empfänger oder Token — nichts versendet.")
    return
  }

  let firstName: string | null = null
  try {
    const customerService = container.resolve(Modules.CUSTOMER)
    const [customer] = await customerService.listCustomers(
      { email },
      { select: ["first_name"], take: 1 }
    )
    firstName = customer?.first_name ?? null
  } catch {
    // Anrede ist Beiwerk. Eine E-Mail ohne Vornamen ist besser als keine.
  }

  try {
    const content = renderPasswordResetEmail({
      storeUrl: process.env.STORE_URL,
      storeName: process.env.STORE_NAME || "jibbit",
      token: data.token,
      firstName,
    })

    await notification.createNotifications({
      to: email,
      channel: "email",
      template: "customer-password-reset",
      // `data` landet in der Datenbank (Notification-Model), `content` nicht.
      // Deshalb steht der Link ausschliesslich in `content` — sonst läge in
      // der DB ein 15 Minuten gültiger Zugang zum Konto.
      data: { ttl_minutes: RESET_TOKEN_TTL_MINUTES },
      content,
      trigger_type: "auth.password_reset",
    })
  } catch (err) {
    // Absichtlich ohne `err.stack` und ohne die Ereignisdaten: nodemailer und
    // Medusa hängen den Empfänger gerne an ihre Fehlermeldungen.
    logger.error(
      `[auth] Passwort-E-Mail konnte nicht versendet werden: ${
        err instanceof Error ? err.name : "unbekannter Fehler"
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}
