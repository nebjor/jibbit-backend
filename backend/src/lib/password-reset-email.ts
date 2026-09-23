/**
 * Inhalt der Passwort-zurücksetzen-E-Mails für Kundschaft und Admin-Benutzer.
 *
 * ZWEI DINGE, DIE HIER SICHERHEITSRELEVANT SIND
 *
 * 1. Die Basis-URL kommt aus der Umgebung (`STORE_URL` bzw.
 *    `MEDUSA_BACKEND_URL`) und NIEMALS aus einem Request-Header. Ein aus
 *    `Host` gebauter Link liesse einen Angreifer eine echte E-Mail von uns
 *    auslösen, deren Link das Reset-Token an seinen Server liefert.
 *
 * 2. Das Token steht ausschliesslich im gerenderten Text, nicht in `data`
 *    der Notification. `data` persistiert das Notification-Modul in der
 *    Datenbank, `content` nicht.
 */

import type { EmailContent } from "./notify"
import { absoluteUrl, adminUrl, escapeHtml } from "./email-format"

/**
 * Medusas `generateResetPasswordTokenWorkflow` setzt `expiresIn: "15m"` fest —
 * die E-Mail nennt dieselbe Frist, die der Server tatsächlich durchsetzt.
 */
export const RESET_TOKEN_TTL_MINUTES = 15

/** Pfad der Storefront-Seite, die das Formular zum Neusetzen zeigt. */
export const RESET_PATH = "/konto/passwort-neu"

/** Route des Admin-Dashboards (`@medusajs/dashboard`, routes/reset-password), liest `?token=`. */
export const ADMIN_RESET_PATH = "/reset-password"

function requireToken(token: string): void {
  if (!token?.trim()) {
    throw new Error("Reset-Link ohne Token angefordert.")
  }
}

export function buildResetUrl(storeUrl: string | undefined, token: string): string {
  const url = absoluteUrl(storeUrl, "STORE_URL", RESET_PATH)
  requireToken(token)
  url.searchParams.set("token", token)
  return url.toString()
}

export function buildAdminResetUrl(backendUrl: string | undefined, token: string): string {
  const url = adminUrl(backendUrl, ADMIN_RESET_PATH)
  requireToken(token)
  url.searchParams.set("token", token)
  return url.toString()
}

interface ResetMailParts {
  store: string
  greeting: string
  account: string
  link: string
  extra: string[]
}

function renderResetMail({ store, greeting, account, link, extra }: ResetMailParts): EmailContent {
  const text = [
    greeting,
    ``,
    `Für ${account} wurde ein neues Passwort angefordert.`,
    `Über diesen Link kannst du eines setzen:`,
    ``,
    link,
    ``,
    `Der Link ist ${RESET_TOKEN_TTL_MINUTES} Minuten gültig und lässt sich nur einmal sinnvoll verwenden.`,
    `Ist er abgelaufen, fordere auf der Anmeldeseite einfach einen neuen an.`,
    ``,
    `Hast du kein neues Passwort angefordert, kannst du diese E-Mail ignorieren —`,
    `dein bisheriges Passwort bleibt unverändert.`,
    ...extra.flatMap((line) => [``, line]),
    ``,
    store,
  ].join("\n")

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>Für ${escapeHtml(account)} wurde ein neues Passwort angefordert.</p>`,
    `<p><a href="${escapeHtml(link)}">Neues Passwort setzen</a></p>`,
    `<p>Der Link ist ${RESET_TOKEN_TTL_MINUTES} Minuten gültig. Ist er abgelaufen, fordere auf der Anmeldeseite einfach einen neuen an.</p>`,
    `<p>Hast du kein neues Passwort angefordert, kannst du diese E-Mail ignorieren — dein bisheriges Passwort bleibt unverändert.</p>`,
    ...extra.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p>${escapeHtml(store)}</p>`,
  ].join("\n")

  return { subject: `${store}: Passwort zurücksetzen`, text, html }
}

export interface RenderInput {
  storeUrl: string | undefined
  storeName: string
  token: string
  firstName?: string | null
}

export function renderPasswordResetEmail(input: RenderInput): EmailContent {
  const name = input.firstName?.trim()
  // Der Umzugshinweis steht in JEDER Kunden-Mail: stünde er nur bei migrierten
  // Konten, verriete die E-Mail selbst die Herkunft aus dem Odoo-Import.
  return renderResetMail({
    store: input.storeName,
    greeting: name ? `Hallo ${name}` : "Hallo",
    account: `dein Konto bei ${input.storeName}`,
    link: buildResetUrl(input.storeUrl, input.token),
    extra: [
      "Kommst du aus unserem früheren Shop? Dann ist dieser Schritt einmalig nötig: Passwörter lassen sich technisch nicht übernehmen.",
    ],
  })
}

export interface AdminRenderInput {
  backendUrl: string | undefined
  storeName: string
  token: string
}

export function renderAdminPasswordResetEmail(input: AdminRenderInput): EmailContent {
  return renderResetMail({
    store: input.storeName,
    greeting: "Hallo",
    account: `deinen Admin-Zugang bei ${input.storeName}`,
    link: buildAdminResetUrl(input.backendUrl, input.token),
    extra: [],
  })
}
