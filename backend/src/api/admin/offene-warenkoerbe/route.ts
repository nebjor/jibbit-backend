/**
 * GET /admin/offene-warenkoerbe — Warenkörbe, die nie zur Bestellung wurden.
 *
 * Auth: Admin-Routen sind standardmässig geschützt, hier ist nichts zu tun.
 * Rein lesend: keine Schreibzugriffe, keine E-Mails.
 *
 * Die Auswahl (offen + mindestens eine Position, neueste Aktivität zuerst,
 * Seitenzahl) macht eine SQL-Abfrage auf die Cart-Tabellen, weil sich
 * «hat Positionen» im Query-Graph nicht filtern lässt, ohne die
 * Seitenzählung zu verfälschen. Die Details der Seite lädt danach query.graph.
 */
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  formatiereWarenkorb,
  parseWarenkorbFilter,
  RohWarenkorb,
} from "../../../lib/offene-warenkoerbe"

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const filter = parseWarenkorbFilter(req.query as Record<string, unknown>)
  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const bedingungen = [
    "c.completed_at IS NULL",
    "c.deleted_at IS NULL",
    "EXISTS (SELECT 1 FROM cart_line_item li WHERE li.cart_id = c.id AND li.deleted_at IS NULL)",
  ]
  const werte: (string | number)[] = []
  if (filter.nurMitEmail) {
    bedingungen.push("c.email IS NOT NULL AND c.email <> ''")
  }
  if (filter.mindestAlterStunden !== null) {
    bedingungen.push("c.updated_at <= now() - (? * interval '1 hour')")
    werte.push(filter.mindestAlterStunden)
  }
  const where = bedingungen.join(" AND ")

  const [{ rows }, { rows: zaehler }] = await Promise.all([
    pg.raw(
      `SELECT c.id FROM cart c WHERE ${where} ORDER BY c.updated_at DESC, c.id LIMIT ? OFFSET ?`,
      [...werte, filter.limit, filter.offset]
    ),
    pg.raw(`SELECT count(*)::int AS count FROM cart c WHERE ${where}`, werte),
  ])
  const ids: string[] = rows.map((r: { id: string }) => r.id)
  const count: number = zaehler[0]?.count ?? 0

  let carts: ReturnType<typeof formatiereWarenkorb>[] = []
  if (ids.length) {
    const { data } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "created_at",
        "updated_at",
        "email",
        "currency_code",
        "region.name",
        "customer.id",
        "customer.first_name",
        "customer.last_name",
        "customer.email",
        "items.id",
        "items.title",
        "items.product_title",
        "items.variant_title",
        "items.variant_sku",
        "items.quantity",
        "items.unit_price",
        "items.thumbnail",
        "shipping_address.city",
        "shipping_address.country_code",
        "payment_collection.payment_sessions.id",
        "subtotal",
        "item_total",
        "total",
        "completed_at",
        "deleted_at",
      ],
      filters: { id: ids },
    })
    const nachId = new Map(
      ((data ?? []) as unknown as RohWarenkorb[]).filter((c) => !!c).map((c) => [c.id, c])
    )
    carts = ids
      .map((id) => nachId.get(id))
      // Zusätzliche Absicherung: nie abgeschlossene oder gelöschte Warenkörbe.
      .filter((c): c is RohWarenkorb => !!c && !c.completed_at && !c.deleted_at)
      .map(formatiereWarenkorb)
  }

  res.json({ carts, count, limit: filter.limit, offset: filter.offset })
}
