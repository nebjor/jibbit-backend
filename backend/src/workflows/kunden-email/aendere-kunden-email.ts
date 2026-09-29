import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { updateCustomersWorkflow } from "@medusajs/medusa/core-flows"

import { AendereKundenEmailInput, planeKundenEmailStep } from "./steps/plane-kunden-email"
import { setzeBestellEmailStep } from "./steps/setze-bestell-email"
import { setzeLoginAdresseStep } from "./steps/setze-login-adresse"

/**
 * Korrigiert die E-Mail-Adresse eines Kunden an allen Orten, an denen sie
 * wirkt: Kundendatensatz, Anmeldung (`provider_identity.entity_id`) und offene
 * Bestellungen. Alles oder nichts — scheitert ein Schritt, rollen die
 * vorherigen zurück.
 *
 * Reihenfolge: zuerst prüfen (wirft bei Konflikt, bevor etwas geschrieben
 * ist), dann Kunde, Anmeldung, Bestellungen. Warum drei Orte: siehe
 * src/lib/kunden-email.ts.
 */
export const aendereKundenEmailWorkflow = createWorkflow(
  "aendere-kunden-email",
  function (input: AendereKundenEmailInput) {
    const plan = planeKundenEmailStep(input)

    when({ plan }, ({ plan }) => plan.kunde_aendern).then(() => {
      updateCustomersWorkflow.runAsStep({
        input: transform({ plan }, ({ plan }) => ({
          selector: { id: plan.customer_id },
          update: { email: plan.neu },
        })),
      })
    })

    when({ plan }, ({ plan }) => Boolean(plan.identitaet)).then(() => {
      setzeLoginAdresseStep(
        transform({ plan }, ({ plan }) => ({ id: plan.identitaet!.id, neu: plan.neu }))
      )
    })

    when({ plan }, ({ plan }) => plan.bestellung_ids.length > 0).then(() => {
      setzeBestellEmailStep(
        transform({ plan }, ({ plan }) => ({ ids: plan.bestellung_ids, neu: plan.neu }))
      )
    })

    return new WorkflowResponse(plan)
  }
)
