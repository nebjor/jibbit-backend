/**
 * /store/price-tiers — die Staffeltabelle der Produktseite.
 *
 * Hintergrund: Die Preistabelle legt die Mengenstaffeln in die
 * Preisliste „Aktionspreise jibbit.ch"; der Basispreis der Variante ist nur
 * noch der reguläre Einzelpreis. Die Route darf Preislisten deshalb nicht
 * mehr überspringen — aber sie darf auch nicht einfach alle Listen zeigen,
 * sonst stünden künftige Händlerpreise (auf Kundengruppen eingeschränkte
 * Listen) für jeden Gast im Netz.
 *
 * Der Fake-Pricing-Service hier bildet die Auswahlsemantik von Medusas
 * `calculatePrices` nach (@medusajs/pricing, repositories/pricing.js):
 * nur AKTIVE Listen im Datumsfenster zählen, und eine Liste mit Regeln
 * greift nur, wenn der Kontext JEDE Regel erfüllt. Nachgebildet ist auch
 * das dort real existierende Kontextloch: `quantity` und `currency_code`
 * werden vor der Regelauswertung aus dem Kontext entfernt — bleibt nichts
 * übrig, prüft die Abfrage Preislisten-Regeln GAR NICHT. Die Tests belegen,
 * dass die Route dieses Loch nie betritt (Gast-Marker) und dass ihr Riegel
 * selbst dann hält, wenn die Regelauswertung umgangen würde. Die
 * eigentliche Gültigkeitsprüfung übernimmt in Produktion Medusa selbst;
 * hier wird geprüft, dass die Route sie richtig benutzt.
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

import { GET } from "../api/store/price-tiers/route"
import {
  collectQuantityBreakpoints,
  tiersFromProbes,
} from "../api/store/price-tiers/tiers"

// ─── Fake-Bausteine ───────────────────────────────────────────────

type FakePriceList = {
  id: string
  type: "sale" | "override"
  status: "active" | "draft"
  starts_at?: Date | null
  ends_at?: Date | null
  /** attribute → erlaubte Werte, z.B. { "customer.groups.id": ["cgrp_x"] } */
  rules?: Record<string, string[]>
}

type FakePrice = {
  id: string
  price_set_id: string
  amount: number
  currency_code: string
  min_quantity: number | null
  max_quantity: number | null
  price_list_id: string | null
}

type CalculateCall = { quantity: number | undefined; context: Record<string, unknown> }

function makePricingService(
  prices: FakePrice[],
  priceLists: FakePriceList[],
  opts: {
    /**
     * Simuliert eine (hypothetische) Auswertung, die Listen-Regeln komplett
     * übergeht — damit lässt sich der Riegel der Route isoliert testen.
     */
    ignoreListRules?: boolean
  } = {}
) {
  const listsById = new Map(priceLists.map((pl) => [pl.id, pl]))
  const calculateCalls: CalculateCall[] = []

  const quantityMatches = (p: FakePrice, quantity: number | undefined) => {
    if (quantity === undefined) {
      return p.min_quantity === null || p.min_quantity <= 1
    }
    const minOk = p.min_quantity === null || p.min_quantity <= quantity
    const maxOk = p.max_quantity === null || p.max_quantity >= quantity
    return minOk && maxOk
  }

  const listApplies = (
    pl: FakePriceList,
    ruleContext: Record<string, unknown>,
    hasComplexContext: boolean
  ) => {
    const now = new Date()
    if (pl.status !== "active") return false
    if (pl.starts_at && pl.starts_at > now) return false
    if (pl.ends_at && pl.ends_at < now) return false
    if (opts.ignoreListRules) return true
    // Das reale Kontextloch: ohne verbleibende Kontext-Attribute prüft
    // Medusas SQL die price_list_rules überhaupt nicht.
    if (!hasComplexContext) return true
    return Object.entries(pl.rules ?? {}).every(([attribute, values]) => {
      const given = ruleContext[attribute]
      const arr = Array.isArray(given) ? given : [given]
      return arr.some((v) => typeof v === "string" && values.includes(v))
    })
  }

  return {
    calculateCalls,

    // Wie Medusas listPrices: liefert ALLE Zeilen, auch aus Entwurfs- oder
    // eingeschränkten Listen — Gültigkeit prüft erst calculatePrices.
    async listPrices(filters: {
      price_set_id: string[]
      currency_code?: string
    }) {
      return prices.filter(
        (p) =>
          filters.price_set_id.includes(p.price_set_id) &&
          (!filters.currency_code ||
            p.currency_code === filters.currency_code)
      )
    },

    async listPriceLists(filters: { id: string[] }) {
      return priceLists
        .filter((pl) => filters.id.includes(pl.id))
        .map((pl) => ({
          id: pl.id,
          price_list_rules: Object.keys(pl.rules ?? {}).map((attribute) => ({
            attribute,
          })),
        }))
    },

    async calculatePrices(
      pricingFilters: { id: string[] },
      pricingContext: { context: Record<string, unknown> }
    ) {
      const context = pricingContext.context ?? {}
      const quantity = context.quantity as number | undefined
      calculateCalls.push({ quantity, context })

      // Wie im Original: quantity und currency_code zählen nicht als
      // Regel-Kontext.
      const ruleContext: Record<string, unknown> = { ...context }
      delete ruleContext.quantity
      delete ruleContext.currency_code
      const hasComplexContext = Object.entries(ruleContext).some(
        ([, v]) => (Array.isArray(v) ? v.length > 0 : v != null && v !== "")
      )

      const results: {
        id: string
        calculated_amount: number
        original_amount: number | null
        currency_code: string
        calculated_price: { price_list_id: string | null }
        original_price: { price_list_id: string | null }
      }[] = []

      for (const priceSetId of pricingFilters.id) {
        const candidates = prices.filter(
          (p) =>
            p.price_set_id === priceSetId &&
            p.currency_code === context.currency_code &&
            quantityMatches(p, quantity)
        )

        const defaults = candidates
          .filter((p) => p.price_list_id === null)
          .sort((a, b) => a.amount - b.amount)
        const fromLists = candidates
          .filter(
            (p) =>
              p.price_list_id !== null &&
              listApplies(
                listsById.get(p.price_list_id)!,
                ruleContext,
                hasComplexContext
              )
          )
          .sort((a, b) => a.amount - b.amount)

        const defaultPrice = defaults[0]
        const listPrice = fromLists[0]

        let winner = defaultPrice
        let original = defaultPrice
        if (listPrice) {
          const type = listsById.get(listPrice.price_list_id!)!.type
          if (type === "override") {
            winner = listPrice
            original = listPrice
          } else {
            winner =
              defaultPrice && defaultPrice.amount <= listPrice.amount
                ? defaultPrice
                : listPrice
          }
        }

        if (winner) {
          results.push({
            id: priceSetId,
            calculated_amount: winner.amount,
            original_amount: original ? original.amount : null,
            currency_code: winner.currency_code,
            calculated_price: { price_list_id: winner.price_list_id },
            original_price: {
              price_list_id: original ? original.price_list_id : null,
            },
          })
        }
      }

      return results
    },
  }
}

