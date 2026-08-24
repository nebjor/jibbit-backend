/**
 * Konfigurationslogik für das zahls.ch-Plugin (src/lib/zahls-plugin.ts):
 * wann gilt es als konfiguriert, welche Optionen bekommt der Provider.
 *
 * Der kritische Fall ist das HALB gefüllte .env: das Plugin wirft in
 * validateOptions bei jedem fehlenden Pflichtwert, und zwar beim Laden des
 * Payment-Moduls — der Shop käme gar nicht hoch. medusa-config.ts
 * registriert den Provider deshalb nur, wenn isZahlsPluginConfigured()
 * true liefert. Diese Tests sichern genau diese Weiche.
 */

import {
  buildZahlsProviderOptions,
  isZahlsPluginConfigured,
  missingZahlsPluginEnv,
  ZAHLS_PROVIDER_ID,
  ZAHLS_WEBHOOK_PATH,
} from "../lib/zahls-plugin"

const complete = {
  ZAHLS_INSTANCE: "jibbit",
  ZAHLS_API_KEY: "test-key",
  ZAHLS_WEBHOOK_SECRET: "test-secret",
}

describe("isZahlsPluginConfigured", () => {
  it("true nur, wenn Instanz, API-Schlüssel und Webhook-Secret gesetzt sind", () => {
    expect(isZahlsPluginConfigured(complete)).toBe(true)
  })

  it("false bei leerem Env — der Shop startet ohne den Provider", () => {
    expect(isZahlsPluginConfigured({})).toBe(false)
  })

  it.each([
    ["ZAHLS_INSTANCE"],
    ["ZAHLS_API_KEY"],
    ["ZAHLS_WEBHOOK_SECRET"],
  ])("false, wenn %s fehlt (halb gefülltes .env legt den Shop nicht lahm)", (key) => {
    const env: Record<string, string> = { ...complete }
    delete env[key]
    expect(isZahlsPluginConfigured(env)).toBe(false)
  })

  it("reine Whitespace-Werte zählen als leer", () => {
    expect(
      isZahlsPluginConfigured({ ...complete, ZAHLS_API_KEY: "   " })
    ).toBe(false)
  })
})

describe("missingZahlsPluginEnv", () => {
  it("benennt exakt die fehlenden Pflichtvariablen (für die Start-Warnung)", () => {
    expect(missingZahlsPluginEnv({})).toEqual([
      "ZAHLS_INSTANCE",
      "ZAHLS_API_KEY",
      "ZAHLS_WEBHOOK_SECRET",
    ])
    expect(missingZahlsPluginEnv(complete)).toEqual([])
    expect(
      missingZahlsPluginEnv({ ...complete, ZAHLS_WEBHOOK_SECRET: "" })
    ).toEqual(["ZAHLS_WEBHOOK_SECRET"])
  })
})

describe("buildZahlsProviderOptions", () => {
  it("reicht Instanz, API-Schlüssel und Webhook-Secret unverändert durch", () => {
    const options = buildZahlsProviderOptions(complete)
    expect(options.instance).toBe("jibbit")
    expect(options.apiKey).toBe("test-key")
    expect(options.webhookSecret).toBe("test-secret")
  })

  it("leitet die Redirect-URLs aus STORE_URL ab (mehr muss niemand pflegen)", () => {
    const options = buildZahlsProviderOptions({
      ...complete,
      STORE_URL: "https://jibbit.ch",
    })
    expect(options.successRedirectUrl).toBe("https://jibbit.ch/checkout/success")
    expect(options.failedRedirectUrl).toBe("https://jibbit.ch/checkout/failed")
    expect(options.cancelRedirectUrl).toBe("https://jibbit.ch/checkout/cancel")
  })

  it("Slash am Ende von STORE_URL erzeugt keine Doppel-Slashes", () => {
    const options = buildZahlsProviderOptions({
      ...complete,
      STORE_URL: "https://jibbit.ch/",
    })
    expect(options.successRedirectUrl).toBe("https://jibbit.ch/checkout/success")
  })

  it("einzelne Redirects sind per Env übersteuerbar", () => {
    const options = buildZahlsProviderOptions({
      ...complete,
      STORE_URL: "https://jibbit.ch",
      ZAHLS_FAILED_URL: "https://jibbit.ch/de/zahlung-fehlgeschlagen",
    })
    expect(options.failedRedirectUrl).toBe(
      "https://jibbit.ch/de/zahlung-fehlgeschlagen"
    )
    expect(options.successRedirectUrl).toBe("https://jibbit.ch/checkout/success")
  })
})

describe("Konstanten", () => {
  it("Provider-Kennung und Webhook-Pfad passen zusammen (identifier 'zahls', id 'zahls')", () => {
    expect(ZAHLS_PROVIDER_ID).toBe("pp_zahls_zahls")
    expect(ZAHLS_WEBHOOK_PATH).toBe("/hooks/payment/zahls_zahls")
  })
})
