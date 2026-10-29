import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import {
  loescheBestellungWeich,
  stelleBestellungWiederHer,
} from "../../../lib/bestellung-loeschen-daten"

/** Letzter Schritt: setzt `deleted_at` auf Bestellung, Positionen, Summen, Versand. */
export const loescheBestellungWeichStep = createStep(
  "loesche-bestellung-weich",
  async (orderId: string, { container }) => {
    await loescheBestellungWeich(container, orderId)
    return new StepResponse(orderId, orderId)
  },
  async (orderId, { container }) => {
    if (orderId) await stelleBestellungWiederHer(container, orderId)
  }
)
