import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

import { entscheideBestellungLoeschen } from "../../../../../lib/bestellung-loeschen"
import { ladeBestellLage } from "../../../../../lib/bestellung-loeschen-daten"
import { loescheBestellungWorkflow } from "../../../../../workflows/bestellung-loeschen/loesche-bestellung"
import { PostBestellungLoeschenBody } from "./validators"

/**
 * POST /admin/orders/:id/loeschen — Bestellung (weich) löschen.
 *
 * Nur für angemeldete Admin-Benutzer (alles unter /admin). Ohne die
 * Bestellnummer als `bestaetigung` geschieht nichts. Mit `vorschau: true`
 * wird nur gerechnet; die Bestätigung wird dort nicht verlangt.
 *
 * Das Log nennt nur IDs und Zahlen, keine Personendaten.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<PostBestellungLoeschenBody>,
  res: MedusaResponse
) {
  const { bestaetigung, zahlung_erstatten, ware_zurueck_ins_lager, vorschau } = req.validatedBody
  const orderId = req.params.id

  if (vorschau) {
    const lage = await ladeBestellLage(req.scope, orderId)
    const entscheid = entscheideBestellungLoeschen(lage, {
      bestaetigung: String(lage.display_id),
      zahlung_erstatten,
      ware_zurueck_ins_lager,
    })
    if (!entscheid.ok) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, entscheid.fehler)
    res.json({ vorschau: true, plan: entscheid.plan })
    return
  }

  const { result: plan } = await loescheBestellungWorkflow(req.scope).run({
    input: { order_id: orderId, bestaetigung, zahlung_erstatten, ware_zurueck_ins_lager },
  })

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.info(
    `[bestellung-loeschen] Bestellung ${plan.order_id} gelöscht durch ` +
      `${req.auth_context?.actor_type ?? "unbekannt"} ${req.auth_context?.actor_id ?? "unbekannt"}. ` +
      `Lieferungen storniert: ${plan.lieferungen_stornieren.length}, ` +
      `versandt: ${plan.lieferungen_versandt.length}, ` +
      `Lagerbuchungen: ${plan.lager_zurueckbuchen.length}, ` +
      `erstattet: ${plan.erstattung_betrag}, nicht erstattet: ${plan.nicht_erstattet_betrag}.`
  )

  res.json({ vorschau: false, plan })
}
