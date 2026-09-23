import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { leseStufenExtras, tabelleAusPreisen } from "../../../../../lib/preistabelle"
import { ladePreistabelleDaten } from "../../../../../lib/preistabelle-daten"
import { setzePreistabelleWorkflow } from "../../../../../workflows/preistabelle/setze-preistabelle"
import { PostPreistabelleBody } from "./validators"

async function antwort(req: AuthenticatedMedusaRequest, productId: string) {
  const daten = await ladePreistabelleDaten(req.scope, productId)
  const { regulaerer_preis, zeilen, hinweise } = tabelleAusPreisen(daten.basis, daten.liste)
  const extras = new Map(leseStufenExtras(daten.metadata).map((e) => [e.min_quantity, e]))

  if (daten.liste.length && daten.preisliste?.status !== "active") {
    hinweise.push(
      "Die Preisliste «Aktionspreise jibbit.ch» ist nicht aktiv — im Shop gilt nur der reguläre Preis."
    )
  }
  if (daten.liste.length && daten.preisliste?.hat_regeln) {
    hinweise.push(
      "Die Preisliste «Aktionspreise jibbit.ch» hat Bedingungen — sie gilt nicht für alle Kunden."
    )
  }

  return {
    variant_count: daten.variant_ids.length,
    regulaerer_preis,
    zeilen: zeilen.map((z) => ({
      ...z,
      image_id: extras.get(z.min_quantity)?.image_id ?? null,
      label: extras.get(z.min_quantity)?.label ?? null,
    })),
    hinweise,
  }
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json(await antwort(req, req.params.id))
}

export async function POST(
  req: AuthenticatedMedusaRequest<PostPreistabelleBody>,
  res: MedusaResponse
) {
  await setzePreistabelleWorkflow(req.scope).run({
    input: { product_id: req.params.id, ...req.validatedBody },
  })
  res.json(await antwort(req, req.params.id))
}
