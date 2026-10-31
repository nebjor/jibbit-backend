import { PriceListStatus } from "@medusajs/framework/utils"
import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  batchPriceListPricesWorkflow,
  createPriceListsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"

import {
  aktionspreisliste,
  basisPreis,
  metadataMitExtras,
  staffelAenderungen,
  staffelPreise,
  stufenExtras,
  zuBehaltendePreise,
} from "../../lib/preistabelle"
import { ladePreistabelleZielStep, LadePreistabelleZielInput } from "./steps/lade-preistabelle-ziel"

/**
 * Schreibt die Preistabelle: regulärer Preis als Basispreis der einzigen
 * Variante, die Staffel in die Aktionspreisliste (legt sie beim ersten Mal an),
 * Bild/Bezeichnung je Zeile in product.metadata. Nur Kern-Workflows mit
 * eigener Kompensation; idempotent.
 */
export const setzePreistabelleWorkflow = createWorkflow(
  "setze-preistabelle",
  function (input: LadePreistabelleZielInput) {
    const daten = ladePreistabelleZielStep(input)

    const neueListe = when({ daten }, ({ daten }) => !daten.preisliste).then(() =>
      createPriceListsWorkflow.runAsStep({
        input: {
          price_lists_data: [
            {
              ...aktionspreisliste(),
              status: PriceListStatus.ACTIVE,
            },
          ],
        },
      })
    )

    const variantId = transform({ daten }, ({ daten }) => daten.variant_ids[0])

    updateProductVariantsWorkflow.runAsStep({
      input: transform({ daten, input, variantId }, ({ daten, input, variantId }) => ({
        product_variants: [
          { id: variantId, prices: [basisPreis(input), ...zuBehaltendePreise(daten.basis)] },
        ],
      })),
    })

    batchPriceListPricesWorkflow.runAsStep({
      input: transform(
        { daten, input, variantId, neueListe },
        ({ daten, input, variantId, neueListe }) => ({
          data: {
            id: (daten.preisliste?.id ?? neueListe?.[0]?.id) as string,
            ...staffelAenderungen(staffelPreise(input), daten.liste, variantId),
          },
        })
      ),
    })

    updateProductsWorkflow.runAsStep({
      input: transform({ daten, input }, ({ daten, input }) => ({
        selector: { id: input.product_id },
        update: { metadata: metadataMitExtras(daten.metadata, stufenExtras(input.zeilen)) },
      })),
    })

    return new WorkflowResponse(variantId)
  }
)
