/**
 * Tests für den Swiss Shipping Provider.
 *
 * Vorher testete diese Datei eine lokal nachgebaute Kopie der Logik in
 * RAPPEN (900 / 10000) und rührte den echten Service nie an. Medusa v2
 * rechnet aber in DEZIMALBETRÄGEN (CHF 9.00 === 9) — der Test hätte die
 * Einheiten-Umstellung nicht bemerkt.
 *
 * Jetzt wird SwissShippingProviderService.calculatePrice() direkt geprüft,
 * inklusive des Pfads, der den Warenwert aus `context.items` aufsummiert
 * (Medusa liefert an calculatePrice KEIN `item_total`).
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
  fixedPrice: 9,
  freeShippingThreshold: 100,
}

function makeService() {
  return new SwissShippingProviderService(
    { logger: loggerStub },
    OPTIONS
  )
}

const price = async (context: Record<string, unknown>): Promise<number> => {
  const service = makeService()
  const result = await service.calculatePrice({} as any, {} as any, context as any)
  return result.calculated_amount
}

describe("SwissShippingProviderService.calculatePrice", () => {
  describe("mit aggregiertem Warenwert (item_total)", () => {
    it("berechnet CHF 9.00 unter der Schwelle", async () => {
      await expect(price({ item_total: 0 })).resolves.toBe(9)
      await expect(price({ item_total: 50 })).resolves.toBe(9)
      await expect(price({ item_total: 99.99 })).resolves.toBe(9)
    })

    it("ist bei genau CHF 100.00 gratis", async () => {
      await expect(price({ item_total: 100 })).resolves.toBe(0)
    })

    it("ist über CHF 100.00 gratis", async () => {
      await expect(price({ item_total: 100.01 })).resolves.toBe(0)
      await expect(price({ item_total: 500 })).resolves.toBe(0)
    })
  })

  describe("mit Positionen (der reale Aufrufpfad)", () => {
    // Medusa reicht an calculatePrice nur `items.*` und `shipping_address.*`
    // durch — siehe cartFieldsForCalculateShippingOptionsPrices.
    it("summiert die Positionstotale", async () => {
      await expect(
        price({ items: [{ total: 40 }, { total: 30 }] })
      ).resolves.toBe(9)

      await expect(
        price({ items: [{ total: 60 }, { total: 45 }] })
      ).resolves.toBe(0)
    })

    it("fällt auf unit_price × quantity zurück", async () => {
      await expect(
        price({ items: [{ unit_price: 2.5, quantity: 2 }] })
      ).resolves.toBe(9)

      await expect(
        price({ items: [{ unit_price: 99, quantity: 2 }] })
      ).resolves.toBe(0)
    })

    it("behandelt einen leeren Warenkorb als CHF 0.00 Warenwert", async () => {
      await expect(price({ items: [] })).resolves.toBe(9)
      await expect(price({})).resolves.toBe(9)
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
})

describe("SwissShippingProviderService.getFulfillmentOptions", () => {
  it("beschriftet die Preise in Franken, nicht in Rappen", async () => {
    const service = makeService()
    const [standard] = await service.getFulfillmentOptions()

    // Regression: die Beschreibung teilte vorher durch 100 und zeigte
    // "CHF 0.09 — ab CHF 1.00 gratis".
    expect(standard.description).toContain("CHF 9.00")
    expect(standard.description).toContain("CHF 100.00")
  })
})
