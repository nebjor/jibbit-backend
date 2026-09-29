import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import { entscheideKundenEmail, KundenEmailPlan, normalisiereEmail } from "../../../lib/kunden-email"
import { ladeKundenEmailLage } from "../../../lib/kunden-email-daten"

export type AendereKundenEmailInput = {
  customer_id: string
  email: string
  bestellungen_anpassen: boolean
}

/**
 * Prüft die neue Adresse gegen den Stand in der Datenbank und legt fest, was
 * geschrieben wird. Nur lesend, daher ohne Kompensation. Konflikte werfen
 * hier — bevor irgendetwas geschrieben ist.
 */
export const planeKundenEmailStep = createStep(
  "plane-kunden-email",
  async (input: AendereKundenEmailInput, { container }) => {
    const lage = await ladeKundenEmailLage(
      container,
      input.customer_id,
      normalisiereEmail(input.email)
    )
    const entscheid = entscheideKundenEmail(lage, input.email, {
      bestellungen_anpassen: input.bestellungen_anpassen,
    })
    if (!entscheid.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, entscheid.fehler)
    }
    return new StepResponse<KundenEmailPlan>(entscheid.plan)
  }
)
