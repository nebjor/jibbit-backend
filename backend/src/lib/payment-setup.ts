/**
 * Zahlungs-Einrichtung prüfen — die reine Logik hinter
 * `src/scripts/check-payment-setup.ts`.
 *
 * ─── Warum es diese Datei gibt ────────────────────────────────────────────
 *
 * Die Kasse antwortet dem Kunden mit
 *
 *   «Die Zahlung liess sich nicht vorbereiten. Bitte nochmals versuchen.»
 *
 * wenn `POST /store/payment-collections/:id/payment-sessions` scheitert. Der
 * häufigste Grund ist NICHT ein Fehler in der Storefront, sondern eine
 * Region, die einen Zahlungsanbieter anbietet, den der laufende Prozess gar
 * nicht registriert hat. Medusa meldet das dann als
 *
 *   Unable to retrieve the payment provider with id: pp_zahls_zahls
 *
 * und antwortet der Storefront mit einem nackten 500 (`unknown_error`) —
 * ohne Hinweis darauf, was fehlt.
 *
 * ─── Warum `is_enabled` dabei NICHT hilft ─────────────────────────────────
 *
 * Man würde erwarten, dass ein nicht mehr registrierter Provider in der
 * Tabelle `payment_provider` auf `is_enabled = false` fällt. Auf Medusa
 * 2.13.6 passiert das NIE. Der Loader
 * (`@medusajs/payment/dist/loaders/providers.js`) liest die vorhandenen
 * Zeilen mit dem Filter `{ id: providersToLoad }` und setzt danach alles auf
 * `is_enabled = false`, was NICHT in `providersToLoad` steht — die Liste
 * enthält aber per Filter ausschliesslich Einträge AUS `providersToLoad`.
 * Der Zweig ist unerreichbar. Ein Provider, der einmal registriert war,
 * bleibt für immer `is_enabled = true`.
 *
 * Folge: weder die Storefront noch das Admin können der API ansehen, ob ein
 * Provider wirklich benutzbar ist. Deshalb dieser Abgleich gegen die
 * Umgebung des LAUFENDEN Prozesses.
 */

import {
  isZahlsPluginConfigured,
  missingZahlsPluginEnv,
  ZahlsPluginEnv,
  zahlsEnvHinweise,
  ZAHLS_PROVIDER_ID,
} from "./zahls-plugin"

/** Medusas eingebauter Provider — autorisiert OHNE Geldfluss. Dev/CI. */
export const SYSTEM_DEFAULT_PROVIDER_ID = "pp_system_default"

export interface RegionSetup {
  id: string
  name: string
  currencyCode: string
  /** Provider-IDs, die an dieser Region hängen (`region_payment_provider`). */
  providerIds: string[]
}

export interface PaymentSetupInput {
  regions: RegionSetup[]
  /** Provider-IDs, die dieser Prozess tatsächlich registriert hat. */
  registeredProviderIds: string[]
  /** `process.env` des laufenden Backends. */
  env: ZahlsPluginEnv & {
    NODE_ENV?: string
  }
}

export type FindingLevel = "fehler" | "warnung" | "ok"

export interface Finding {
  level: FindingLevel
  /** Eine Zeile fürs Terminal. Enthält nie einen Schlüsselwert. */
  text: string
}

/**
 * Die Provider-IDs, die ein Prozess mit dieser Umgebung registriert.
 *
 * `pp_system_default` registriert Medusas Payment-Modul immer selbst
 * (`loaders/providers.js`, `registrationFn(SystemPaymentProvider, …)`),
 * `pp_zahls_zahls` nur bei vollständiger ZAHLS_*-Konfiguration — genau die
 * Bedingung, die `medusa-config.ts` beim Start auswertet.
 */
export function expectedRegisteredProviders(
  env: PaymentSetupInput["env"],
): string[] {
  return [
    SYSTEM_DEFAULT_PROVIDER_ID,
    ...(isZahlsPluginConfigured(env) ? [ZAHLS_PROVIDER_ID] : []),
  ]
}