function makeScope(
  pricing: ReturnType<typeof makePricingService>,
  links: { variant_id: string; price_set_id: string }[]
) {
  const linkModule = {
    getLinkModule: () => ({
      list: async (filters: { variant_id: string[] }) =>
        links.filter((l) => filters.variant_id.includes(l.variant_id)),
    }),
  }
  return {
    resolve: (key: string) => {
      if (key === Modules.PRICING) return pricing
      if (key === ContainerRegistrationKeys.LINK) return linkModule
      throw new Error(`Unerwartete Auflösung im Test: ${key}`)
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

async function callRoute(
  pricing: ReturnType<typeof makePricingService>,
  links: { variant_id: string; price_set_id: string }[],
  query: Record<string, unknown>
) {
  const req = { scope: makeScope(pricing, links), query } as never
  const res = makeRes()
  await GET(req, res as never)
  return res
}

// ─── Fixtures ─────────────────────────────────────────────────────

const VARIANT = "variant_greengo"
const PSET = "pset_greengo"
const LINKS = [{ variant_id: VARIANT, price_set_id: PSET }]

let priceId = 0
const price = (
  amount: number,
  min: number | null,
  max: number | null,
  priceListId: string | null = null
): FakePrice => ({
  id: `price_${++priceId}`,
  price_set_id: PSET,
  amount,
  currency_code: "chf",
  min_quantity: min,
  max_quantity: max,
  price_list_id: priceListId,
})

/** Die echten Greengo-Staffeln (jibbit.ch). */
const greengoListRows = (listId: string) => [
  price(1.95, 1, 9, listId),
  price(1.85, 10, 23, listId),
  price(1.4, 24, 47, listId),
  price(1.35, 48, 119, listId),
  price(1.3, 120, null, listId),
]

// ─── Fall 1: Staffeln liegen NUR in der Preisliste (heutiger Stand) ──

test("Staffeln aus einer aktiven Sale-Preisliste erscheinen in der Tabelle, mit regulärem Preis", async () => {
  const pricing = makePricingService(
    [price(2.5, 1, null), ...greengoListRows("pl_aktion")],
    [{ id: "pl_aktion", type: "sale", status: "active" }]
  )

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  expect(res.statusCode).toBe(200)
  expect((res.body as { tiers: Record<string, unknown[]> }).tiers[VARIANT]).toEqual([
    { min_quantity: 1, max_quantity: 9, amount: 1.95, original_amount: 2.5, currency_code: "chf" },
    { min_quantity: 10, max_quantity: 23, amount: 1.85, original_amount: 2.5, currency_code: "chf" },
    { min_quantity: 24, max_quantity: 47, amount: 1.4, original_amount: 2.5, currency_code: "chf" },
    { min_quantity: 48, max_quantity: 119, amount: 1.35, original_amount: 2.5, currency_code: "chf" },
    { min_quantity: 120, max_quantity: null, amount: 1.3, original_amount: 2.5, currency_code: "chf" },
  ])
})

// ─── Fall 2: Staffeln liegen weiterhin im Basispreis ────────────────
// (13 Varianten stehen nicht auf jibbit.ch und haben keine Preisliste.)

test("Staffeln im Basispreis funktionieren ohne Preisliste weiter", async () => {
  const pricing = makePricingService(
    [price(3.2, 1, 9), price(3.0, 10, null)],
    []
  )

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  expect((res.body as { tiers: Record<string, unknown[]> }).tiers[VARIANT]).toEqual([
    { min_quantity: 1, max_quantity: 9, amount: 3.2, original_amount: 3.2, currency_code: "chf" },
    { min_quantity: 10, max_quantity: null, amount: 3.0, original_amount: 3.0, currency_code: "chf" },
  ])
})

// ─── Fall 3: beide Quellen — die Preisliste gewinnt, wie im Warenkorb ──

test("Existieren Basis-Staffeln UND eine Override-Preisliste, zeigt die Tabelle die Preisliste — auch wo der Basispreis günstiger wäre", async () => {
  const pricing = makePricingService(
    [
      // Basispreis mit eigenen Staffeln; ab 10 Stück BILLIGER als die Liste.
      price(2.5, 1, 9),
      price(1.8, 10, null),
      // Override-Liste: gewinnt im Warenkorb bedingungslos.
      price(1.95, 1, 23, "pl_override"),
      price(1.4, 24, null, "pl_override"),
    ],
    [{ id: "pl_override", type: "override", status: "active" }]
  )

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  // Die Basis-Sprungstelle bei 10 erzeugt KEINE eigene Stufe: der Warenkorb
  // verlangt dort 1.95 (Override), also zeigt die Tabelle dort auch 1.95.
  expect((res.body as { tiers: Record<string, unknown[]> }).tiers[VARIANT]).toEqual([
    { min_quantity: 1, max_quantity: 23, amount: 1.95, original_amount: 1.95, currency_code: "chf" },
    { min_quantity: 24, max_quantity: null, amount: 1.4, original_amount: 1.4, currency_code: "chf" },
  ])
})

// ─── Kundengruppen: eingeschränkte Listen bleiben unsichtbar ────────

/** Basispreis plus Händlerliste (aktiv, aber auf eine Kundengruppe beschränkt). */
const haendlerFixture = () =>
  [
    [
      price(2.5, 1, null),
      // Künftige Händlerpreise: deutlich billiger, eigene Staffel ab 50.
      price(1.0, 1, 49, "pl_haendler"),
      price(0.9, 50, null, "pl_haendler"),
    ],
    [
      {
        id: "pl_haendler",
        type: "sale",
        status: "active",
        rules: { "customer.groups.id": ["cgrp_haendler"] },
      },
    ],
  ] as [FakePrice[], FakePriceList[]]

const expectNoHaendlerPreise = (body: unknown) => {
  const tiers = (body as { tiers: Record<string, unknown[]> }).tiers[VARIANT]
  expect(tiers).toEqual([
    { min_quantity: 1, max_quantity: null, amount: 2.5, original_amount: 2.5, currency_code: "chf" },
  ])
  expect(JSON.stringify(body)).not.toContain("0.9")
  expect(JSON.stringify(body)).not.toContain('"amount":1')
}

test("Eine auf eine Kundengruppe eingeschränkte Preisliste erscheint für Gäste nicht (Anfrage mit region_id, wie das Frontend)", async () => {
  const [rows, lists] = haendlerFixture()
  const pricing = makePricingService(rows, lists)

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
    region_id: "reg_ch",
  })

  expectNoHaendlerPreise(res.body)

  // Die Route fragt als Gast an: Region ja, aber kein Kunde und keine
  // Kundengruppe — Medusas Regelauswertung filtert die Händlerliste.
  for (const call of pricing.calculateCalls) {
    expect(Object.keys(call.context).sort()).toEqual([
      "currency_code",
      "quantity",
      "region_id",
    ])
  }
})

test("Auch ohne region_id (nur currency_code) bleibt die Händlerliste unsichtbar — der Gast-Marker erzwingt die Regelauswertung", async () => {
  const [rows, lists] = haendlerFixture()
  const pricing = makePricingService(rows, lists)

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  expectNoHaendlerPreise(res.body)

  // Ohne den Marker wäre der Kontext nach Abzug von quantity/currency leer
  // und Medusas SQL prüfte die Listen-Regeln gar nicht (Kontextloch, siehe
  // Fake oben). Der Marker darf umgekehrt nie eine echte Regel erfüllen.
  for (const call of pricing.calculateCalls) {
    expect(Object.keys(call.context).sort()).toEqual([
      "currency_code",
      "customer.groups.id",
      "quantity",
    ])
    expect(call.context["customer.groups.id"]).toEqual(["__guest__"])
  }
})

test("Riegel: selbst wenn die Regelauswertung die Händlerliste durchliesse, reicht die Route sie nicht durch", async () => {
  const [rows, lists] = haendlerFixture()
  // Simuliert eine Auswertung, die Listen-Regeln ignoriert — der Gewinner
  // wäre dann der Händlerpreis. Die Route muss ihn am price_list_id-Riegel
  // erkennen und auf den regulären Preis (original_amount) zurückfallen.
  const pricing = makePricingService(rows, lists, { ignoreListRules: true })

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  expectNoHaendlerPreise(res.body)

  // Die Sprungstelle 50 stammt nur aus der Händlerliste — sie darf gar
  // nicht erst angefragt werden (eingeschränkte Zeilen liefern keine
  // Sprungstellen).
  const probed = pricing.calculateCalls.map((c) => c.quantity)
  expect(probed).not.toContain(50)
})

test("Entwurfs- und abgelaufene Preislisten zählen nicht", async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const pricing = makePricingService(
    [
      price(2.5, 1, null),
      price(0.5, 1, null, "pl_entwurf"),
      price(0.6, 1, null, "pl_abgelaufen"),
    ],
    [
      { id: "pl_entwurf", type: "sale", status: "draft" },
      {
        id: "pl_abgelaufen",
        type: "sale",
        status: "active",
        ends_at: yesterday,
      },
    ]
  )

  const res = await callRoute(pricing, LINKS, {
    variant_id: VARIANT,
    currency_code: "chf",
  })

  expect((res.body as { tiers: Record<string, unknown[]> }).tiers[VARIANT]).toEqual([
    { min_quantity: 1, max_quantity: null, amount: 2.5, original_amount: 2.5, currency_code: "chf" },
  ])
})

