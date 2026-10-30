/**
 * GET /admin/buchhaltung/lagerbestand/snapshots
 *   → Liste der gespeicherten Stichtags-Schnappschüsse (neueste zuerst).
 * GET /admin/buchhaltung/lagerbestand/snapshots?id=bestand-JJJJ-MM-TT-HHMMSS&format=csv
 *   → ein Schnappschuss als CSV-Download.
 * Rein lesend. Die ID wird streng geprüft (kein Zugriff ausserhalb des Verzeichnisses).
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { lagerCsv } from "../../../../../lib/buchhaltung"
import {
  ladeSnapshot,
  listeSnapshots,
  snapshotVerzeichnis,
} from "../../../../../lib/buchhaltung-snapshots"
import { GetSnapshotsSchema } from "../../validators"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = GetSnapshotsSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues.map((e) => e.message).join(", ") })
    return
  }
  const dir = snapshotVerzeichnis()
  const { id, format } = parsed.data

  if (!id) {
    try {
      res.json({ snapshots: await listeSnapshots(dir) })
    } catch (e) {
      res.status(500).json({
        message: `Die Schnappschüsse konnten nicht gelesen werden: ${(e as Error).message}`,
      })
    }
    return
  }
  if (format !== "csv") {
    res.status(400).json({ message: "Mit «id» ist «format=csv» nötig." })
    return
  }
  const snapshot = await ladeSnapshot(dir, id)
  if (!snapshot) {
    res.status(404).json({ message: "Schnappschuss nicht gefunden." })
    return
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${snapshot.id}.csv"`)
  res.setHeader("Cache-Control", "no-store")
  res.send(lagerCsv(snapshot.stichtag, snapshot.positionen, snapshot.summe))
}
