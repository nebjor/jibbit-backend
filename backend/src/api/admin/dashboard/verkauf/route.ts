/**
 * GET /admin/dashboard/verkauf?von=&bis= — Kennzahlen für die Seite «Verkauf».
 *
 * Auth: Admin-Routen sind standardmässig geschützt. Rein lesend.
 * Lädt Bestellungen von Vorzeitraum-Beginn bis Zeitraum-Ende seitenweise
 * (100 pro Seite, höchstens MAX_BESTELLUNGEN) und wertet sie in
 * src/lib/dashboard-verkauf.ts aus (Definition «bezahlt» dort).
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  BESTELL_FELDER,
  bestimmeZeitraum,
  MAX_BESTELLUNGEN,
  RohBestellung,
  SEITENGROESSE,
  werteAus,
} from "../../../../lib/dashboard-verkauf"
import { GetDashboardVerkaufSchema } from "./validators"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = GetDashboardVerkaufSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors.map((e) => e.message).join(", ") })
    return
  }
  const z = bestimmeZeitraum(parsed.data.von, parsed.data.bis)
  if ("fehler" in z) {
    res.status(400).json({ message: z.fehler })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const bestellungen: RohBestellung[] = []
  let abgeschnitten = false
  for (let skip = 0; ; skip += SEITENGROESSE) {
    const { data } = await query.graph({
      entity: "order",
      fields: BESTELL_FELDER,
      filters: {
        created_at: { $gte: new Date(z.vorher.von), $lt: new Date(z.bis) },
      },
      pagination: { skip, take: SEITENGROESSE, order: { created_at: "DESC", id: "ASC" } },
    })
    bestellungen.push(...(data as unknown as RohBestellung[]))
    if (data.length < SEITENGROESSE) break
    if (bestellungen.length >= MAX_BESTELLUNGEN) {
      abgeschnitten = true
      break
    }
  }

  res.json(werteAus(bestellungen, z, abgeschnitten))
}