// ─── Reine Helfer ───────────────────────────────────────────────────

describe("collectQuantityBreakpoints", () => {
  test("sammelt min_quantity und max_quantity+1, dedupliziert, enthält immer 1", () => {
    expect(
      collectQuantityBreakpoints([
        { min_quantity: 1, max_quantity: 9 },
        { min_quantity: 10, max_quantity: 23 },
        { min_quantity: 24, max_quantity: null },
        { min_quantity: null, max_quantity: null },
      ])
    ).toEqual([1, 10, 24])
  })

  test("max_quantity ohne Nachfolger erzeugt eine Sprungstelle dahinter", () => {
    // Zeile endet bei 119 — bei 120 muss neu bewertet werden.
    expect(
      collectQuantityBreakpoints([{ min_quantity: 48, max_quantity: 119 }])
    ).toEqual([1, 48, 120])
  })

  test("kappt pathologisch viele Sprungstellen", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      min_quantity: i + 1,
      max_quantity: null,
    }))
    expect(collectQuantityBreakpoints(rows, 30)).toHaveLength(30)
  })
})

describe("tiersFromProbes", () => {
  test("verschmilzt gleiche Nachbarbeträge zu einer Stufe", () => {
    expect(
      tiersFromProbes(
        [
          { quantity: 1, amount: 1.95, original_amount: 1.95, currency_code: "chf" },
          { quantity: 10, amount: 1.95, original_amount: 1.95, currency_code: "chf" },
          { quantity: 24, amount: 1.4, original_amount: 1.4, currency_code: "chf" },
        ],
        "chf"
      )
    ).toEqual([
      { min_quantity: 1, max_quantity: 23, amount: 1.95, original_amount: 1.95, currency_code: "chf" },
      { min_quantity: 24, max_quantity: null, amount: 1.4, original_amount: 1.4, currency_code: "chf" },
    ])
  })

  test("eine Lücke ohne gültigen Preis schliesst die laufende Stufe", () => {
    expect(
      tiersFromProbes(
        [
          { quantity: 1, amount: 2.0, original_amount: 2.0, currency_code: "chf" },
          { quantity: 10, amount: null, currency_code: null },
          { quantity: 24, amount: 1.5, original_amount: 1.5, currency_code: "chf" },
        ],
        "chf"
      )
    ).toEqual([
      { min_quantity: 1, max_quantity: 9, amount: 2.0, original_amount: 2.0, currency_code: "chf" },
      { min_quantity: 24, max_quantity: null, amount: 1.5, original_amount: 1.5, currency_code: "chf" },
    ])
  })
})
