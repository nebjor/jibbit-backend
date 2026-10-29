import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  adjustInventoryLevelsStep,
  cancelPaymentStep,
  deleteReservationsByLineItemsStep,
  refundPaymentsWorkflow,
} from "@medusajs/medusa/core-flows"

import { loescheBestellungWeichStep } from "./steps/loesche-bestellung-weich"
import { LoescheBestellungInput, planeBestellungLoeschenStep } from "./steps/plane-bestellung-loeschen"
import { stornierLieferungenStep } from "./steps/storniere-lieferungen"

/**
 * Löscht eine Bestellung (weich) und räumt vorher auf. Regeln und Gründe:
 * src/lib/bestellung-loeschen.ts, docs/bestellungen-loeschen.md.
 *
 * Reihenfolge: prüfen (wirft, bevor etwas geschrieben ist) → offene
 * Lieferungen stornieren → versandte Ware optional ins Lager → Reservierungen
 * löschen → offene Zahlungen abbrechen → optional zurückerstatten → löschen.
 * Das Zurückerstatten steht bewusst spät: es geschieht beim Zahlungsanbieter
 * und ist nicht rückholbar, scheitert aber am ehesten. Scheitert es, rollen
 * Lagerbuchung und Reservierungen zurück.
 */
export const loescheBestellungWorkflow = createWorkflow(
  "loesche-bestellung",
  function (input: LoescheBestellungInput) {
    const plan = planeBestellungLoeschenStep(input)

    when({ plan }, ({ plan }) => plan.lieferungen_stornieren.length > 0).then(() => {
      stornierLieferungenStep(
        transform({ plan }, ({ plan }) => ({
          order_id: plan.order_id,
          fulfillment_ids: plan.lieferungen_stornieren,
        }))
      )
    })

    when({ plan }, ({ plan }) => plan.lager_zurueckbuchen.length > 0).then(() => {
      adjustInventoryLevelsStep(
        transform({ plan }, ({ plan }) =>
          plan.lager_zurueckbuchen.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            location_id: l.location_id,
            adjustment: l.menge,
          }))
        )
      )
    })

    when({ plan }, ({ plan }) => plan.line_item_ids.length > 0).then(() => {
      deleteReservationsByLineItemsStep(transform({ plan }, ({ plan }) => plan.line_item_ids))
    })

    when({ plan }, ({ plan }) => plan.zahlungen_abbrechen.length > 0).then(() => {
      cancelPaymentStep({
        paymentIds: transform({ plan }, ({ plan }) => plan.zahlungen_abbrechen),
      })
    })

    when({ plan }, ({ plan }) => plan.erstattung_betrag > 0).then(() => {
      refundPaymentsWorkflow.runAsStep({
        input: transform({ plan }, ({ plan }) =>
          plan.erstattungen.map((e) => ({
            payment_id: e.payment_id,
            amount: e.amount,
            note: `Bestellung #${plan.display_id} gelöscht`,
          }))
        ),
      })
    })

    loescheBestellungWeichStep(transform({ plan }, ({ plan }) => plan.order_id))

    return new WorkflowResponse(plan)
  }
)
