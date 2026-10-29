import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import { entscheideBestellungLoeschen, type LoeschOptionen } from "../../../lib/bestellung-loeschen"
import { ladeBestellLage } from "../../../lib/bestellung-loeschen-daten"

export type LoescheBestellungInput = LoeschOptionen & { order_id: string }

/** Liest die Bestellung und legt fest, was geschieht. Wirft vor jeder Änderung. */
export const planeBestellungLoeschenStep = createStep(
  "plane-bestellung-loeschen",
  async (input: LoescheBestellungInput, { container }) => {
    const lage = await ladeBestellLage(container, input.order_id)
    const entscheid = entscheideBestellungLoeschen(lage, input)
    if (!entscheid.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, entscheid.fehler)
    }
    return new StepResponse(entscheid.plan)
  }
)
