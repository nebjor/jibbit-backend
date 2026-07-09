/**
 * Swiss Shipping Fulfillment Provider
 *
 * Logik:
 * - Fixpreis: CHF 9.00 (900 Rappen)
 * - Ab CHF 100.00 (10000 Rappen) Warenwert: CHF 0.00
 */

import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"

export interface SwissShippingOptions {
  fixedPrice: number // in cents (900 = CHF 9.00)
  freeShippingThreshold: number // in cents (10000 = CHF 100.00)
}

type InjectedDependencies = {
  logger: Logger
}

class SwissShippingProviderService extends AbstractFulfillmentProviderService {
  static identifier = "swiss-shipping"

  protected logger_: Logger
  protected options_: SwissShippingOptions

  constructor(container: InjectedDependencies, options: SwissShippingOptions) {
    super()
    this.logger_ = container.logger
    this.options_ = options
  }

  /**
   * Versandkosten berechnen.
   * Fixpreis 9.00 CHF, ab 100.00 CHF Warenwert: Gratisversand.
   */
  async calculatePrice(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<number> {
    const cartTotal = (context.cart_total as number) || 0

    if (cartTotal >= this.options_.freeShippingThreshold) {
      this.logger_.info(
        `Free shipping applied: cart total ${cartTotal} >= threshold ${this.options_.freeShippingThreshold}`
      )
      return 0
    }

    return this.options_.fixedPrice
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return data
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  async canCalculate(data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Record<string, unknown>[],
    order: Record<string, unknown>,
    fulfillment: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return {
      ...data,
      created_at: new Date().toISOString(),
    }
  }

  async cancelFulfillment(fulfillment: Record<string, unknown>): Promise<Record<string, unknown>> {
    return fulfillment
  }

  async getFulfillmentOptions(): Promise<Record<string, unknown>[]> {
    return [
      {
        id: "swiss-standard",
        name: "Standardversand Schweiz",
        price: this.options_.fixedPrice,
        currency: "CHF",
        description: `CHF ${(this.options_.fixedPrice / 100).toFixed(2)} — Ab CHF ${(this.options_.freeShippingThreshold / 100).toFixed(2)} gratis`,
      },
    ]
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return fulfillment
  }
}

export default SwissShippingProviderService
