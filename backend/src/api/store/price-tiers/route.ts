import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import {
  Probe,
  Tier,
  collectQuantityBreakpoints,
  restrictedPriceListIds,
  tiersFromProbes,
} from "./tiers"

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
 * Wie die Stufen entstehen: Die rohen Preiszeilen (`listPrices`) nennen nur
 * die KANDIDATEN-Mengen, an denen sich der Preis ändern kann — Standardpreise
 * UND Preislisten-Zeilen, denn die Preistabelle legt die
 * Staffeln in die Preisliste „Aktionspreise jibbit.ch", nicht in den
 * Basispreis. Den Betrag je Menge bestimmt dann `calculatePrices` — dieselbe
 * Auswertung, mit der Medusa auch den Warenkorb abrechnet. Sie kennt
 * Preislisten-Status, Start-/Enddatum und Kundengruppen-Regeln; da diese
 * Route ohne Kundenkontext anfragt, sehen Gäste eingeschränkte Listen
 * (z.B. künftige Händlerpreise) hier prinzipbedingt nicht. Details und
 * warum dabei nichts durchsickern kann: ./tiers.ts.
 *
 * Abgerechnet wird nach wie vor serverseitig im Warenkorb. Diese Route ist
 * reine Anzeige — sie darf nie Grundlage einer Preisberechnung im Client sein.
 */

const MAX_VARIANTS = 50

type PriceRow = {
  min_quantity?: number | string | null
  max_quantity?: number | string | null
  price_list_id?: string | null
}

type CalculatedPriceSet = {
  id: string
  calculated_amount?: number | string | null
  original_amount?: number | string | null
  currency_code?: string | null
  calculated_price?: { price_list_id?: string | null } | null
  original_price?: { price_list_id?: string | null } | null
}

/**
 * Gast-Marker für Anfragen ohne region_id. Medusas Preisabfrage prüft
 * Preislisten-Regeln nur, wenn der Kontext nach Abzug von `quantity` und
 * `currency_code` noch Attribute enthält (hasComplexContext in
 * @medusajs/pricing, repositories/pricing.js) — sonst rutscht jede aktive
 * Liste durch, auch eine auf Kundengruppen eingeschränkte. Der Warenkorb
 * sendet immer eine region_id und ist deshalb nie betroffen; diese Route
 * erzwingt denselben Pfad, notfalls mit diesem Marker: "Gast, Mitglied
 * keiner Kundengruppe". Er erfüllt nie eine echte Gruppenregel.
 */
const GUEST_CONTEXT = { "customer.groups.id": ["__guest__"] }

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
  const priceSetIds = [...priceSetToVariant.keys()]

  // 1) Rohzeilen holen — NUR für die Mengen-Sprungstellen. Beträge werden
  //    hieraus nie übernommen; auch Zeilen aus Entwurfs- oder eingeschränkten
  //    Preislisten steuern höchstens eine Menge bei, zu der gleich der
  //    tatsächlich gültige Gast-Preis erfragt wird (siehe tiers.ts).
  const priceRows = (await pricingService.listPrices(
    {
      price_set_id: priceSetIds,
      currency_code: currencyCode,
    },
    {
      select: ["id", "min_quantity", "max_quantity", "price_list_id"],
      take: null,
    }
  )) as unknown as PriceRow[]

  // Listen, deren Regeln dieser anonyme Request prinzipiell nicht erfüllen
  // kann (z.B. Kundengruppen-Händlerpreise): deren Zeilen liefern weder
  // Sprungstellen noch dürfen sie je als Gewinner durchgereicht werden.
  const priceListIds = [
    ...new Set(
      priceRows
        .map((row) => row.price_list_id)
        .filter((id): id is string => typeof id === "string")
    ),
  ]

  const priceLists = priceListIds.length
    ? ((await pricingService.listPriceLists(
        { id: priceListIds },
        { relations: ["price_list_rules"], take: null }
      )) as unknown as {
        id: string
        price_list_rules?: { attribute: string }[] | null
      }[])
    : []

  const restrictedLists = restrictedPriceListIds(
    priceLists,
    regionId ? ["region_id"] : []
  )

  const breakpoints = collectQuantityBreakpoints(
    priceRows.filter(
      (row) => !row.price_list_id || !restrictedLists.has(row.price_list_id)
    )
  )

  // 2) Jede Sprungstelle mit der Warenkorb-Auswertung bewerten. Bewusst OHNE
  //    customer_id / Kundengruppen im Kontext: Die Route ist anonym, also
  //    darf sie nur sehen, was jeder Gast bezahlt. Eine Abfrage je Menge,
  //    gebündelt über alle angefragten Varianten. Der Kontext trägt immer
  //    mindestens ein Attribut (region_id oder den Gast-Marker), damit
  //    Medusa die Preislisten-Regeln wirklich auswertet — siehe GUEST_CONTEXT.
  const baseContext: Record<string, unknown> = {
    currency_code: currencyCode,
  }
  if (regionId) {
    baseContext.region_id = regionId
  } else {
    Object.assign(baseContext, GUEST_CONTEXT)
  }

  const probesByQuantity = await Promise.all(
    breakpoints.map(async (quantity) => {
      const calculated = (await pricingService.calculatePrices(
        { id: priceSetIds },
        { context: { ...baseContext, quantity } as never }
      )) as unknown as CalculatedPriceSet[]
      return { quantity, calculated }
    })
  )

  // 3) Punktwerte je Variante einsammeln und zu Stufen verschmelzen.
  const probesByVariant = new Map<string, Probe[]>(
    variantIds.map((id) => [id, []])
  )

  const toAmount = (value: number | string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value)

  for (const { quantity, calculated } of probesByQuantity) {
    const byPriceSet = new Map(calculated.map((c) => [c.id, c]))
    for (const [priceSetId, variantId] of priceSetToVariant) {
      const hit = byPriceSet.get(priceSetId)
      let amount = toAmount(hit?.calculated_amount)

      // Riegel: Gewinner aus einer Liste, die dieser Request nie erfüllen
      // kann, werden verworfen — dann zählt der reguläre Preis (das
      // original_amount), oder gar keiner. Greift nur, falls Medusas eigene
      // Regelauswertung umgangen wurde; Details in tiers.ts.
      const winnerList = hit?.calculated_price?.price_list_id ?? null
      if (winnerList && restrictedLists.has(winnerList)) {
        const originalList = hit?.original_price?.price_list_id ?? null
        amount =
          originalList && restrictedLists.has(originalList)
            ? null
            : toAmount(hit?.original_amount)
      }

      probesByVariant.get(variantId)?.push({
        quantity,
        amount,
        original_amount: amount === null ? null : toAmount(hit?.original_amount),
        currency_code: hit?.currency_code ?? null,
      })
    }
  }

  for (const [variantId, probes] of probesByVariant) {
    tiers[variantId] = tiersFromProbes(probes, currencyCode)
  }

  res.json({ tiers })
}
