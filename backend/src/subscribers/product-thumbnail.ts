import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { backfillProductThumbnails } from "../lib/product-thumbnail"

/**
 * Setzt das Vorschaubild automatisch, sobald ein Produkt Bilder hat, aber
 * kein Thumbnail — Hintergrund und Regeln in lib/product-thumbnail.ts.
 *
 * Warum ein Subscriber und nicht ein Eingriff in den Update-Pfad: Bilder
 * werden im Admin über das gewöhnliche Produkt-Update gespeichert
 * (updateProductsWorkflow), und das feuert product.updated. Der Subscriber
 * hängt sich dahinter, ohne den Speichervorgang selbst anzufassen oder zu
 * verlangsamen — schlägt er fehl, ist das Produkt trotzdem gespeichert.
 *
 * Schleifenfest: unser eigenes Update feuert wieder product.updated, der
 * zweite Durchlauf findet das Thumbnail gesetzt vor und schreibt nichts.
 */

type ProductEventData = { id: string } | { id: string }[]

export default async function productThumbnailHandler({
  event: { data },
  container,
}: SubscriberArgs<ProductEventData>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  // Die Produkt-Workflows melden je nach Pfad ein einzelnes { id } oder ein
  // Array davon (Batch-Update). Beides zulassen, Unbrauchbares ignorieren.
  const ids = (Array.isArray(data) ? data : [data])
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === "string" && id !== "")

  if (!ids.length) {
    return
  }

  try {
    const filled = await backfillProductThumbnails(container, ids)
    if (filled > 0) {
      logger.info(
        `[thumbnail] ${filled} Produkt(e) automatisch mit Vorschaubild versehen.`
      )
    }
  } catch (err) {
    // Nicht werfen: der Speichervorgang des Admins ist längst durch, und die
    // stündliche Nachpflege (jobs/product-thumbnail-backfill.ts) holt das
    // Vorschaubild beim nächsten Lauf nach.
    logger.error(
      `[thumbnail] Vorschaubild konnte nicht gesetzt werden: ${
        err instanceof Error ? err.message : "unbekannter Fehler"
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: ["product.created", "product.updated"],
}
