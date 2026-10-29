import { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * «Als geliefert markieren» wird bewusst nicht benutzt: Die Inhaberin weiss,
 * wann sie versendet hat («Als versendet markieren»), nicht aber, wann die
 * Post zustellt. Das Dashboard bietet die Aktion trotzdem an; Admin-
 * Erweiterungen können eingebaute Schaltflächen in Medusa 2.13 nicht
 * ausblenden. Das Widget `zugestellt-ausblenden` versteckt den Knopf, diese
 * Middleware ist der Riegel dahinter: Die Route
 * POST /admin/orders/:id/fulfillments/:fulfillment_id/mark-as-delivered
 * wird abgelehnt, auch bei direktem API-Aufruf oder zwischengespeicherter
 * Oberfläche. Nichts im Shop liest `delivered_at`.
 */
export const ZUGESTELLT_NICHT_VERWENDET =
  "«Als geliefert markieren» wird in diesem Shop nicht verwendet. " +
  "Bitte «Als versendet markieren» benutzen."

export function sperreAlsGeliefertMarkieren(
  _req: MedusaRequest,
  res: MedusaResponse,
  _next: MedusaNextFunction
) {
  res.status(403).json({
    type: "not_allowed",
    message: ZUGESTELLT_NICHT_VERWENDET,
  })
}
