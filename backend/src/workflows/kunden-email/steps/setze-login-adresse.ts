import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import {
  LoginAdresseInput,
  setzeLoginAdresse,
  setzeLoginAdresseZurueck,
} from "../../../lib/kunden-email-daten"

/**
 * Schreibt die neue Adresse in `provider_identity.entity_id`. Scheitert ein
 * späterer Schritt, kommt die alte Adresse zurück.
 */
export const setzeLoginAdresseStep = createStep(
  "setze-login-adresse",
  async (input: LoginAdresseInput, { container }) => {
    const vorher = await setzeLoginAdresse(container, input)
    return new StepResponse(vorher.id, vorher)
  },
  async (vorher, { container }) => {
    await setzeLoginAdresseZurueck(container, vorher)
  }
)
