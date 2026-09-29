/**
 * Inhalt der Einladung für neue Admin-Benutzer.
 *
 * Wie beim Passwort-Reset gilt: Die Basis-URL kommt aus `MEDUSA_BACKEND_URL`
 * und nie aus einem Request-Header, und das Token steht nur im gerenderten
 * Text, nicht in `data` der Notification (das landet in der Datenbank).
 */

import type { EmailContent } from "./notify"
import { adminUrl, escapeHtml } from "./email-format"

/** Route des Admin-Dashboards (`@medusajs/dashboard`, routes/invite), liest `?token=`. */
export const ADMIN_INVITE_PATH = "/invite"

export function buildInviteUrl(backendUrl: string | undefined, token: string): string {
  const url = adminUrl(backendUrl, ADMIN_INVITE_PATH)
  if (!token?.trim()) {
    throw new Error("Einladungslink ohne Token angefordert.")
  }
  url.searchParams.set("token", token)
  return url.toString()
}

/**
 * Gültigkeit in Worten, aus dem Ablaufdatum der Einladung gerechnet. Die Dauer
 * legt das User-Modul fest (Vorgabe 24 Stunden, `valid_duration`); die Mail
 * nennt, was am Invite steht, statt eine Zahl zu wiederholen.
 */
export function validityText(expiresAt: unknown, now: number = Date.now()): string {
  const time =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string" || typeof expiresAt === "number"
        ? new Date(expiresAt).getTime()
        : NaN
  const hours = Math.round((time - now) / (60 * 60 * 1000))
  if (!Number.isFinite(hours) || hours < 1) {
    return "Der Link ist nur kurze Zeit gültig."
  }
  if (hours >= 48) {
    return `Der Link ist ${Math.floor(hours / 24)} Tage gültig.`
  }
  return hours === 1 ? "Der Link ist 1 Stunde gültig." : `Der Link ist ${hours} Stunden gültig.`
}

export interface InviteRenderInput {
  backendUrl: string | undefined
  storeName: string
  token: string
  expiresAt?: unknown
  now?: number
}

export function renderInviteEmail(input: InviteRenderInput): EmailContent {
  const store = input.storeName
  const link = buildInviteUrl(input.backendUrl, input.token)
  const validity = validityText(input.expiresAt, input.now)
  const intro = `Du bist eingeladen, im Admin von ${store} mitzuarbeiten.`
  const expired =
    "Ist er abgelaufen, bitte die Person, die dich eingeladen hat, die Einladung noch einmal zu senden."
  const ignore = "Hast du keine Einladung erwartet, kannst du diese E-Mail ignorieren."

  const text = [
    `Hallo`,
    ``,
    intro,
    `Über diesen Link legst du deinen Zugang an und setzt dein Passwort:`,
    ``,
    link,
    ``,
    validity,
    expired,
    ``,
    ignore,
    ``,
    store,
  ].join("\n")

  const html = [
    `<p>Hallo</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(link)}">Einladung annehmen und Zugang anlegen</a></p>`,
    `<p>${escapeHtml(validity)} ${escapeHtml(expired)}</p>`,
    `<p>${escapeHtml(ignore)}</p>`,
    `<p>${escapeHtml(store)}</p>`,
  ].join("\n")

  return { subject: `${store}: Einladung ins Admin`, text, html }
}
