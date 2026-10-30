/**
 * GET /admin/buchhaltung/lagerbestand?stichtag=JJJJ-MM-TT[&format=csv]
 *
 * Lagerbestand per Stichtag, bewertet zum Einstandspreis
 * (variant.metadata.einstandspreis). Rein lesend; Admin-Login nötig
 * (Admin-Routen sind standardmässig geschützt). Rechenweg und Grenzen:
 * src/lib/buchhaltung.ts und docs/buchhaltung.md.
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { berechneLagerbestand, lagerCsv, pruefeStichtag } from "../../../../lib/buchhaltung"
import { ladeLagerdaten } from "../../../../lib/buchhaltung-laden"
import { GetLagerbestandSchema } from "../validators"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = GetLagerbestandSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues.map((e) => e.message).join(", ") })
    return
  }
  const info = pruefeStichtag(parsed.data.stichtag)
  if ("fehler" in info) {
    res.status(400).json({ message: info.fehler })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const daten = await ladeLagerdaten(query, info.heute ? null : info.grenze)
  const antwort = berechneLagerbestand(daten.varianten, daten.levels, daten.fulfillments, info)
  if (daten.abgeschnitten) {
    antwort.hinweise.unshift("Obergrenze erreicht: Die Daten sind unvollständig.")
  }

  if (parsed.data.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="lagerbestand-${info.stichtag}.csv"`
    )
    res.setHeader("Cache-Control", "no-store")
    res.send(lagerCsv(info.stichtag, antwort.positionen, antwort.summe))
    return
  }
  res.json({ ...antwort, abgeschnitten: daten.abgeschnitten })
}
