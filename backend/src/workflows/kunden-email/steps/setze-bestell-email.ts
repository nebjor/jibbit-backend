import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import {
  BestellEmailInput,
  setzeBestellEmail,
  setzeBestellEmailZurueck,
} from "../../../lib/kunden-email-daten"

/**
 * Setzt die neue Adresse auf den ausgewählten (offenen) Bestellungen. Die
 * Auswahl trifft `waehleBestellungen`; dieser Step schreibt nur.
 */
export const setzeBestellEmailStep = createStep(
  "setze-bestell-email",
  async (input: BestellEmailInput, { container }) => {
    const vorher = await setzeBestellEmail(container, input)
    return new StepResponse(
      vorher.map((o) => o.id),
      vorher
    )
  },
  async (vorher, { container }) => {
    await setzeBestellEmailZurueck(container, vorher)
  }
)
