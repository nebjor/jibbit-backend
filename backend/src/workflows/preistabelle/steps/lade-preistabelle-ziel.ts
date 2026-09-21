import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import { Preistabelle, pruefeBilder, pruefePreistabelle } from "../../../lib/preistabelle"
import { ladePreistabelleDaten, PreistabelleDaten } from "../../../lib/preistabelle-daten"

export type LadePreistabelleZielInput = Preistabelle & { product_id: string }

/** Prüft die Tabelle und lädt das Produkt. Nur lesend, daher ohne Kompensation. */
export const ladePreistabelleZielStep = createStep(
  "lade-preistabelle-ziel",
  async (input: LadePreistabelleZielInput, { container }) => {
    const fehler = pruefePreistabelle(input)
    if (fehler.length) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, fehler.join(" "))
    }

    const daten = await ladePreistabelleDaten(container, input.product_id)
    if (daten.variant_ids.length !== 1) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Dieses Produkt hat ${daten.variant_ids.length} Varianten. Die Preistabelle ` +
          `funktioniert nur bei Produkten mit genau einer Variante.`
      )
    }

    const bildFehler = pruefeBilder(input.zeilen, daten.bild_ids)
    if (bildFehler.length) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, bildFehler.join(" "))
    }

    return new StepResponse<PreistabelleDaten>(daten)
  }
)
