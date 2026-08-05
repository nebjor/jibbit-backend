/**
 * Swiss Shipping Fulfillment Provider
 *
 * Logik:
 * - Fixpreis: CHF 9.00
 * - Ab CHF 100.00 Warenwert: CHF 0.00
 *
 * Einheiten: Medusa v2 speichert und übergibt Beträge als Dezimalzahlen
 * (CHF 9.00 === 9), nicht in Rappen. Optionen entsprechend setzen.
 *
 * Hinweis zur Preislogik: Der Seed legt zusätzlich zwei *flat* Shipping
 * Options mit `item_total`-Rules an (CHF 9 unter 100, CHF 0 ab 100). Das ist
 * der deterministische Pfad. `calculatePrice()` greift nur, wenn eine Option
 * mit `price_type: "calculated"` angelegt wird.
 */

import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"

export interface SwissShippingOptions {
  fixedPrice: number // Dezimalbetrag (9 = CHF 9.00)
  freeShippingThreshold: number // Dezimalbetrag (100 = CHF 100.00)
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
   * Warenwert aus dem Preis-Kontext ermitteln.
   *
   * ACHTUNG: Medusa reicht an `calculatePrice` NICHT den vollen Cart durch.
   * Die Feldliste ist `cartFieldsForCalculateShippingOptionsPrices`
   * (@medusajs/core-flows/dist/cart/utils/fields.js) und enthält
   * `items.*` und `shipping_address.*` — aber KEIN `item_total`.
   *
   * Deshalb: zuerst die Aggregat-Felder versuchen (falls ein anderer
   * Aufrufpfad sie doch liefert), sonst über die Positionen summieren.
   *
   * Da die Preise tax-inclusive gepflegt sind (price_preference
   * currency_code=chf), ist `unit_price * quantity` bereits der Bruttowert —
   * genau die Grösse, gegen die die CHF-100-Schwelle laufen soll.
   */
  private resolveCartTotal(context: Record<string, unknown>): number {
    const aggregates = [
      context?.["item_total"],
      context?.["subtotal"],
      context?.["cart_total"],
      context?.["total"],
    ]

    for (const candidate of aggregates) {
      const value = Number(candidate)
      if (Number.isFinite(value) && value > 0) {
        return value
      }
    }

    const items = context?.["items"]
    if (Array.isArray(items)) {
      let sum = 0
      for (const rawItem of items) {
        const item = (rawItem ?? {}) as Record<string, unknown>

        // Bevorzugt die von Medusa berechneten Positionstotale, sonst
        // Einzelpreis × Menge.
        const lineTotal = Number(item["total"] ?? item["subtotal"])
        if (Number.isFinite(lineTotal)) {
          sum += lineTotal
          continue
        }

        const unitPrice = Number(item["unit_price"])
        const quantity = Number(item["quantity"])
        if (Number.isFinite(unitPrice) && Number.isFinite(quantity)) {
          sum += unitPrice * quantity
        }
      }
      return sum
    }

    return 0
  }

  /**
   * Versandkosten berechnen.
   * Fixpreis 9.00 CHF, ab 100.00 CHF Warenwert: Gratisversand.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const cartTotal = this.resolveCartTotal(
      context as unknown as Record<string, unknown>
    )

    if (cartTotal >= this.options_.freeShippingThreshold) {
      this.logger_.info(
        `Free shipping applied: cart total ${cartTotal} >= threshold ${this.options_.freeShippingThreshold}`
      )
      return {
        calculated_amount: 0,
        // CH: Preise werden inkl. MwSt. kommuniziert.
        is_calculated_price_tax_inclusive: true,
      }
    }

    return {
      calculated_amount: this.options_.fixedPrice,
      is_calculated_price_tax_inclusive: true,
    }
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext
  ): Promise<any> {
    return data
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  async canCalculate(data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...data,
        created_at: new Date().toISOString(),
      },
      // Keine Label-Integration (kein Post-/DHL-Account angebunden).
      labels: [],
    }
  }

  async cancelFulfillment(fulfillment: Record<string, unknown>): Promise<any> {
    return fulfillment
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: "swiss-standard",
        name: "Standardversand Schweiz",
        // Dezimalbetrag — CHF 9.00 === 9
        price: this.options_.fixedPrice,
        currency: "CHF",
        description: `CHF ${this.options_.fixedPrice.toFixed(2)} — ab CHF ${this.options_.freeShippingThreshold.toFixed(2)} gratis`,
      },
      {
        id: "swiss-standard-return",
        name: "Rücksendung Schweiz",
        is_return: true,
        price: this.options_.fixedPrice,
        currency: "CHF",
      },
    ]
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: fulfillment,
      labels: [],
    }
  }
}

export default SwissShippingProviderService
