/**
 * Der Abgleich «Region bietet an» ↔ «Prozess registriert».
 *
 * Der Fall, den diese Datei festhält, ist der, der die Kasse auf test.jibbit.ch
 * mit «Die Zahlung liess sich nicht vorbereiten» antworten lässt: die Region
 * führt pp_zahls_zahls weiter, der laufende Prozess registriert ihn aber
 * nicht (weil ein ZAHLS_*-Wert fehlt). Von aussen ist das nicht zu sehen —
 * `GET /store/payment-providers` liefert den Provider trotzdem aus, und
 * `is_enabled` bleibt auf 2.13.6 für immer `true`.
 */

import {
  analysePaymentSetup,
  expectedRegisteredProviders,
  hatFehler,
  SYSTEM_DEFAULT_PROVIDER_ID,
} from "../lib/payment-setup"
import { ZAHLS_PROVIDER_ID } from "../lib/zahls-plugin"

const VOLLE_ENV = {
  NODE_ENV: "production",
  ZAHLS_INSTANCE: "jibbit",
  ZAHLS_API_KEY: "key",
  ZAHLS_WEBHOOK_SECRET: "secret",
}

function region(providerIds: string[]) {
  return [
    { id: "reg_1", name: "Schweiz", currencyCode: "CHF", providerIds },
  ]
}

describe("expectedRegisteredProviders", () => {
  it("registriert zahls.ch nur bei vollständiger Konfiguration", () => {
    expect(expectedRegisteredProviders(VOLLE_ENV)).toEqual([
      SYSTEM_DEFAULT_PROVIDER_ID,
      ZAHLS_PROVIDER_ID,
    ])
  })

  it("laesst zahls.ch weg, sobald ein Pflichtwert fehlt", () => {
    expect(
      expectedRegisteredProviders({ ...VOLLE_ENV, ZAHLS_API_KEY: "" })
    ).toEqual([SYSTEM_DEFAULT_PROVIDER_ID])
    // Reiner Whitespace zaehlt als leer — ein " " ist nie ein Schluessel.
    expect(
      expectedRegisteredProviders({ ...VOLLE_ENV, ZAHLS_WEBHOOK_SECRET: "  " })
    ).toEqual([SYSTEM_DEFAULT_PROVIDER_ID])
  })
})

describe("analysePaymentSetup", () => {
  it("meldet den echten Ausfall: Region bietet an, was der Prozess nicht kennt", () => {
    const findings = analysePaymentSetup({
      regions: region([ZAHLS_PROVIDER_ID]),
      registeredProviderIds: [SYSTEM_DEFAULT_PROVIDER_ID],
      env: { ...VOLLE_ENV, ZAHLS_API_KEY: "" },
    })

    expect(hatFehler(findings)).toBe(true)
    const texte = findings.map((f) => f.text).join("\n")
    expect(texte).toContain("Unable to retrieve the payment provider")
    expect(texte).toContain(ZAHLS_PROVIDER_ID)
    // Der fehlende Wert wird benannt …
    expect(texte).toContain("ZAHLS_API_KEY")
    // … aber nie ein Wert ausgegeben.
    expect(texte).not.toContain("secret")
  })

  it("nennt eine Region ohne brauchbare Zahlart als Fehler (Produktion)", () => {
    const findings = analysePaymentSetup({
      regions: region([SYSTEM_DEFAULT_PROVIDER_ID]),
      registeredProviderIds: [SYSTEM_DEFAULT_PROVIDER_ID],
      env: { ...VOLLE_ENV, ZAHLS_INSTANCE: "", ZAHLS_API_KEY: "", ZAHLS_WEBHOOK_SECRET: "" },
    })

    expect(hatFehler(findings)).toBe(true)
    expect(findings.map((f) => f.text).join("\n")).toContain(
      "keine für die Storefront brauchbare Zahlart"
    )
  })

  it("laesst pp_system_default ausserhalb der Produktion gelten", () => {
    const findings = analysePaymentSetup({
      regions: region([SYSTEM_DEFAULT_PROVIDER_ID]),
      registeredProviderIds: [SYSTEM_DEFAULT_PROVIDER_ID],
      env: { NODE_ENV: "development" },
    })

    // Kein Fehler — nur Warnungen (zahls.ch fehlt an der Region, Env leer …).
    expect(findings.filter((f) => f.level === "fehler").map((f) => f.text))
      .toEqual([
        expect.stringContaining("zahls.ch ist in dieser Umgebung nicht konfiguriert"),
      ])
  })

  it("warnt in Produktion, solange pp_system_default an der Region haengt", () => {
    const findings = analysePaymentSetup({
      regions: region([SYSTEM_DEFAULT_PROVIDER_ID, ZAHLS_PROVIDER_ID]),
      registeredProviderIds: [SYSTEM_DEFAULT_PROVIDER_ID, ZAHLS_PROVIDER_ID],
      env: VOLLE_ENV,
    })

    expect(hatFehler(findings)).toBe(false)
    expect(findings.map((f) => f.text).join("\n")).toContain(
      "autorisiert OHNE Geldfluss"
    )
  })

  it("ist still, wenn alles passt", () => {
    const findings = analysePaymentSetup({
      regions: region([ZAHLS_PROVIDER_ID]),
      registeredProviderIds: [SYSTEM_DEFAULT_PROVIDER_ID, ZAHLS_PROVIDER_ID],
      env: VOLLE_ENV,
    })

    expect(findings).toEqual([
      {
        level: "ok",
        text: "Jede Region hat eine Zahlart, die dieser Prozess auch bedienen kann.",
      },
    ])
  })
})
