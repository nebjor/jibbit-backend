import { cancelOrderFulfillmentWorkflow } from "@medusajs/medusa/core-flows"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * Storniert die nicht versandten Lieferungen mit Medusas eigenem Workflow;
 * der legt Bestand und Reservierung zurück. Einzeln nacheinander, weil
 * dieselben Lagerbestände betroffen sein können.
 *
 * Kein Gegenstück zum Zurückrollen: eine stornierte, nie versandte Lieferung
 * ist ein gültiger Zustand, und Medusa kennt kein «Stornierung aufheben».
 * Scheitert ein späterer Schritt, bleibt die Bestellung bestehen, nur ohne
 * offene Lieferung.
 */
export const stornierLieferungenStep = createStep(
  "storniere-lieferungen-vor-loeschen",
  async (input: { order_id: string; fulfillment_ids: string[] }, { container }) => {
    for (const fulfillment_id of input.fulfillment_ids) {
      await cancelOrderFulfillmentWorkflow(container).run({
        input: { order_id: input.order_id, fulfillment_id, no_notification: true },
      })
    }
    return new StepResponse(input.fulfillment_ids)
  }
)
