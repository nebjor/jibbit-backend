import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { MedusaContainer } from "@medusajs/framework/types"

import { AKTIONSPREISLISTE, PreisRow } from "./preistabelle"

export type PreistabelleDaten = {
  product_id: string
  metadata: Record<string, unknown> | null
  bild_ids: string[]
  variant_ids: string[]
  basis: PreisRow[]
  preisliste: { id: string; status: string; hat_regeln: boolean } | null
  liste: PreisRow[]
}

const PREIS_FELDER = ["id", "amount", "currency_code", "min_quantity", "max_quantity", "rules_count"]

/** Liest alles, was die Preistabelle eines Produkts ausmacht. */
export async function ladePreistabelleDaten(
  container: MedusaContainer,
  productId: string
): Promise<PreistabelleDaten> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const [{ data: products }, { data: listen }] = await Promise.all([
    query.graph({
      entity: "product",
      fields: [
        "id",
        "metadata",
        "images.id",
        "variants.id",
        "variants.price_set.id",
        ...PREIS_FELDER.map((f) => `variants.prices.${f}`),
      ],
      filters: { id: productId },
    }),
    query.graph({
      entity: "price_list",
      fields: ["id", "status", "rules_count"],
      filters: { title: AKTIONSPREISLISTE.title },
    }),
  ])

  const product = products[0]
  if (!product) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Produkt ${productId} nicht gefunden.`)
  }
  const variants = (product.variants ?? []).filter(Boolean) as any[]
  const variant = variants.length === 1 ? variants[0] : null
  const preisliste = listen[0] as any

  const { data: liste } =
    variant?.price_set?.id && preisliste
      ? await query.graph({
          entity: "price",
          fields: PREIS_FELDER,
          filters: { price_set_id: variant.price_set.id, price_list_id: preisliste.id },
        })
      : { data: [] }

  return {
    product_id: product.id,
    metadata: (product.metadata as Record<string, unknown> | null) ?? null,
    bild_ids: (product.images ?? []).filter(Boolean).map((i: any) => i.id),
    variant_ids: variants.map((v) => v.id),
    basis: (variant?.prices ?? []).filter(Boolean),
    preisliste: preisliste
      ? {
          id: preisliste.id,
          status: preisliste.status,
          hat_regeln: Number(preisliste.rules_count ?? 0) > 0,
        }
      : null,
    liste: (liste as PreisRow[]).map((p) => ({ ...p, price_list_id: preisliste.id })),
  }
}
