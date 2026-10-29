/**
 * Datenbankzugriff der Buchhaltungs-Berichte (query.graph, rein lesend).
 * Die Auswertung selbst steht in buchhaltung.ts. Alle Abfragen laufen
 * seitenweise (SEITENGROESSE = 100) mit fester Sortierung.
 */
import { BESTELL_FELDER, SEITENGROESSE } from "./dashboard-verkauf"
import {
  BUCHHALTUNG_ZUSATZFELDER,
  jahresGrenzen,
  RohBestellungBuch,
  RohFulfillment,
  RohLevel,
  RohVariante,
} from "./buchhaltung"

/** Obergrenze je Abfrage, damit eine Fehlkonfiguration den Speicher nicht sprengt. */
export const MAX_ZEILEN = 20_000

type QueryLike = {
  graph: (args: any) => Promise<{ data: any[] }>
}

/** Lädt eine ganze Entität seitenweise; `abgeschnitten`, wenn MAX_ZEILEN erreicht. */
async function ladeAlle<T>(
  query: QueryLike,
  args: { entity: string; fields: string[]; filters?: Record<string, unknown> },
  order: Record<string, "ASC" | "DESC">
): Promise<{ zeilen: T[]; abgeschnitten: boolean }> {
  const zeilen: T[] = []
  for (let skip = 0; ; skip += SEITENGROESSE) {
    const { data } = await query.graph({
      ...args,
      pagination: { skip, take: SEITENGROESSE, order },
    })
    zeilen.push(...(data as T[]))
    if (data.length < SEITENGROESSE) return { zeilen, abgeschnitten: false }
    if (zeilen.length >= MAX_ZEILEN) return { zeilen, abgeschnitten: true }
  }
}

export const VARIANTEN_FELDER = [
  "id",
  "sku",
  "barcode",
  "ean",
  "title",
  "manage_inventory",
  "metadata",
  "product.id",
  "product.title",
  "inventory_items.inventory_item_id",
  "inventory_items.required_quantity",
]

export const LEVEL_FELDER = ["id", "inventory_item_id", "location_id", "stocked_quantity"]

export const FULFILLMENT_FELDER = [
  "id",
  "location_id",
  "created_at",
  "canceled_at",
  "items.inventory_item_id",
  "items.quantity",
]

/**
 * Alle Daten für den Lagerbestand. Fulfillments werden nur für vergangene
 * Stichtage geladen: erstellt ab Stichtag-Ende ODER storniert ab Stichtag-Ende.
 */
export async function ladeLagerdaten(query: QueryLike, grenze: number | null) {
  const varianten = await ladeAlle<RohVariante>(
    query,
    { entity: "product_variant", fields: VARIANTEN_FELDER },
    { id: "ASC" }
  )
  const levels = await ladeAlle<RohLevel>(
    query,
    { entity: "inventory_level", fields: LEVEL_FELDER },
    { id: "ASC" }
  )
  let fulfillments: RohFulfillment[] = []
  let ffAbgeschnitten = false
  if (grenze !== null) {
    const ab = new Date(grenze)
    const erstellt = await ladeAlle<RohFulfillment>(
      query,
      { entity: "fulfillment", fields: FULFILLMENT_FELDER, filters: { created_at: { $gte: ab } } },
      { id: "ASC" }
    )
    const storniert = await ladeAlle<RohFulfillment>(
      query,
      { entity: "fulfillment", fields: FULFILLMENT_FELDER, filters: { canceled_at: { $gte: ab } } },
      { id: "ASC" }
    )
    const nachId = new Map<string, RohFulfillment>()
    for (const f of [...erstellt.zeilen, ...storniert.zeilen]) nachId.set(f.id, f)
    fulfillments = [...nachId.values()]
    ffAbgeschnitten = erstellt.abgeschnitten || storniert.abgeschnitten
  }
  return {
    varianten: varianten.zeilen,
    levels: levels.zeilen,
    fulfillments,
    abgeschnitten: varianten.abgeschnitten || levels.abgeschnitten || ffAbgeschnitten,
  }
}

/**
 * Bestellungen für den Umsatzbericht: Bestelldatum im Jahr; für die
 * Zahlungsliste zusätzlich das Vorjahr (Zahlungen/Rückerstattungen im Jahr
 * zu Bestellungen des Vorjahres).
 */
export async function ladeBestellungen(query: QueryLike, jahr: number, mitVorjahr: boolean) {
  const von = mitVorjahr ? jahresGrenzen(jahr - 1).von : jahresGrenzen(jahr).von
  const bis = jahresGrenzen(jahr).bis
  const r = await ladeAlle<RohBestellungBuch>(
    query,
    {
      entity: "order",
      fields: [...BESTELL_FELDER, ...BUCHHALTUNG_ZUSATZFELDER],
      filters: { created_at: { $gte: new Date(von), $lt: new Date(bis) } },
    },
    { created_at: "ASC", id: "ASC" }
  )
  return { bestellungen: r.zeilen, abgeschnitten: r.abgeschnitten }
}
