import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { backfillProductThumbnails } from "../lib/product-thumbnail"

/**
 * Stündliche Nachpflege: fehlende Vorschaubilder aus der Galerie füllen —
 * Hintergrund und Regeln in lib/product-thumbnail.ts.
 *
 * Zwei Aufgaben:
 *
 *   1. BESTANDSBEREINIGUNG. Die vor dieser Änderung angelegten Produkte haben
 *      Bilder, aber kein Thumbnail. Der erste Lauf nach dem Deployment setzt
 *      alle auf einmal — niemand muss ein Skript starten oder die Produkte
 *      einzeln anfassen.
 *
 *   2. AUFFANGNETZ für den Subscriber (subscribers/product-thumbnail.ts):
 *      geht dort ein Ereignis verloren (Neustart im falschen Moment,
 *      Event-Bus-Schluckauf), zieht dieser Lauf nach.
 *
 * Der Lauf ist idempotent und bei ~30 Produkten billig (eine Abfrage, meist
 * null Schreibzugriffe); ein gesetztes Thumbnail wird nie überschrieben.
 * Er läuft bewusst dauerhaft und nicht mit numberOfExecutions: 1 — als
 * Auffangnetz kostet er nichts und erspart den Sonderfall «einmaliges
 * Aufräumskript, das ein Mensch anstossen muss».
 */

export default async function productThumbnailBackfillJob(
  container: MedusaContainer
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const filled = await backfillProductThumbnails(container)
    if (filled > 0) {
      logger.info(
        `[thumbnail] Nachpflege: ${filled} Produkt(e) mit Vorschaubild versehen.`
      )
    }
  } catch (err) {
    // Nächster Lauf in einer Stunde — Fehler protokollieren, nicht werfen.
    logger.error(
      `[thumbnail] Nachpflege fehlgeschlagen: ${
        err instanceof Error ? err.message : "unbekannter Fehler"
      }`
    )
  }
}

export const config = {
  name: "product-thumbnail-backfill",
  schedule: "0 * * * *", // stündlich
}
