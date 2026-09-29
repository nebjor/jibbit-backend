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
  // Veraltete Namen früherer Stände — siehe ZAHLS_ENV_UMBENENNUNGEN.
  ZAHLS_API_SECRET?: string
  ZAHLS_API_BASE_URL?: string
  ZAHLS_ENABLED_PSPS?: string
  PAYREXX_INSTANCE?: string
  PAYREXX_API_SECRET?: string
  PAYREXX_WEBHOOK_SECRET?: string
  PAYREXX_API_BASE_URL?: string
  PAYREXX_ENABLED_PSPS?: string
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
 * ─── Veraltete Variablennamen ─────────────────────────────────────────────
 *
 * Die Zahlungsanbindung hat zwei Umbauten hinter sich, und jeder hat die
 * Variablennamen verändert:
 *
 *   1. Eigenbau-Modul gegen die Payrexx-API      PAYREXX_INSTANCE,
 *      (bis db6026f)                              PAYREXX_API_SECRET,
 *                                                 PAYREXX_WEBHOOK_SECRET,
 *                                                 PAYREXX_API_BASE_URL,
 *                                                 PAYREXX_ENABLED_PSPS
 *   2. dasselbe Eigenbau-Modul unter ZAHLS_-Namen  ZAHLS_INSTANCE,
 *      (bis 6385a4f, 03.09.2026)                  ZAHLS_API_SECRET,
 *                                                 ZAHLS_WEBHOOK_SECRET,
 *                                                 ZAHLS_API_BASE_URL,
 *                                                 ZAHLS_ENABLED_PSPS
 *   3. offizielles Plugin (@zahls/medusa-plugin)  ZAHLS_INSTANCE,
 *      (seit 6385a4f, 03.09.2026)                 ZAHLS_API_KEY,
 *                                                 ZAHLS_WEBHOOK_SECRET
 *
 * Die .env auf dem Server wandert bei einem Deploy NICHT mit — sie kennt
 * nur die Namen, die beim Einrichten galten. Nach Umbau 3 stand dort
 * weiterhin ZAHLS_API_SECRET; ZAHLS_API_KEY blieb leer. Die Folge war kein
 * Startfehler, sondern ein Shop, der wochenlang «normal» lief, in dessen
 * Kasse aber jede Zahlung mit 500 unknown_error endete (die Region bot den
 * Provider weiter an, der Prozess hatte ihn nie registriert). Die einzige
 * Spur war eine console.warn-Zeile beim Start.
 *
 * Deshalb erkennt zahlsEnvHinweise() diese Reste und sagt im Klartext, welche
 * Zeile umzubenennen ist. medusa-config.ts macht daraus in Produktion einen
 * Startabbruch (ein umbenannter Name ist ein Konfigurationsfehler, kein
 * «noch nicht eingerichtet»).
 */

/**
 * Alter Name → neuer Name. Bei ZAHLS_API_SECRET ist es derselbe Wert (gleiches
 * Konto, nur der Name im Plugin heisst apiKey). Bei den PAYREXX_-Namen sprach
 * das Eigenbau-Modul möglicherweise ein Payrexx-Konto an — dann ist der Wert
 * neu aus dem zahls.ch-Backend zu holen.
 */
export const ZAHLS_ENV_UMBENENNUNGEN: ReadonlyArray<{
  alt: keyof ZahlsPluginEnv
  neu: "ZAHLS_INSTANCE" | "ZAHLS_API_KEY" | "ZAHLS_WEBHOOK_SECRET"
  seit: string
  wert: string
}> = [
  {
    alt: "ZAHLS_API_SECRET",
    neu: "ZAHLS_API_KEY",
    seit: "03.09.2026",
    wert: "gleicher Wert",
  },
  {
    alt: "PAYREXX_INSTANCE",
    neu: "ZAHLS_INSTANCE",
    seit: "03.09.2026",
    wert: "Wert prüfen: Instanzname der zahls.ch-Instanz",
  },
  {
    alt: "PAYREXX_API_SECRET",
    neu: "ZAHLS_API_KEY",
    seit: "03.09.2026",
    wert: "Wert prüfen: API-Schlüssel aus dem zahls.ch-Backend",
  },
  {
    alt: "PAYREXX_WEBHOOK_SECRET",
    neu: "ZAHLS_WEBHOOK_SECRET",
    seit: "03.09.2026",
    wert: "Wert prüfen: Signatur-Schlüssel aus dem zahls.ch-Backend",
  },
]

/** Namen ohne Nachfolger — das Plugin kennt sie nicht, sie tun nichts mehr. */
export const ZAHLS_ENV_OHNE_FUNKTION: ReadonlyArray<keyof ZahlsPluginEnv> = [
  "ZAHLS_API_BASE_URL",
  "ZAHLS_ENABLED_PSPS",
  "PAYREXX_API_BASE_URL",
  "PAYREXX_ENABLED_PSPS",
]

/**
 * Ist ein umbenannter Name gesetzt, während sein Nachfolger leer ist?
 *
 * Genau dieser Fall ist ein Konfigurationsfehler (die Zeile in der .env
 * wurde nicht umbenannt) und kein «noch kein Konto» — medusa-config.ts
 * bricht damit in Produktion den Start ab. Ein alter Name NEBEN dem gesetzten
 * neuen ist nur ein Rest und kein Fehler.
 */
export function veralteteZahlsEnvNamen(env: ZahlsPluginEnv): string[] {
  return ZAHLS_ENV_UMBENENNUNGEN.filter(
    ({ alt, neu }) => env[alt]?.trim() && !env[neu]?.trim()
  ).map(({ alt }) => alt)
}

/**
 * Hinweise für Start-Warnung und Diagnose-Script (check-payment-setup.ts):
 * je eine Zeile pro veraltetem Namen, der noch in der Umgebung steht. Nennt
 * nur Namen, nie Werte. Leer, wenn nichts Veraltetes gesetzt ist — auch bei
 * völlig leerer Umgebung (Dev ohne Konto), dafür ist missingZahlsPluginEnv
 * zuständig.
 */
export function zahlsEnvHinweise(env: ZahlsPluginEnv): string[] {
  const hinweise: string[] = []

  for (const { alt, neu, seit, wert } of ZAHLS_ENV_UMBENENNUNGEN) {
    if (!env[alt]?.trim()) continue
    if (env[neu]?.trim()) {
      hinweise.push(
        `${alt} ist gesetzt, wird aber seit ${seit} nicht mehr gelesen — ` +
          `${neu} gilt. Die alte Zeile kann aus der .env weg.`
      )
    } else {
      hinweise.push(
        `${alt} wurde am ${seit} in ${neu} umbenannt (offizielles Plugin) — ` +
          `Zeile in der .env umbenennen, ${wert}. Solange ${neu} leer ` +
          `ist, wird der zahls.ch-Provider nicht registriert.`
      )
    }
  }

  for (const alt of ZAHLS_ENV_OHNE_FUNKTION) {
    if (env[alt]?.trim()) {
      hinweise.push(
        `${alt} ist gesetzt, hat seit 03.09.2026 aber keine Funktion mehr ` +
          `(offizielles Plugin) — Zeile aus der .env entfernen.`
      )
    }
  }

  return hinweise
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
