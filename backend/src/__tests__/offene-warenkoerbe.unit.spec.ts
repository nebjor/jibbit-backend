/**
 * Offene Warenkörbe: Filter-Parsing, Formatierung und die GET-Route
 * (mit gefälschtem Container, ohne Datenbank).
 */
import { GET } from "../api/admin/offene-warenkoerbe/route"
import {
  formatiereWarenkorb,
  MAX_LIMIT,
  parseWarenkorbFilter,
  STANDARD_LIMIT,
} from "../lib/offene-warenkoerbe"

describe("parseWarenkorbFilter", () => {
  it("setzt Standardwerte", () => {
    expect(parseWarenkorbFilter({})).toEqual({
      limit: STANDARD_LIMIT,
      offset: 0,
      nurMitEmail: false,
      mindestAlterStunden: null,
    })
  })

  it("begrenzt limit und weist Unsinn ab", () => {
    expect(parseWarenkorbFilter({ limit: "9999" }).limit).toBe(MAX_LIMIT)
    expect(parseWarenkorbFilter({ limit: "0" }).limit).toBe(1)
    expect(parseWarenkorbFilter({ limit: "abc", offset: "-5" })).toMatchObject({
      limit: STANDARD_LIMIT,
      offset: 0,
    })
  })

  it("liest E-Mail- und Alters-Filter", () => {
    expect(
      parseWarenkorbFilter({ nur_mit_email: "true", min_alter_stunden: "24" })
    ).toMatchObject({ nurMitEmail: true, mindestAlterStunden: 24 })
  })
})

const roh = {
  id: "cart_1",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  email: null,
  currency_code: "chf",
  region: { name: "Schweiz" },
  customer: { id: "cus_1", first_name: "Anna", last_name: "Muster", email: "anna@example.ch" },
  items: [
    { id: "i1", title: "Variante", product_title: "USB-Kabel", variant_title: "1 m", variant_sku: "USB-1", quantity: 2, unit_price: 5, thumbnail: "t.png" },
    { id: "i2", title: "Hülle", quantity: 1, unit_price: { value: "12.5" } },
  ],
  shipping_address: { city: "Bern", country_code: "ch" },
  payment_collection: { payment_sessions: [] },
  subtotal: 22.5,
  total: 22.5,
}

describe("formatiereWarenkorb", () => {
  it("fasst Kunde, Positionen und Summen zusammen", () => {
    const c = formatiereWarenkorb(roh)
    expect(c.email).toBe("anna@example.ch")
    expect(c.customer).toEqual({ id: "cus_1", name: "Anna Muster", email: "anna@example.ch" })
    expect(c.item_count).toBe(3)
    expect(c.items[0]).toMatchObject({ title: "USB-Kabel", sku: "USB-1", unit_price: 5 })
    expect(c.items[1].unit_price).toBe(12.5)
    expect(c.total).toBe(22.5)
    expect(c.shipping_city).toBe("Bern")
  })

  it("erkennt begonnene Kasse an der Zahlungssitzung", () => {
    expect(formatiereWarenkorb(roh).status).toBe("nur_warenkorb")
    const mit = formatiereWarenkorb({
      ...roh,
      payment_collection: { payment_sessions: [{ id: "ps_1" }] },
    })
    expect(mit.checkout_started).toBe(true)
    expect(mit.status).toBe("kasse_begonnen")
  })

  it("kommt mit Gastwarenkorb ohne alles klar", () => {
    const c = formatiereWarenkorb({ id: "c", created_at: "", updated_at: "" })
    expect(c).toMatchObject({ email: null, customer: null, item_count: 0, items: [], total: 0 })
  })
})

