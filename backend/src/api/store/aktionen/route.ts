import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { mappeAktionen, RohPromotion } from "../../../lib/aktionen"

/**
 * GET /store/aktionen
 *
 * Liefert die aktuell laufenden AUTOMATISCHEN Aktionen für den Aktionsbanner
 * im Shop: `{ aktionen: [{ code, titel, prozent | betrag, waehrung, gilt_ab,
 * gilt_bis, nur_teilsortiment, auf_artikel }] }`.
 *
 * Nur Promotionen mit status "active" und is_automatic: true; das
 * Kampagnenfenster (starts_at/ends_at) muss JETZT enthalten (ohne Kampagne
 * gilt sie unbefristet). Nicht automatische Codes erscheinen nie — die
 * Filterung passiert doppelt (Query und Mapping, siehe lib/aktionen.ts).
 *
 * Wie jede /store/*-Route verlangt sie den Publishable-Key
 * (x-publishable-api-key); der Storefront-Server sendet ihn ohnehin mit.
 * Ein Login braucht es nicht.
 *
 * Abgerechnet wird der Rabatt weiterhin allein von Medusa im Warenkorb —
 * diese Route ist reine Anzeige.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "promotion",
    fields: [
      "code",
      "is_automatic",
      "status",
      "type",
      "campaign.name",
      "campaign.starts_at",
      "campaign.ends_at",
      "application_method.type",
      "application_method.value",
      "application_method.currency_code",
      "application_method.target_type",
      "application_method.allocation",
      "application_method.target_rules.id",
    ],
    filters: { status: "active", is_automatic: true },
  })

  const aktionen = mappeAktionen(data as unknown as RohPromotion[], new Date())

  res.setHeader("Cache-Control", "public, max-age=60")
  res.json({ aktionen })
}
