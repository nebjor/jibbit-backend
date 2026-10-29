/**
 * POST /admin/buchhaltung/lagerbestand/snapshot — speichert den heutigen
 * Lagerbestand (Live-Stand, mit Einstandspreisen) als Stichtags-Schnappschuss.
 *
 * Schreibt NUR eine neue Datei im Buchhaltungs-Verzeichnis
 * (src/lib/buchhaltung-snapshots.ts), nie in die Medusa-Datenbank. Bestehende
 * Schnappschüsse werden nicht verändert. Kein Body nötig.
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { berechneLagerbestand, pruefeStichtag } from "../../../../../lib/buchhaltung"
import { ladeLagerdaten } from "../../../../../lib/buchhaltung-laden"
import {
  baueSnapshot,
  snapshotVerzeichnis,
  speichereSnapshot,
} from "../../../../../lib/buchhaltung-snapshots"

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const info = pruefeStichtag(undefined)
  if ("fehler" in info) {
    res.status(500).json({ message: info.fehler })
    return
  }
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const daten = await ladeLagerdaten(query, null)
  if (daten.abgeschnitten) {
    res.status(422).json({
      message: "Zu viele Daten (Obergrenze erreicht) — der Schnappschuss wäre unvollständig.",
    })
    return
  }
  const antwort = berechneLagerbestand(daten.varianten, daten.levels, [], info)
  const snapshot = baueSnapshot(
    info.stichtag,
    antwort.positionen,
    antwort.summe,
    req.auth_context?.actor_id ?? null
  )
  try {
    await speichereSnapshot(snapshotVerzeichnis(), snapshot)
  } catch (e) {
    res.status(500).json({
      message: `Der Schnappschuss konnte nicht gespeichert werden: ${(e as Error).message}`,
    })
    return
  }
  res.status(201).json({
    snapshot: {
      id: snapshot.id,
      stichtag: snapshot.stichtag,
      erstellt_am: snapshot.erstellt_am,
      erstellt_von: snapshot.erstellt_von,
      stueck: snapshot.summe.stueck,
      wert: snapshot.summe.wert,
      ohne_einstandspreis: snapshot.summe.ohne_einstandspreis,
    },
  })
}