/**
 * Der Abgleich. Reine Funktion, damit die Aussage ohne laufendes Medusa
 * testbar ist.
 *
 * Reihenfolge der Befunde ist Absicht: zuerst das, was die Kasse gerade
 * kaputt macht, danach das, was sie demnächst kaputt macht.
 */
export function analysePaymentSetup(input: PaymentSetupInput): Finding[] {
  const { regions, registeredProviderIds, env } = input
  const registered = new Set(registeredProviderIds)
  const findings: Finding[] = []
  const produktion = env.NODE_ENV === "production"

  for (const region of regions) {
    const fehlend = region.providerIds.filter((id) => !registered.has(id))
    for (const id of fehlend) {
      findings.push({
        level: "fehler",
        text:
          `Region «${region.name}» bietet ${id} an, dieser Prozess hat den ` +
          `Provider aber NICHT registriert. Jede Zahlung über ihn scheitert ` +
          `mit «Unable to retrieve the payment provider with id: ${id}» — ` +
          `die Kasse zeigt dem Kunden «Die Zahlung liess sich nicht ` +
          `vorbereiten».`,
      })
    }

    // Was der Storefront nach ihren eigenen Regeln übrig bleibt: in einer
    // Produktionsumgebung weigert sie sich, pp_system_default zu nehmen
    // (jibbit-frontend, lib/checkout/payment.ts, `systemDefaultAllowed`).
    const brauchbar = region.providerIds.filter(
      (id) =>
        registered.has(id) && !(produktion && id === SYSTEM_DEFAULT_PROVIDER_ID),
    )
    if (!brauchbar.length) {
      findings.push({
        level: "fehler",
        text:
          `Region «${region.name}» hat keine für die Storefront brauchbare ` +
          `Zahlart` +
          (produktion
            ? " (pp_system_default zählt in Produktion nicht — er autorisiert ohne Geldfluss)."
            : "."),
      })
    } else if (produktion && region.providerIds.includes(SYSTEM_DEFAULT_PROVIDER_ID)) {
      findings.push({
        level: "warnung",
        text:
          `Region «${region.name}» führt noch pp_system_default. Vor dem ` +
          `Livegang von der Region nehmen — er autorisiert OHNE Geldfluss.`,
      })
    }

    if (!region.providerIds.includes(ZAHLS_PROVIDER_ID)) {
      findings.push({
        level: "warnung",
        text:
          `Region «${region.name}» führt ${ZAHLS_PROVIDER_ID} nicht. ` +
          `Admin → Einstellungen → Regionen → Zahlungsanbieter → zahls.ch.`,
      })
    }
  }

  if (!regions.length) {
    findings.push({ level: "fehler", text: "Es gibt gar keine Region." })
  }

  const fehlendeEnv = missingZahlsPluginEnv(env)
  if (fehlendeEnv.length) {
    findings.push({
      level: "fehler",
      text:
        `zahls.ch ist in dieser Umgebung nicht konfiguriert — es fehlt: ` +
        `${fehlendeEnv.join(", ")}. Ohne alle drei Werte registriert ` +
        `medusa-config.ts den Provider nicht (dieselbe Warnung steht beim ` +
        `Start im Log).`,
    })
  }

  // Der häufigste Grund für «es fehlt ZAHLS_API_KEY»: die .env trägt noch den
  // Namen aus der Zeit vor dem offiziellen Plugin (ZAHLS_API_SECRET). Der
  // Hinweis nennt die Zeile, die umzubenennen ist — nur den Namen.
  for (const hinweis of zahlsEnvHinweise(env)) {
    findings.push({
      level: fehlendeEnv.length ? "fehler" : "warnung",
      text: hinweis,
    })
  }

  if (!findings.some((f) => f.level === "fehler")) {
    findings.push({
      level: "ok",
      text: "Jede Region hat eine Zahlart, die dieser Prozess auch bedienen kann.",
    })
  }

  return findings
}

/** Beendet der Befund den Prozess mit Exit-Code 1? */
export function hatFehler(findings: Finding[]): boolean {
  return findings.some((f) => f.level === "fehler")
}
