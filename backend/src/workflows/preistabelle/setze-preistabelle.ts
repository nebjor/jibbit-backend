import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"

import {
  metadataMitExtras,
  PreisZeile,
  preiseAusTabelle,
  stufenExtras,
  zuBehaltendePreise,
} from "../../lib/preistabelle"
import { ladePreistabelleZielStep } from "./steps/lade-preistabelle-ziel"

export type SetzePreistabelleInput = {
  product_id: string
  zeilen: PreisZeile[]
}

/**
 * Schreibt die Preistabelle eines Produkts:
 *   1. Preise als Mengenstaffel (price.min_quantity/max_quantity, CHF) auf die
 *      einzige Variante — damit rechnet der Warenkorb.
 *   2. Optionales Bild/Bezeichnung je Zeile in product.metadata.preistabelle
 *      (bestehende Metadata-Schlüssel bleiben erhalten).
 *
 * Idempotent: dieselbe Tabelle zweimal gespeichert ergibt denselben Stand.
 * Beide Schreibschritte sind Medusa-Kernworkflows mit eigener Kompensation:
 * scheitert Schritt 2, stellt updatePriceSetsStep die vorherigen Preise
 * wieder her. Preise anderer Währungen/Regionen werden mit ihrer id
 * mitgeschickt und bleiben erhalten; Preislisten-Preise fasst Medusa hier
 * ohnehin nicht an.
 */
export const setzePreistabelleWorkflow = createWorkflow(
  "setze-preistabelle",
  function (input: SetzePreistabelleInput) {
    const ziel = ladePreistabelleZielStep(input)

    const variantenPayload = transform({ ziel, input }, function ({ ziel, input }) {
      return {
        product_variants: [
          {
            id: ziel.variant_id,
            prices: [...preiseAusTabelle(input.zeilen), ...zuBehaltendePreise(ziel.prices)],
          },
        ],
      }
    })

    updateProductVariantsWorkflow.runAsStep({ input: variantenPayload })

    const produktPayload = transform({ ziel, input }, function ({ ziel, input }) {
      return {
        selector: { id: input.product_id },
        update: { metadata: metadataMitExtras(ziel.metadata, stufenExtras(input.zeilen)) },
      }
    })

    updateProductsWorkflow.runAsStep({ input: produktPayload })

    return new WorkflowResponse(
      transform({ ziel }, function ({ ziel }) {
        return { variant_id: ziel.variant_id }
      })
    )
  }
)
