/**
 * Konfigurations-Helfer für das offizielle zahls.ch-Plugin
 * (@zahls/medusa-plugin).
 *
 * Warum ausgelagert statt inline in medusa-config.ts: medusa-config wird von
 * Jest nicht geladen, diese Datei schon — so ist die Entscheidung «wann gilt
 * das Plugin als konfiguriert?» und der Aufbau der Provider-Optionen
 * unit-testbar (src/__tests__/zahls-plugin-config.unit.spec.ts).
 *
 * ─── Verhalten bei unvollständiger Konfiguration ──────────────────────────
 *
 * `ZahlsPaymentProviderService.validateOptions()` im Plugin WIRFT, sobald
 * apiKey, instance oder webhookSecret fehlt — und zwar beim Modul-Laden,
 * d.h. Medusa käme gar nicht hoch (leeres webhookSecret bei gesetzter
 * Instanz = Boot-Abbruch).
 *
 * Deshalb registriert medusa-config.ts den Provider NUR, wenn alle drei
 * Pflichtwerte gesetzt sind. Ein halb gefülltes .env startet den Shop damit
 * normal — es fehlt dann lediglich der zahls.ch-Provider im Checkout, was
 * beim Start als Warnung geloggt wird (siehe medusa-config.ts).
 */

export interface ZahlsPluginEnv {
  ZAHLS_INSTANCE?: string
  ZAHLS_API_KEY?: string
  ZAHLS_WEBHOOK_SECRET?: string
  ZAHLS_SUCCESS_URL?: string
  ZAHLS_FAILED_URL?: string
  ZAHLS_CANCEL_URL?: string
  STORE_URL?: string
}

/**
 * Provider-Kennung, wie Medusa sie aus dem Plugin bildet:
 * `pp_${identifier}_${id}` mit identifier "zahls" (statische Eigenschaft der
 * Service-Klasse im Plugin) und id "zahls" (unsere Registrierung in
 * medusa-config.ts). Diese Kennung erwartet der Checkout an der Region —
 * siehe src/scripts/seed.ts.
 */
export const ZAHLS_PROVIDER_ID = "pp_zahls_zahls"

/**
 * Medusas EINGEBAUTE Webhook-Route für Payment-Provider:
 * `/hooks/payment/[identifier]_[id]`. Das Plugin bringt keine eigene Route
 * mit, es nutzt diese. Vollständige Adresse fürs zahls.ch-Backend:
 *
 *   https://<API_DOMAIN>/hooks/payment/zahls_zahls
 *
 * zahls.ch prüft die Adresse beim Eintragen mit einem GET — den beantwortet
 * src/api/hooks/payment/zahls_zahls/route.ts, sonst gäbe es dort 404 und
 * zahls.ch wiese die Adresse als «nicht gültig» zurück.
 */
export const ZAHLS_WEBHOOK_PATH = "/hooks/payment/zahls_zahls"

/**
 * Konfiguriert = alle drei Pflichtwerte vorhanden und nicht leer.
 * Reine Whitespace-Werte zählen als leer — ein " " in der .env ist immer
 * ein Versehen, kein API-Schlüssel.
 */
export function isZahlsPluginConfigured(env: ZahlsPluginEnv): boolean {
  return Boolean(
    env.ZAHLS_INSTANCE?.trim() &&
      env.ZAHLS_API_KEY?.trim() &&
      env.ZAHLS_WEBHOOK_SECRET?.trim()
  )
}

/**
 * Welche Pflichtwerte fehlen — für die Start-Warnung, damit im Log steht,
 * WAS nachzutragen ist, ohne einen Wert selbst auszugeben.
 */
export function missingZahlsPluginEnv(env: ZahlsPluginEnv): string[] {
  const missing: string[] = []
  if (!env.ZAHLS_INSTANCE?.trim()) missing.push("ZAHLS_INSTANCE")
  if (!env.ZAHLS_API_KEY?.trim()) missing.push("ZAHLS_API_KEY")
  if (!env.ZAHLS_WEBHOOK_SECRET?.trim()) missing.push("ZAHLS_WEBHOOK_SECRET")
  return missing
}

/**
 * Optionen für den Provider-Eintrag in medusa-config.ts.
 *
 * Der Betreiber muss nur Instanzname, API-Schlüssel und Webhook-Secret
 * hinterlegen. Die Redirect-URLs leiten sich aus STORE_URL ab (dieselbe
 * Variable, die schon die Passwort-Reset-Mail nutzt) und sind nur für
 * Sonderfälle einzeln übersteuerbar.
 *
 * Zu den Pfaden /checkout/success|failed|cancel: das Plugin kann keine
 * session-spezifische Query anhängen (statische URLs pro Provider), die
 * Storefront darf sich hier also NICHT auf ?payment_session_id=… verlassen —
 * massgeblich ist ohnehin der Webhook, nie der Redirect.
 */
export function buildZahlsProviderOptions(env: ZahlsPluginEnv) {
  const storeUrl = (env.STORE_URL || "http://localhost:8000").replace(/\/+$/, "")
  return {
    apiKey: env.ZAHLS_API_KEY,
    instance: env.ZAHLS_INSTANCE,
    webhookSecret: env.ZAHLS_WEBHOOK_SECRET,
    successRedirectUrl: env.ZAHLS_SUCCESS_URL || `${storeUrl}/checkout/success`,
    failedRedirectUrl: env.ZAHLS_FAILED_URL || `${storeUrl}/checkout/failed`,
    cancelRedirectUrl: env.ZAHLS_CANCEL_URL || `${storeUrl}/checkout/cancel`,
  }
}
