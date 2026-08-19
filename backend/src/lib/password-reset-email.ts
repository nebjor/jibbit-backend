/**
 * Inhalt der Passwort-zurücksetzen-E-Mail — bewusst als reine Funktion,
 * ohne Container, ohne I/O, damit sie im Unit-Test geprüft werden kann.
 *
 * ZWEI DINGE, DIE HIER SICHERHEITSRELEVANT SIND
 *
 * 1. Die Basis-URL kommt aus `STORE_URL` (Umgebung des Backends) und NIEMALS
 *    aus einem Request-Header. Baut man den Link aus `Host` oder
 *    `X-Forwarded-Host`, kann ein Angreifer eine Anfrage mit fremdem Host
 *    stellen; das Opfer bekommt dann eine echte E-Mail von uns, deren Link
 *    auf den Server des Angreifers zeigt — und klickt es, liefert der Browser
 *    das Reset-Token gleich mit. Der Weg über die Umgebung schliesst das aus.
 *
 * 2. Das Token steht ausschliesslich im gerenderten Text, nicht in `data`
 *    der Notification. Das Notification-Modul persistiert `data` in der
 *    Datenbank (siehe Kommentar im Medusa-Model: "also for GDPR reasons"),
 *    `content` dagegen hat keine Spalte und wird nur an den Provider
 *    durchgereicht. So liegt kein gültiges Zugangs-Token in der DB.
 */

/**
 * Medusas `generateResetPasswordTokenWorkflow` setzt `expiresIn: "15m"` fest —
 * hart kodiert, nicht konfigurierbar. Der Wert steht hier nur, damit die
 * E-Mail dieselbe Frist nennt, die der Server tatsächlich durchsetzt.
 */
export const RESET_TOKEN_TTL_MINUTES = 15

/** Pfad der Storefront-Seite, die das Formular zum Neusetzen zeigt. */
export const RESET_PATH = "/konto/passwort-neu"

export interface PasswordResetEmail {
  subject: string
  text: string
  html: string
}

/**
 * Baut den Link zum Formular. Wirft, wenn `storeUrl` fehlt oder kein
 * http(s)-Ursprung ist — lieber gar keine E-Mail als eine mit kaputtem oder
 * gefährlichem Link.
 */
export function buildResetUrl(storeUrl: string | undefined, token: string): string {
  if (!storeUrl?.trim()) {
    throw new Error(
      "STORE_URL ist nicht gesetzt — ohne Basis-URL lässt sich kein Reset-Link bauen."
    )
  }
  if (!token?.trim()) {
    throw new Error("Reset-Link ohne Token angefordert.")
  }

  let base: URL
  try {
    base = new URL(storeUrl)
  } catch {
    throw new Error("STORE_URL ist keine gültige URL.")
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("STORE_URL muss http oder https sein.")
  }

  const url = new URL(RESET_PATH, base)
  url.searchParams.set("token", token)
  return url.toString()
}

/** Minimales HTML-Escaping für die Werte, die in die HTML-Variante wandern. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export interface RenderInput {
  storeUrl: string | undefined
  storeName: string
  token: string
  /** Vorname, falls bekannt. Leer lassen ist völlig in Ordnung. */
  firstName?: string | null
}

export function renderPasswordResetEmail(input: RenderInput): PasswordResetEmail {
  const link = buildResetUrl(input.storeUrl, input.token)
  const name = input.firstName?.trim()
  const anrede = name ? `Hallo ${name}` : "Hallo"
  const store = input.storeName

  const subject = `${store}: Passwort zurücksetzen`

  // Der Hinweis auf den alten Shop steht in JEDER dieser E-Mails, nicht nur
  // in denen an migrierte Kundinnen und Kunden. Stünde er nur dort, wäre die
  // E-Mail selbst das Signal "dieses Konto stammt aus dem Odoo-Import".
  const text = [
    `${anrede}`,
    ``,
    `Für dein Konto bei ${store} wurde ein neues Passwort angefordert.`,
    `Über diesen Link kannst du eines setzen:`,
    ``,
    link,
    ``,
    `Der Link ist ${RESET_TOKEN_TTL_MINUTES} Minuten gültig und lässt sich nur einmal sinnvoll verwenden.`,
    `Ist er abgelaufen, fordere auf der Anmeldeseite einfach einen neuen an.`,
    ``,
    `Hast du kein neues Passwort angefordert, kannst du diese E-Mail ignorieren —`,
    `dein bisheriges Passwort bleibt unverändert.`,
    ``,
    `Kommst du aus unserem früheren Shop? Dann ist dieser Schritt einmalig nötig:`,
    `Passwörter lassen sich technisch nicht übernehmen.`,
    ``,
    `${store}`,
  ].join("\n")

  const html = [
    `<p>${escapeHtml(anrede)}</p>`,
    `<p>Für dein Konto bei ${escapeHtml(store)} wurde ein neues Passwort angefordert.</p>`,
    `<p><a href="${escapeHtml(link)}">Neues Passwort setzen</a></p>`,
    `<p>Der Link ist ${RESET_TOKEN_TTL_MINUTES} Minuten gültig. Ist er abgelaufen, fordere auf der Anmeldeseite einfach einen neuen an.</p>`,
    `<p>Hast du kein neues Passwort angefordert, kannst du diese E-Mail ignorieren — dein bisheriges Passwort bleibt unverändert.</p>`,
    `<p>Kommst du aus unserem früheren Shop? Dann ist dieser Schritt einmalig nötig: Passwörter lassen sich technisch nicht übernehmen.</p>`,
    `<p>${escapeHtml(store)}</p>`,
  ].join("\n")

  return { subject, text, html }
}
