import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

import {
  PreisRow,
  PreisZeile,
  pruefeBilder,
  pruefePreistabelle,
} from "../../../lib/preistabelle"

export type LadePreistabelleZielInput = {
  product_id: string
  zeilen: PreisZeile[]
}

export type PreistabelleZiel = {
  variant_id: string
  prices: PreisRow[]
  metadata: Record<string, unknown> | null
}

/**
 * Prüft die Tabelle und sucht die EINE Variante des Produkts.
 *
 * Nur lesend — deshalb ohne Kompensation. Produkte mit mehreren Varianten
 * (Altbestand aus dem Katalogimport: Einzeln + Display) werden abgelehnt,
 * statt still eine davon zu wählen; die werden mit der Bereinigung zu einer
 * Variante zusammengeführt.
 */
export const ladePreistabelleZielStep = createStep(
  "lade-preistabelle-ziel",
  async (input: LadePreistabelleZielInput, { container }) => {
    const fehler = pruefePreistabelle(input.zeilen)
    if (fehler.length) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, fehler.join(" "))
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "metadata",
        "images.id",
        "variants.id",
        "variants.prices.id",
        "variants.prices.amount",
        "variants.prices.currency_code",
        "variants.prices.min_quantity",
        "variants.prices.max_quantity",
        "variants.prices.price_list_id",
        "variants.prices.rules_count",
      ],
      filters: { id: input.product_id },
    })

    const product = products[0]
    if (!product) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Produkt ${input.product_id} nicht gefunden.`
      )
    }

    const variants = (product.variants ?? []).filter(Boolean)
    if (variants.length !== 1) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Dieses Produkt hat ${variants.length} Varianten. Die Preistabelle ` +
          `funktioniert nur bei Produkten mit genau einer Variante.`
      )
    }

    const bildFehler = pruefeBilder(
      input.zeilen,
      (product.images ?? []).filter(Boolean).map((i: any) => i.id)
    )
    if (bildFehler.length) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, bildFehler.join(" "))
    }

    const variant = variants[0]!
    return new StepResponse<PreistabelleZiel>({
      variant_id: variant.id,
      prices: ((variant as any).prices ?? []).filter(Boolean) as PreisRow[],
      metadata: (product.metadata as Record<string, unknown> | null) ?? null,
    })
  }
)
