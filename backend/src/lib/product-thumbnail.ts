/**
 * Vorschaubild (`product.thumbnail`) automatisch aus der Bildergalerie füllen.
 *
 * Medusa führt zwei getrennte Felder: `images` ist die Galerie, die man im
 * Admin unter «Media» pflegt — `thumbnail` ist ein eigenes Feld, und NUR das
 * zeigt die Produktliste des Admins. Bilder hochzuladen füllt `thumbnail`
 * nicht. Wer den Shop ohne IT-Kenntnisse führt, soll von diesem zweiten Feld
 * nichts wissen müssen: hat ein Produkt Bilder, aber kein Vorschaubild,
 * setzen wir das erste Bild ein.
 *
 * DIE EINE REGEL, DIE NIE VERLETZT WERDEN DARF: ein gesetztes Thumbnail wird
 * niemals überschrieben. Wer im Admin absichtlich das dritte Bild als
 * Vorschau wählt, behält es. Gefüllt wird ausschliesslich, was leer ist
 * (null oder Leerstring).
 *
 * Verwendet von:
 *   - src/subscribers/product-thumbnail.ts  (product.created / product.updated)
 *   - src/jobs/product-thumbnail-backfill.ts (stündliche Nachpflege, deckt
 *     insbesondere die Bestandsprodukte ab, die vor dem Subscriber entstanden)
 *
 * Die Storefront ist davon unberührt: sie baut ihre Galerie aus `images`,
 * nicht aus `thumbnail`.
 */

import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows"

/** Der Ausschnitt eines Produkts, den die Planung braucht. */
export type ProductThumbnailRow = {
  id: string
  thumbnail?: string | null
  images?: { url?: string | null; rank?: number | null }[] | null
}

/** Ein gesetztes Thumbnail ist eine nicht-leere Zeichenkette. */
export function hasThumbnail(thumbnail: string | null | undefined): boolean {
  return typeof thumbnail === "string" && thumbnail.trim() !== ""
}

/**
 * Das «erste» Bild eines Produkts — das, das der Admin unter Media zuoberst
 * zeigt. Massgeblich ist `rank`, nicht die Reihenfolge der Datenbankzeilen:
 * die ist nach einem Update nicht garantiert (gleiche Beobachtung wie in
 * scripts/import-product-images.ts). Bilder ohne brauchbare URL werden
 * übersprungen.
 */
export function firstImageUrl(row: ProductThumbnailRow): string | null {
  const images = (row.images ?? []).filter(
    (img): img is { url: string; rank?: number | null } =>
      typeof img?.url === "string" && img.url.trim() !== ""
  )
  if (!images.length) {
    return null
  }

  const sorted = [...images].sort(
    (a, b) =>
      (typeof a.rank === "number" ? a.rank : Number.MAX_SAFE_INTEGER) -
      (typeof b.rank === "number" ? b.rank : Number.MAX_SAFE_INTEGER)
  )
  return sorted[0].url
}

/**
 * Reine Planung, ohne Datenbank: welche Produkte bekommen welches Thumbnail?
 *
 * Aufgenommen wird ein Produkt genau dann, wenn es Bilder hat UND sein
 * Thumbnail leer ist. Alles andere bleibt unangetastet — insbesondere
 * Produkte ohne Bilder (nichts einzusetzen) und Produkte mit gesetztem
 * Thumbnail (Entscheid des Betreibers).
 */
export function planThumbnailBackfill(
  products: ProductThumbnailRow[]
): { id: string; thumbnail: string }[] {
  const updates: { id: string; thumbnail: string }[] = []

  for (const product of products) {
    if (hasThumbnail(product.thumbnail)) {
      continue
    }
    const url = firstImageUrl(product)
    if (url) {
      updates.push({ id: product.id, thumbnail: url })
    }
  }

  return updates
}

/**
 * Fehlende Thumbnails setzen — für die angegebenen Produkte oder, ohne `ids`,
 * für den ganzen Katalog (Grössenordnung 30 Produkte; ein voller Durchlauf
 * ist billiger als filigrane Datenbankfilter für «leer oder Leerstring»).
 *
 * Geschrieben wird NUR `thumbnail`. `images` wird nicht angefasst, damit das
 * Update keine Bildzeilen löscht, neu anlegt oder umsortiert.
 *
 * Idempotent und schleifenfest: das ausgelöste product.updated-Ereignis trifft
 * zwar wieder den Subscriber, findet dann aber ein gesetztes Thumbnail vor
 * und schreibt nichts mehr.
 *
 * @returns Anzahl der Produkte, die ein Thumbnail bekommen haben.
 */
export async function backfillProductThumbnails(
  container: MedusaContainer,
  ids?: string[]
): Promise<number> {
  if (ids && !ids.length) {
    return 0
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "thumbnail", "images.url", "images.rank"],
    ...(ids ? { filters: { id: ids } } : {}),
  })

  const updates = planThumbnailBackfill(products as ProductThumbnailRow[])
  if (!updates.length) {
    return 0
  }

  await updateProductsWorkflow(container).run({
    input: { products: updates },
  })

  return updates.length
}