describe("GET /admin/offene-warenkoerbe", () => {
  function setup(zeilen: { id: string }[], count: number, graph: any[]) {
    const raw = jest
      .fn()
      .mockResolvedValueOnce({ rows: zeilen })
      .mockResolvedValueOnce({ rows: [{ count }] })
    const queryGraph = jest.fn().mockResolvedValue({ data: graph })
    const scope = {
      resolve: (key: string) => (key === "query" ? { graph: queryGraph } : { raw }),
    }
    const res: any = { json: jest.fn() }
    return { raw, queryGraph, scope, res }
  }

  it("liefert Seite in SQL-Reihenfolge samt Gesamtzahl", async () => {
    const { scope, res, raw } = setup([{ id: "b" }, { id: "a" }], 7, [
      { ...roh, id: "a" },
      { ...roh, id: "b" },
    ])
    await GET({ scope, query: { limit: "2", nur_mit_email: "true" } } as any, res)
    const body = res.json.mock.calls[0][0]
    expect(body.carts.map((c: any) => c.id)).toEqual(["b", "a"])
    expect(body).toMatchObject({ count: 7, limit: 2, offset: 0 })
    expect(raw.mock.calls[0][0]).toContain("completed_at IS NULL")
    expect(raw.mock.calls[0][0]).toContain("c.email IS NOT NULL")
  })

  it("lädt keine Details, wenn die Seite leer ist", async () => {
    const { scope, res, queryGraph } = setup([], 0, [])
    await GET({ scope, query: {} } as any, res)
    expect(queryGraph).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0]).toMatchObject({ carts: [], count: 0 })
  })
})

// ---------------------------------------------------------------------------
// Echte Form aus query.graph (Medusa v2): total/subtotal/unit_price/quantity
// sind BigNumber-INSTANZEN (Getter numeric, raw.value, valueOf), kein `value`.
// Der Betrag war deshalb überall CHF 0.00. Live nicht prüfbar (Browser-
// Verbindung fehlte), Form aus dem Dashboard-Fix (PR #71) übernommen.
// ---------------------------------------------------------------------------
import { BigNumber } from "@medusajs/framework/utils"

describe("BigNumber-Beträge", () => {
  const bn = (n: number) => new BigNumber(n) as never

  it("liest total, subtotal, unit_price und quantity aus BigNumber-Instanzen", () => {
    const c = formatiereWarenkorb({
      ...roh,
      items: [
        { id: "i1", title: "A", quantity: bn(2), unit_price: bn(5) },
        { id: "i2", title: "B", quantity: bn(1), unit_price: bn(12.5) },
      ],
      subtotal: bn(22.5),
      total: bn(22.5),
    })
    expect(c.total).toBe(22.5)
    expect(c.subtotal).toBe(22.5)
    expect(c.item_count).toBe(3)
    expect(c.items.map((i) => i.unit_price)).toEqual([5, 12.5])
    expect(c.items.map((i) => i.quantity)).toEqual([2, 1])
  })

  it("fällt bei leerem total auf item_total bzw. Positionssumme zurück", () => {
    expect(formatiereWarenkorb({ ...roh, total: bn(0), item_total: bn(20) }).total).toBe(20)
    expect(formatiereWarenkorb({ ...roh, total: null, subtotal: null }).total).toBe(22.5)
  })

  it("Route liefert Beträge als Zahlen, Arrays immer, und überspringt abgeschlossene", async () => {
    const raw = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
    const graph = jest.fn().mockResolvedValue({
      data: [
        { ...roh, id: "a", total: bn(22.5), items: undefined, payment_collection: null },
        { ...roh, id: "b", completed_at: "2026-10-03T00:00:00Z" },
      ],
    })
    const scope = { resolve: (k: string) => (k === "query" ? { graph } : { raw }) }
    const res: any = { json: jest.fn() }
    await GET({ scope, query: {} } as any, res)
    const body = res.json.mock.calls[0][0]
    expect(body.carts).toHaveLength(1)
    expect(body.carts[0]).toMatchObject({ id: "a", total: 22.5, items: [], status: "nur_warenkorb" })
  })
})
