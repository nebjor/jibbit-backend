/**
 * Tests für den Swiss Shipping Provider.
 *
 * Medusa v2 rechnet in DEZIMALBETRÄGEN (CHF 9.00 === 9), nicht in Rappen.
 * Geprüft wird SwissShippingProviderService.calculatePrice() direkt,
 * inklusive des Pfads, der den Warenwert aus `context.items` aufsummiert
 * (Medusa liefert an calculatePrice KEIN `item_total`).
 *
 * Tarif seit 22.08.2026 dreistufig: gratis ab CHF 69.00, sonst Brief
 * CHF 3.75 oder Paket CHF 9.00 je nach Gewicht.
 */

import SwissShippingProviderService from "../modules/swiss-shipping/service"

const loggerStub = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any

const OPTIONS = {
  // Dezimalbeträge, wie in medusa-config.ts
  letterPrice: 3.75,
  parcelPrice: 9,
  freeShippingThreshold: 69,
  letterMaxWeight: 1000, // Gramm
}

function makeService() {
  return new SwissShippingProviderService({ logger: loggerStub }, OPTIONS)
}

const price = async (context: Record<string, unknown>): Promise<number> => {
  const service = makeService()
  const result = await service.calculatePrice({} as any, {} as any, context as any)
  return result.calculated_amount
}

/** Eine Position mit Gewicht in Gramm an der Variante. */
const line = (total: number, weight?: number, quantity = 1) => ({
  total,
  quantity,
  ...(weight === undefined ? {} : { variant: { weight } }),
})

describe("Gratis-Schwelle", () => {
  it("ist ab genau CHF 69.00 gratis", async () => {
    await expect(price({ item_total: 69 })).resolves.toBe(0)
    await expect(price({ item_total: 69.01 })).resolves.toBe(0)
    await expect(price({ item_total: 500 })).resolves.toBe(0)
  })

  it("greift auch, wenn die Ware schwer ist", async () => {
    // Gewicht darf die Gratis-Schwelle nicht aushebeln.
    await expect(price({ items: [line(70, 5000)] })).resolves.toBe(0)
  })

  it("gilt unter CHF 69.00 noch nicht", async () => {
    await expect(price({ items: [line(68.99, 100)] })).resolves.toBe(3.75)
  })
})

describe("Brief gegen Paket nach Gewicht", () => {
  it("berechnet den Brieftarif bis und mit 1000 g", async () => {
    await expect(price({ items: [line(10, 20)] })).resolves.toBe(3.75)
    await expect(price({ items: [line(10, 1000)] })).resolves.toBe(3.75)
  })

  it("berechnet den Pakettarif über 1000 g", async () => {
    await expect(price({ items: [line(10, 1001)] })).resolves.toBe(9)
    await expect(price({ items: [line(38, 2400)] })).resolves.toBe(9)
  })

  it("multipliziert das Gewicht mit der Menge", async () => {
    // 6 × 200 g = 1200 g → Paket, obwohl jede Einzelposition leicht ist.
    await expect(price({ items: [line(30, 200, 6)] })).resolves.toBe(9)
    await expect(price({ items: [line(25, 200, 5)] })).resolves.toBe(3.75)
  })

  it("summiert über mehrere Positionen", async () => {
    await expect(
      price({ items: [line(10, 400), line(10, 400)] })
    ).resolves.toBe(3.75)

    await expect(
      price({ items: [line(10, 600), line(10, 600)] })
    ).resolves.toBe(9)
  })

  it("nimmt das Produktgewicht, wenn die Variante keins hat", async () => {
    await expect(
      price({ items: [{ total: 10, quantity: 1, product: { weight: 1500 } }] })
    ).resolves.toBe(9)
  })

  it("bevorzugt das Variantengewicht vor dem Produktgewicht", async () => {
    await expect(
      price({
        items: [
          {
            total: 10,
            quantity: 1,
            variant: { weight: 50 },
            product: { weight: 5000 },
          },
        ],
      })
    ).resolves.toBe(3.75)
  })
})

describe("Ohne gepflegte Gewichte", () => {
  // Bewusst der teurere Tarif: zu tief angesetzter Versand kostet bei jeder
  // Bestellung Geld und fällt nicht auf.
  it("fällt auf den Pakettarif zurück", async () => {
    await expect(price({ items: [line(10)] })).resolves.toBe(9)
    await expect(price({ items: [{ unit_price: 2.5, quantity: 2 }] })).resolves.toBe(9)
  })

  it("behandelt einen leeren Warenkorb als Paket", async () => {
    await expect(price({ items: [] })).resolves.toBe(9)
    await expect(price({})).resolves.toBe(9)
  })

  it("ignoriert unbrauchbare Gewichtsangaben", async () => {
    await expect(price({ items: [line(10, 0)] })).resolves.toBe(9)
    await expect(
      price({ items: [{ total: 10, quantity: 1, variant: { weight: "leicht" } }] })
    ).resolves.toBe(9)
  })

  it("wertet die gepflegten Positionen aus und ignoriert die leeren", async () => {
    // Eine Position ohne Gewicht macht die Sendung nicht unbekannt.
    await expect(
      price({ items: [line(10, 300), line(10)] })
    ).resolves.toBe(3.75)
  })
})

describe("Warenwert aus den Positionen", () => {
  it("summiert die Positionstotale", async () => {
    await expect(price({ items: [line(40, 10), line(30, 10)] })).resolves.toBe(0)
    await expect(price({ items: [line(30, 10), line(30, 10)] })).resolves.toBe(3.75)
  })

  it("fällt auf unit_price × quantity zurück", async () => {
    await expect(
      price({ items: [{ unit_price: 2.5, quantity: 2, variant: { weight: 20 } }] })
    ).resolves.toBe(3.75)

    await expect(
      price({ items: [{ unit_price: 40, quantity: 2, variant: { weight: 20 } }] })
    ).resolves.toBe(0)
  })
})

it("meldet Preise als MwSt.-inklusive (CH-Detailhandel)", async () => {
  const service = makeService()
  const result = await service.calculatePrice(
    {} as any,
    {} as any,
    { item_total: 20 } as any
  )
  expect(result.is_calculated_price_tax_inclusive).toBe(true)
})

describe("SwissShippingProviderService.getFulfillmentOptions", () => {
  it("beschriftet die Preise in Franken, nicht in Rappen", async () => {
    const service = makeService()
    const [standard] = await service.getFulfillmentOptions()

    // Regression: die Beschreibung teilte vorher durch 100 und zeigte
    // "CHF 0.09 — ab CHF 1.00 gratis".
    expect(standard.description).toContain("CHF 3.75")
    expect(standard.description).toContain("CHF 9.00")
    expect(standard.description).toContain("CHF 69.00")
  })
})
