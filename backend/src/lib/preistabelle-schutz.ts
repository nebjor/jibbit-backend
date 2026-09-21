import {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { hatStaffel, PreisRow, variantenMitRasterPreisen } from "./preistabelle"

/**
 * Schutz der Mengenstaffel vor dem Standard-Preisraster des Admins.
 *
 * Das Raster («Preise bearbeiten») kennt nur EINE Zelle je Währung und
 * schickt beim Speichern genau einen Preis ohne Mengen. Medusas
 * updatePriceSets löscht dann alle übrigen Basispreise des Price Sets —
 * also still die ganze Staffel (@medusajs/pricing, updatePriceSets_:
 * pricesToDelete). Dieser Middleware lehnt solche Requests für Varianten
 * MIT Staffel ab und verweist auf das Widget «Preistabelle». Varianten ohne
 * Staffel und Requests, die selbst Mengen mitschicken (Importe, API),
 * passieren unverändert.
 */
export async function schuetzePreistabelle(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const ids = new Set(variantenMitRasterPreisen(req.body).filter(Boolean))

  // POST /admin/products/:id/variants/:variant_id — die id steht im Pfad.
  const pfad = (req.originalUrl ?? req.url ?? "").split("?")[0]
  const m = pfad.match(/\/admin\/products\/[^/]+\/variants\/([^/]+)$/)
  if (m && m[1] !== "batch" && variantenMitRasterPreisen(req.body).includes("")) {
    ids.add(m[1])
  }

  if (!ids.size) {
    return next()
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: [
      "id",
      "prices.amount",
      "prices.currency_code",
      "prices.min_quantity",
      "prices.max_quantity",
      "prices.price_list_id",
      "prices.rules_count",
    ],
    filters: { id: [...ids] },
  })

  const betroffen = variants.filter((v: any) =>
    hatStaffel(((v.prices ?? []).filter(Boolean)) as PreisRow[])
  )
  if (betroffen.length) {
    res.status(400).json({
      type: "not_allowed",
      message:
        "Dieser Artikel hat eine Preistabelle (Mengenrabatt). Preise bitte im " +
        "Abschnitt «Preistabelle» auf der Produktseite ändern — hier würden " +
        "die Mengenrabatte gelöscht.",
    })
    return
  }
  next()
}
