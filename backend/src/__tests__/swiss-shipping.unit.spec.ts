/**
 * Tests für den Swiss Shipping Provider: ein Versandpreis, gratis ab der
 * Schwelle. Medusa liefert an calculatePrice KEIN `item_total` — der
 * Warenwert wird aus `context.items` aufsummiert.
 */

import SwissShippingProviderService from "../modules/swiss-shipping/service"

const loggerStub = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any

const OPTIONS = {
  price: 4.5,
  freeShippingThreshold: 69,
}

function makeService() {
  return new SwissShippingProviderService({ logger: loggerStub }, OPTIONS)
}

const price = async (context: Record<string, unknown>): Promise<number> => {
  const result = await makeService().calculatePrice(
    {} as any,
    {} as any,
    context as any
  )
  return result.calculated_amount
}

const line = (total: number, quantity = 1) => ({ total, quantity })

describe("Gratis-Schwelle", () => {
  it("ist ab genau CHF 69.00 gratis", async () => {
    await expect(price({ item_total: 69 })).resolves.toBe(0)
    await expect(price({ item_total: 69.01 })).resolves.toBe(0)
    await expect(price({ item_total: 500 })).resolves.toBe(0)
  })

  it("gilt unter CHF 69.00 noch nicht", async () => {
    await expect(price({ items: [line(68.99)] })).resolves.toBe(4.5)
  })
})

describe("Versandpreis", () => {
  it("ist für jede Bestellung unter der Schwelle derselbe", async () => {
    await expect(price({ items: [line(2.5)] })).resolves.toBe(4.5)
    await expect(price({ items: [line(38, 3)] })).resolves.toBe(4.5)
  })

  it("gilt auch für einen leeren Warenkorb", async () => {
    await expect(price({ items: [] })).resolves.toBe(4.5)
    await expect(price({})).resolves.toBe(4.5)
  })
})

describe("Warenwert aus den Positionen", () => {
  it("summiert die Positionstotale", async () => {
    await expect(price({ items: [line(40), line(30)] })).resolves.toBe(0)
    await expect(price({ items: [line(30), line(30)] })).resolves.toBe(4.5)
  })

  it("fällt auf unit_price × quantity zurück", async () => {
    await expect(
      price({ items: [{ unit_price: 2.5, quantity: 2 }] })
    ).resolves.toBe(4.5)
    await expect(
      price({ items: [{ unit_price: 40, quantity: 2 }] })
    ).resolves.toBe(0)
  })
})

it("meldet Preise als Endpreise (tax-inclusive)", async () => {
  const result = await makeService().calculatePrice(
    {} as any,
    {} as any,
    { item_total: 20 } as any
  )
  expect(result.is_calculated_price_tax_inclusive).toBe(true)
})

describe("SwissShippingProviderService.getFulfillmentOptions", () => {
  it("beschriftet die Preise in Franken, nicht in Rappen", async () => {
    const [standard] = await makeService().getFulfillmentOptions()
    expect(standard.description).toBe("CHF 4.50 — ab CHF 69.00 gratis")
  })
})
