/**
 * Admin-Datenzugriff der Nachschubsteuerung: Produkte aus der Admin-API in
 * die reinen NachschubZeilen aus lib/nachschub.ts übersetzen.
 *
 * Die Lieferanten kommen vom PRODUKT (product.metadata.suppliers) — mit
 * Rückfall auf Alt-Einträge in den Varianten-Metadaten, zusammengeführt
 * über effektiveLieferantenMetadata(). Der Meldebestand kommt je VARIANTE
 * (variant.metadata.reorder_point).
 *
 * Der verfügbare Bestand kommt über das berechnete Feld
 * `+variants.inventory_quantity` der Admin-Produkt-API. Ohne
 * Bestandsführung (manage_inventory=false) oder ohne Zahl bleibt der
 * Bestand null — die Variante gilt dann als «nicht überwachbar».
 */
import {
  effektiveLieferantenMetadata,
  NachschubZeile,
  parseLieferanten,
  parseMeldebestand,
} from "../../lib/nachschub"

/** Felder, die Widget und Nachschub-Seite von der Admin-API brauchen. */
export const NACHSCHUB_PRODUCT_FIELDS = [
  "id",
  "title",
  "metadata",
  "variants.id",
  "variants.title",
  "variants.sku",
  "variants.manage_inventory",
  "variants.metadata",
  "+variants.inventory_quantity",
].join(",")

type AdminVariantLike = {
  id: string
  title?: string | null
  sku?: string | null
  manage_inventory?: boolean
  metadata?: Record<string, unknown> | null
  inventory_quantity?: number | null
}

type AdminProductLike = {
  id: string
  title: string
  metadata?: Record<string, unknown> | null
  variants?: AdminVariantLike[] | null
}

/**
 * Die massgebliche Lieferantenliste des Produkts — vom Produkt, oder als
 * Rückfall aus den Alt-Einträgen der Varianten zusammengeführt. Das Widget
 * nutzt quelle/zusammenfuehrung, um die Übernahme sichtbar zu machen.
 */
export function produktLieferanten(product: AdminProductLike) {
  return effektiveLieferantenMetadata(
    product.metadata ?? null,
    (product.variants ?? []).map((v) => v.metadata ?? null)
  )
}

export function zeilenAusProdukt(product: AdminProductLike): NachschubZeile[] {
  // Einmal je Produkt bestimmt — die Lieferanten sind für alle Varianten
  // desselben Produkts dieselben.
  const lieferanten = parseLieferanten(produktLieferanten(product).metadata)
  return (product.variants ?? []).map((v) => {
    // Achtung: Number(null) wäre 0 — nur eine echte Zahl zählt als Bestand,
    // sonst gilt die Variante als «nicht überwachbar».
    const q = v.inventory_quantity
    const bestand =
      v.manage_inventory && typeof q === "number" && Number.isFinite(q)
        ? Math.max(0, q)
        : null
    return {
      sku: v.sku ?? null,
      produkt: product.title,
      variante: v.title ?? "",
      productId: product.id,
      bestand,
      meldebestand: parseMeldebestand(v.metadata ?? null),
      lieferanten,
    }
  })
}

export function zeilenAusProdukten(products: AdminProductLike[]): NachschubZeile[] {
  return products.flatMap(zeilenAusProdukt)
}
