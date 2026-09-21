import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

import {
  PREISTABELLE_CURRENCY,
  PreisRow,
  leseStufenExtras,
  tabelleAusPreisen,
} from "../../../../../lib/preistabelle"
import { PostPreistabelleBody } from "./validators"
import { setzePreistabelleWorkflow } from "../../../../../workflows/preistabelle/setze-preistabelle"

/**
 * GET  /admin/products/:id/preistabelle  — Tabelle für das Admin-Widget
 * POST /admin/products/:id/preistabelle  — Tabelle speichern
 *
 * Die Tabelle IST die Mengenstaffel der einzigen Variante (Medusa-
 * Preiszeilen mit min_quantity/max_quantity). Nichts wird doppelt abgelegt.
 */


type PreisMitListe = PreisRow & {
  price_list?: { id: string; title?: string | null; status?: string | null } | null
}

async function ladeAntwort(req: AuthenticatedMedusaRequest, productId: string) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "metadata",
      "variants.id",
      "variants.title",
      "variants.prices.id",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.prices.min_quantity",
      "variants.prices.max_quantity",
      "variants.prices.price_list_id",
      "variants.prices.rules_count",
      "variants.prices.price_list.id",
      "variants.prices.price_list.title",
      "variants.prices.price_list.status",
    ],
    filters: { id: productId },
  })

  const product = products[0]
  if (!product) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Produkt ${productId} nicht gefunden.`)
  }

  const variants = (product.variants ?? []).filter(Boolean) as any[]
  if (variants.length !== 1) {
    return {
      variant_count: variants.length,
      variant_id: null,
      waehrung: PREISTABELLE_CURRENCY,
      zeilen: [],
      hinweise: [],
      preislisten: [],
    }
  }

  const prices = ((variants[0].prices ?? []).filter(Boolean)) as PreisMitListe[]
  const tabelle = tabelleAusPreisen(prices)
  const hinweise = tabelle.hinweise
  const extras = new Map(
    leseStufenExtras(product.metadata as Record<string, unknown> | null).map((e) => [
      e.min_quantity,
      e,
    ])
  )
  const zeilen = tabelle.zeilen.map((z) => ({
    ...z,
    image_id: extras.get(z.min_quantity)?.image_id ?? null,
    label: extras.get(z.min_quantity)?.label ?? null,
  }))

  // Preislisten (z.B. «Aktionspreise») gehen im Shop VOR die Tabelle, wenn
  // sie aktiv sind. Das Widget zeigt das an, damit niemand rätselt, warum
  // die neue Tabelle im Shop nicht erscheint.
  const listen = new Map<string, { id: string; title: string; status: string; zeilen: number }>()
  for (const p of prices) {
    if (!p.price_list_id) continue
    const bisher = listen.get(p.price_list_id)
    listen.set(p.price_list_id, {
      id: p.price_list_id,
      title: p.price_list?.title ?? p.price_list_id,
      status: p.price_list?.status ?? "",
      zeilen: (bisher?.zeilen ?? 0) + 1,
    })
  }

  return {
    variant_count: 1,
    variant_id: variants[0].id as string,
    waehrung: PREISTABELLE_CURRENCY,
    zeilen,
    hinweise,
    preislisten: [...listen.values()],
  }
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json(await ladeAntwort(req, req.params.id))
}

export async function POST(
  req: AuthenticatedMedusaRequest<PostPreistabelleBody>,
  res: MedusaResponse
) {
  await setzePreistabelleWorkflow(req.scope).run({
    input: { product_id: req.params.id, zeilen: req.validatedBody.zeilen },
  })
  res.json(await ladeAntwort(req, req.params.id))
}
