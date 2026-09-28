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
  veralteteZahlsEnvNamen,
  zahlsEnvHinweise,
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

/**
 * Der Fall, der wochenlang unbemerkt blieb: die .env auf dem Server trug
 * nach dem Umstieg aufs offizielle Plugin (6385a4f, 03.09.2026) noch
 * ZAHLS_API_SECRET statt ZAHLS_API_KEY. Der Shop lief, registrierte den
 * Provider aber nie — jede Zahlung endete in 500 unknown_error.
 */
describe("zahlsEnvHinweise / veralteteZahlsEnvNamen", () => {
  it("alter Name gesetzt, neuer fehlt → Hinweis mit Umbenennung, und der Name gilt als veraltet", () => {
    const env = {
      ZAHLS_INSTANCE: "jibbit",
      ZAHLS_API_SECRET: "alter-schluessel",
      ZAHLS_WEBHOOK_SECRET: "test-secret",
    }
    const hinweise = zahlsEnvHinweise(env)
    expect(hinweise).toHaveLength(1)
    expect(hinweise[0]).toContain("ZAHLS_API_SECRET wurde am 03.09.2026 in ZAHLS_API_KEY umbenannt")
    expect(hinweise[0]).toContain("gleicher Wert")
    expect(veralteteZahlsEnvNamen(env)).toEqual(["ZAHLS_API_SECRET"])
    // Und unabhängig davon: der Provider gilt weiterhin als nicht konfiguriert.
    expect(isZahlsPluginConfigured(env)).toBe(false)
    expect(missingZahlsPluginEnv(env)).toEqual(["ZAHLS_API_KEY"])
  })

  it("nennt nie einen Wert, nur Namen", () => {
    const hinweise = zahlsEnvHinweise({ ZAHLS_API_SECRET: "geheim-1234" })
    expect(hinweise.join("\n")).not.toContain("geheim-1234")
  })

  it("beide gesetzt → kein veralteter Name (nur ein Aufräum-Hinweis, kein Fehler)", () => {
    const env = { ...complete, ZAHLS_API_SECRET: "alter-schluessel" }
    expect(veralteteZahlsEnvNamen(env)).toEqual([])
    expect(isZahlsPluginConfigured(env)).toBe(true)
    const hinweise = zahlsEnvHinweise(env)
    expect(hinweise).toHaveLength(1)
    expect(hinweise[0]).toContain("ZAHLS_API_SECRET ist gesetzt, wird aber seit 03.09.2026 nicht mehr gelesen")
    expect(hinweise[0]).not.toContain("umbenannt")
  })

  it("nur neue Namen gesetzt → keine Hinweise", () => {
    expect(zahlsEnvHinweise(complete)).toEqual([])
    expect(veralteteZahlsEnvNamen(complete)).toEqual([])
  })

  it("nichts gesetzt (Dev ohne Konto) → nur «fehlt», keine Hinweise, nichts veraltet", () => {
    expect(zahlsEnvHinweise({})).toEqual([])
    expect(veralteteZahlsEnvNamen({})).toEqual([])
    expect(missingZahlsPluginEnv({})).toEqual([
      "ZAHLS_INSTANCE",
      "ZAHLS_API_KEY",
      "ZAHLS_WEBHOOK_SECRET",
    ])
  })

  it("Whitespace im alten Namen zählt nicht als gesetzt", () => {
    expect(zahlsEnvHinweise({ ZAHLS_API_SECRET: "  " })).toEqual([])
    expect(veralteteZahlsEnvNamen({ ZAHLS_API_SECRET: "  " })).toEqual([])
  })

  it("PAYREXX_*-Namen des ersten Eigenbau-Stands werden ebenfalls erkannt", () => {
    const env = {
      PAYREXX_INSTANCE: "jibbit",
      PAYREXX_API_SECRET: "alt",
      PAYREXX_WEBHOOK_SECRET: "alt",
    }
    expect(veralteteZahlsEnvNamen(env)).toEqual([
      "PAYREXX_INSTANCE",
      "PAYREXX_API_SECRET",
      "PAYREXX_WEBHOOK_SECRET",
    ])
    const hinweise = zahlsEnvHinweise(env)
    expect(hinweise).toHaveLength(3)
    expect(hinweise[0]).toContain("PAYREXX_INSTANCE wurde am 03.09.2026 in ZAHLS_INSTANCE umbenannt")
    expect(hinweise[1]).toContain("PAYREXX_API_SECRET wurde am 03.09.2026 in ZAHLS_API_KEY umbenannt")
    expect(hinweise[2]).toContain("PAYREXX_WEBHOOK_SECRET wurde am 03.09.2026 in ZAHLS_WEBHOOK_SECRET umbenannt")
  })

  it("Namen ohne Nachfolger (API_BASE_URL, ENABLED_PSPS) → Aufräum-Hinweis, aber nie «veraltet»", () => {
    const env = {
      ...complete,
      ZAHLS_API_BASE_URL: "https://api.zahls.ch/v1.0/",
      ZAHLS_ENABLED_PSPS: "1,2",
      PAYREXX_API_BASE_URL: "https://api.payrexx.com/v1.0/",
      PAYREXX_ENABLED_PSPS: "3",
    }
    // Reste ohne Funktion dürfen den Start in Produktion NICHT abbrechen.
    expect(veralteteZahlsEnvNamen(env)).toEqual([])
    const hinweise = zahlsEnvHinweise(env)
    expect(hinweise.map((h) => h.split(" ")[0])).toEqual([
      "ZAHLS_API_BASE_URL",
      "ZAHLS_ENABLED_PSPS",
      "PAYREXX_API_BASE_URL",
      "PAYREXX_ENABLED_PSPS",
    ])
    for (const h of hinweise) expect(h).toContain("keine Funktion mehr")
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
