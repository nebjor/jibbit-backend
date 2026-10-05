/**
 * Swiss Shipping Fulfillment Provider
 *
 * Ein Versandpreis für jede Bestellung (AGB Ziffer 6), gratis ab
 * `freeShippingThreshold` Warenwert. Beträge als Dezimalzahlen
 * (CHF 4.50 === 4.5), nicht in Rappen.
 *
 * Passt eine Bestellung in einen Brief, entscheidet das Team beim Packen und
 * schreibt der Kundin die Differenz als Gutscheincode gut (Medusa-Promotion
 * im Admin) — der Checkout kennt nur diesen einen Preis.
 *
 * Dazu die Abholung im Laden: eine zweite Shipping Option desselben
 * Providers, `flat` mit Preis 0 und `data.pickup = true` (siehe
 * src/lib/pickup.ts). `calculatePrice` wird für sie nie gefragt; der Provider
 * stempelt ihr beim Hinzufügen zum Warenkorb nur den Marker in die
 * Versandmethode, damit Bestellung und Mails sie ohne Namensvergleich erkennen.
 */

import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"
import { PICKUP_FULFILLMENT_OPTION_ID, isPickupShippingOption } from "../../lib/pickup"
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
  /** Dezimalbetrag — 4.5 = CHF 4.50 */
  price: number
  /** Dezimalbetrag — 69 = CHF 69.00 */
  freeShippingThreshold: number
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
   * genau die Grösse, gegen die die Gratis-Schwelle laufen soll.
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
   * Versandkosten berechnen: gratis ab der Schwelle, sonst der Versandpreis.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const ctx = context as unknown as Record<string, unknown>
    const cartTotal = this.resolveCartTotal(ctx)

    if (cartTotal >= this.options_.freeShippingThreshold) {
      this.logger_.info(
        `Free shipping applied: cart total ${cartTotal} >= threshold ${this.options_.freeShippingThreshold}`
      )
      return {
        calculated_amount: 0,
        is_calculated_price_tax_inclusive: true,
      }
    }

    return {
      calculated_amount: this.options_.price,
      is_calculated_price_tax_inclusive: true,
    }
  }

  /**
   * Was auf der Versandmethode des Warenkorbs als `data` landet (und von dort
   * auf die Bestellung kopiert wird). `optionData` ist das `data` der Shipping
   * Option. Ist die Option die Abholung, trägt die Methode `pickup: true` —
   * egal, was die Storefront mitgeschickt hat. Alles andere geht unverändert
   * durch.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext
  ): Promise<any> {
    const method: Record<string, unknown> = { ...(data ?? {}) }
    if (isPickupShippingOption({ data: optionData })) {
      method["pickup"] = true
    }
    return method
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
        price: this.options_.price,
        currency: "CHF",
        description:
          `CHF ${this.options_.price.toFixed(2)} — ` +
          `ab CHF ${this.options_.freeShippingThreshold.toFixed(2)} gratis`,
      },
      {
        // Abholung im Laden: gratis, keine Post. Die Shipping Option dazu
        // trägt `data: { id: "swiss-pickup", pickup: true, address }`
        // (Seed und Admin), siehe src/lib/pickup.ts.
        id: PICKUP_FULFILLMENT_OPTION_ID,
        name: "Abholung im Laden",
        pickup: true,
        price: 0,
        currency: "CHF",
        description: "Unterwegli 1, 8404 Winterthur — gratis",
      },
      {
        id: "swiss-standard-return",
        name: "Rücksendung Schweiz",
        is_return: true,
        price: this.options_.price,
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
