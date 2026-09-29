/**
 * «Warum sagt die Kasse *Die Zahlung liess sich nicht vorbereiten*?»
 *
 *   cd backend
 *   npx medusa exec ./src/scripts/check-payment-setup.ts
 *
 * Auf dem Server — im Container liegt nur kompilierter Code (`medusa build`),
 * dort heisst die Datei `.js`; `.ts` gilt nur lokal aus dem Quellbaum:
 *
 *   docker compose exec medusa npx medusa exec ./src/scripts/check-payment-setup.js
 *
 * Der Bericht liest NUR. Er nennt in einem Durchgang:
 *
 *   1. welche zahls.ch-Pflichtwerte in DIESER Umgebung fehlen (nie den Wert
 *      selbst, nur den Namen),
 *   2. welche Zahlungsanbieter in der Datenbank stehen,
 *   3. welche davon an welcher Region hängen,
 *   4. und wo beides nicht zusammenpasst.
 *
 * ─── Warum es diesen Bericht braucht ──────────────────────────────────────
 *
 * Hängt an der Region ein Provider, den der laufende Prozess nicht
 * registriert hat, scheitert `POST /store/payment-collections/:id/
 * payment-sessions` im Payment-Modul mit
 *
 *   Unable to retrieve the payment provider with id: pp_zahls_zahls
 *
 * Medusa macht daraus einen nackten 500 (`unknown_error`). Die Storefront
 * bekommt also keinen Grund geliefert und kann dem Kunden nur sagen, dass
 * es nicht ging. Von aussen ist dieser Fall nicht von einem Ausfall bei
 * zahls.ch zu unterscheiden — dieser Bericht trennt die beiden.
 *
 * `is_enabled` in der Tabelle `payment_provider` hilft dabei NICHT: auf
 * Medusa 2.13.6 wird das Flag nie auf `false` zurückgesetzt (siehe
 * src/lib/payment-setup.ts, Abschnitt «Warum is_enabled dabei nicht hilft»).
 * Es steht hier nur der Vollständigkeit halber.
 */

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  analysePaymentSetup,
  expectedRegisteredProviders,
  hatFehler,
  RegionSetup,
} from "../lib/payment-setup"

const SYMBOL: Record<string, string> = {
  fehler: "✗",
  warnung: "!",
  ok: "✓",
}

export default async function checkPaymentSetup({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const paymentModuleService = container.resolve(Modules.PAYMENT)

  const { data: regionRows } = await query.graph({
    entity: "region",
    fields: [
      "id",
      "name",
      "currency_code",
      "payment_providers.id",
      "payment_providers.is_enabled",
    ],
  })

  const regions: RegionSetup[] = (regionRows as any[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? r.id),
    currencyCode: String(r.currency_code ?? "").toUpperCase(),
    providerIds: (r.payment_providers ?? [])
      .map((p: any) => String(p?.id ?? ""))
      .filter(Boolean),
  }))

  const dbProviders = await paymentModuleService.listPaymentProviders({})

  /**
   * Was dieser Prozess wirklich registriert. Bewusst aus der Umgebung
   * abgeleitet und nicht aus dem Awilix-Container gelesen: es ist exakt die
   * Bedingung, die `medusa-config.ts` beim Start auswertet, und sie gilt hier
   * im selben Prozess mit derselben `.env`.
   */
  const registeredProviderIds = expectedRegisteredProviders(process.env)

  logger.info("─── Umgebung ───────────────────────────────────────────────")
  logger.info(`NODE_ENV = ${process.env.NODE_ENV ?? "(nicht gesetzt)"}`)
  logger.info(
    `Dieser Prozess registriert: ${registeredProviderIds.join(", ")}`
  )

  logger.info("─── Provider in der Datenbank ──────────────────────────────")
  if (!dbProviders.length) {
    logger.info("(keine)")
  }
  for (const p of dbProviders) {
    // is_enabled bewusst als "laut DB" ausgewiesen — siehe Kopfkommentar.
    logger.info(
      `${p.id}  (is_enabled laut DB: ${p.is_enabled}; auf 2.13.6 nicht aussagekräftig)`
    )
  }

  logger.info("─── Regionen ───────────────────────────────────────────────")
  for (const region of regions) {
    logger.info(
      `${region.name} [${region.currencyCode}] → ` +
        (region.providerIds.length ? region.providerIds.join(", ") : "(keine Zahlart)")
    )
  }

  logger.info("─── Befund ─────────────────────────────────────────────────")
  const findings = analysePaymentSetup({
    regions,
    registeredProviderIds,
    env: process.env,
  })
  for (const f of findings) {
    const line = `${SYMBOL[f.level]} ${f.text}`
    if (f.level === "fehler") logger.error(line)
    else if (f.level === "warnung") logger.warn(line)
    else logger.info(line)
  }

  if (hatFehler(findings)) {
    logger.error(
      "Solange oben ein ✗ steht, kann die Kasse keine Zahlung vorbereiten."
    )
    process.exitCode = 1
  }
}
