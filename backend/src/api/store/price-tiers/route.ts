import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * GET /store/price-tiers?variant_id=…&variant_id=…&currency_code=chf
 *
 * Liefert die Mengenstaffeln einer oder mehrerer Varianten.
 *
 * Warum es diese Route braucht: /store/products liefert immer nur den Preis
 * für Menge 1 — der Helper in @medusajs/medusa/dist/api/store/products/helpers.js
 * setzt `quantity: 1` fest, und der Query-Validator kennt gar keinen
 * Mengenparameter. Für die Preistabelle auf der Produktseite brauchen wir aber
 * alle Stufen auf einmal, nicht eine Anfrage pro Stufe.
 *
 * Abgerechnet wird nach wie vor serverseitig im Warenkorb. Diese Route ist
 * reine Anzeige — sie darf nie Grundlage einer Preisberechnung im Client sein.
 */

const MAX_VARIANTS = 50

type PriceRow = {
  id: string
  amount: number | string
  currency_code: string
  min_quantity?: number | string | null
  max_quantity?: number | string | null
  price_list_id?: string | null
  price_set_id?: string
  price_rules?: { attribute: string; operator: string; value: string }[]
}

type Tier = {
  min_quantity: number
  max_quantity: number | null
  amount: number
  currency_code: string
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string")
  }
  return typeof value === "string" ? [value] : []
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const variantIds = [...new Set(asArray(req.query.variant_id))]

  if (!variantIds.length) {
    res.status(400).json({ message: "variant_id is required" })
    return
  }

  if (variantIds.length > MAX_VARIANTS) {
    res.status(400).json({
      message: `Too many variants requested (max ${MAX_VARIANTS})`,
    })
    return
  }

  const regionId =
    typeof req.query.region_id === "string" ? req.query.region_id : undefined

  let currencyCode =
    typeof req.query.currency_code === "string"
      ? req.query.currency_code.toLowerCase()
      : undefined

  if (!currencyCode && regionId) {
    const regionService = req.scope.resolve(Modules.REGION)
    const region = await regionService.retrieveRegion(regionId, {
      select: ["currency_code"],
    })
    currencyCode = region?.currency_code?.toLowerCase()
  }

  if (!currencyCode) {
    res
      .status(400)
      .json({ message: "Either currency_code or region_id is required" })
    return
  }

  // Variante → Price Set. Derselbe Weg wie getVariantPricingLinkStep im Core.
  const link = req.scope.resolve(ContainerRegistrationKeys.LINK) as {
    getLinkModule: (
      a: string,
      ak: string,
      b: string,
      bk: string
    ) => { list: (f: object, c: object) => Promise<Record<string, string>[]> }
  }

  const linkService = link.getLinkModule(
    Modules.PRODUCT,
    "variant_id",
    Modules.PRICING,
    "price_set_id"
  )

  const links = await linkService.list(
    { variant_id: variantIds },
    { select: ["variant_id", "price_set_id"] }
  )

  const priceSetToVariant = new Map(
    links.map((l) => [l.price_set_id, l.variant_id])
  )

  const tiers: Record<string, Tier[]> = Object.fromEntries(
    variantIds.map((id) => [id, []])
  )

  if (!priceSetToVariant.size) {
    res.json({ tiers })
    return
  }

  const pricingService = req.scope.resolve(Modules.PRICING)

  const prices = (await pricingService.listPrices(
    {
      price_set_id: [...priceSetToVariant.keys()],
      currency_code: currencyCode,
    },
    {
      select: [
        "id",
        "amount",
        "currency_code",
        "min_quantity",
        "max_quantity",
        "price_list_id",
        "price_set_id",
      ],
      relations: ["price_rules"],
      take: null,
    }
  )) as unknown as PriceRow[]

  for (const price of prices) {
    // Preislisten-Preise (Aktionen, B2B-Listen) gehören nicht in die
    // Staffeltabelle — die berechnet Medusa im Warenkorb selbst.
    if (price.price_list_id) {
      continue
    }

    // Preiszeilen mit Regeln (z.B. regionsgebunden) nur übernehmen, wenn die
    // Regel zum angefragten Kontext passt. Alles andere würde eine Staffel
    // anzeigen, die dieser Kunde gar nicht bekommt.
    const rules = price.price_rules ?? []
    const rulesMatch = rules.every(
      (r) => r.attribute === "region_id" && r.value === regionId
    )
    if (!rulesMatch) {
      continue
    }

    const variantId = priceSetToVariant.get(price.price_set_id ?? "")
    if (!variantId) {
      continue
    }

    tiers[variantId].push({
      min_quantity: Number(price.min_quantity ?? 1),
      max_quantity:
        price.max_quantity === null || price.max_quantity === undefined
          ? null
          : Number(price.max_quantity),
      amount: Number(price.amount),
      currency_code: price.currency_code,
    })
  }

  for (const variantId of Object.keys(tiers)) {
    tiers[variantId].sort((a, b) => a.min_quantity - b.min_quantity)
  }

  res.json({ tiers })
}
