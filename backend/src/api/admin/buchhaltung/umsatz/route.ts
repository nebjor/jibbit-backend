/**
 * GET /admin/buchhaltung/umsatz?jahr=JJJJ[&format=csv|zahlungen-csv]
 *
 * Umsatz eines Kalenderjahres (Zürcher Zeit) aus BEZAHLTEN Bestellungen,
 * Definition wie im Verkaufs-Dashboard (src/lib/dashboard-verkauf.ts).
 *  - ohne format: Monatstabelle + Jahressumme + Zahlungssaldo als JSON
 *  - format=csv: alle bezahlten Bestellungen des Jahres (nach Bestelldatum)
 *  - format=zahlungen-csv: Zahlungen und Rückerstattungen nach Zahlungsdatum
 * Rein lesend; Admin-Login nötig (Admin-Routen sind standardmässig geschützt).
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  umsatzBestellungen,
  umsatzCsv,
  umsatzProMonat,
  zahlungenCsv,
  zahlungsposten,
  zahlungsSumme,
  zuerichTag,
} from "../../../../lib/buchhaltung"
import { ladeBestellungen } from "../../../../lib/buchhaltung-laden"
import { GetUmsatzSchema } from "../validators"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = GetUmsatzSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues.map((e) => e.message).join(", ") })
    return
  }
  const jahr = parsed.data.jahr ?? Number(zuerichTag(Date.now()).slice(0, 4))
  const format = parsed.data.format

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { bestellungen, abgeschnitten } = await ladeBestellungen(
    query,
    jahr,
    format !== "csv" // die Bestellliste braucht das Vorjahr nicht
  )

  const csv = (name: string, inhalt: string) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`)
    res.setHeader("Cache-Control", "no-store")
    res.send(inhalt)
  }
  if (format === "csv") {
    csv(`umsatz-${jahr}-bestellungen.csv`, umsatzCsv(umsatzBestellungen(bestellungen, jahr)))
    return
  }
  const posten = zahlungsposten(bestellungen, jahr)
  if (format === "zahlungen-csv") {
    csv(`umsatz-${jahr}-zahlungen.csv`, zahlungenCsv(posten))
    return
  }
  const { monate, summe } = umsatzProMonat(bestellungen, jahr)
  res.json({
    jahr,
    monate,
    summe,
    zahlungen: zahlungsSumme(posten),
    abgeschnitten,
    geladen: bestellungen.length,
  })
}
