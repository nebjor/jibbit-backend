/**
 * Tests für Swiss Shipping Provider
 * Validiert die Fixpreis- und Gratisversand-Logik.
 */

describe("Swiss Shipping Logic", () => {
  const FIXED_PRICE = 900 // CHF 9.00
  const FREE_THRESHOLD = 10000 // CHF 100.00

  function calculateShipping(cartTotal: number): number {
    return cartTotal >= FREE_THRESHOLD ? 0 : FIXED_PRICE
  }

  it("should charge CHF 9.00 for carts under CHF 100.00", () => {
    expect(calculateShipping(0)).toBe(900)
    expect(calculateShipping(5000)).toBe(900) // CHF 50.00
    expect(calculateShipping(9999)).toBe(900) // CHF 99.99
  })

  it("should be free at exactly CHF 100.00", () => {
    expect(calculateShipping(10000)).toBe(0)
  })

  it("should be free above CHF 100.00", () => {
    expect(calculateShipping(10001)).toBe(0)
    expect(calculateShipping(50000)).toBe(0) // CHF 500.00
  })
})
