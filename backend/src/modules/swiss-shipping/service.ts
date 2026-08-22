/**
 * Swiss Shipping Fulfillment Provider
 *
 * Tarif (Stand 22.08.2026, deckungsgleich mit den AGB Ziffer 6):
 * - Ab CHF 69.00 Warenwert: gratis
 * - Kleinsendung im Briefformat: CHF 3.75
 * - Paket, z. B. eine ganze Box oder ein Display: CHF 9.00
 *
 * Einheiten: Medusa v2 speichert und übergibt Beträge als Dezimalzahlen
 * (CHF 9.00 === 9), nicht in Rappen. Optionen entsprechend setzen.
 *
 * ─── WIE BRIEF VON PAKET UNTERSCHIEDEN WIRD ───────────────────────────────
 *
 * Über das GEWICHT. Medusa reicht an `calculatePrice` unter anderem
 * `items.variant.weight` und `items.product.weight` durch (siehe
 * cartFieldsForCalculateShippingOptionsPrices), das ist die einzige
 * physikalische Grösse, die hier ankommt — Variant-Metadaten kommen NICHT an.
 *
 * Gewichte gelten in Gramm, so wie Medusa sie im Admin führt. Liegt das
 * Summengewicht unter `letterMaxWeight`, ist es eine Kleinsendung.
 *
 * WICHTIG — der Vorgabewert bei fehlendem Gewicht ist PAKET, nicht Brief:
 * Solange an den Varianten kein Gewicht gepflegt ist, kostet jede Sendung
 * CHF 9.00. Das ist Absicht. Ein zu tief angesetzter Versand kostet bei
 * jeder Bestellung bares Geld und fällt niemandem auf; ein zu hoch
 * angesetzter ist im Warenkorb sichtbar und wird gemeldet. Sobald die
 * Gewichte im Admin stehen, greift der Brieftarif von selbst.
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
  /** Dezimalbetrag — 3.75 = CHF 3.75 */
  letterPrice: number
  /** Dezimalbetrag — 9 = CHF 9.00 */
  parcelPrice: number
  /** Dezimalbetrag — 69 = CHF 69.00 */
  freeShippingThreshold: number
  /** Gramm. Bis und mit diesem Gewicht gilt der Brieftarif. */
  letterMaxWeight: number
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
   * Summengewicht in Gramm — oder `null`, wenn an KEINER Position ein
   * Gewicht hängt. `null` heisst «unbekannt», nicht «null Gramm»: nur so
   * lässt sich ein leerer Warenkorb von ungepflegten Stammdaten trennen.
   */
  private resolveCartWeight(context: Record<string, unknown>): number | null {
    const items = context?.["items"]
    if (!Array.isArray(items) || !items.length) {
      return null
    }

    let sum = 0
    let known = false

    for (const rawItem of items) {
      const item = (rawItem ?? {}) as Record<string, unknown>
      const variant = (item["variant"] ?? {}) as Record<string, unknown>
      const product = (item["product"] ?? {}) as Record<string, unknown>

      // Variante schlägt Produkt: die 50er-Box wiegt anderes als das
      // Einzelheft desselben Produkts.
      const raw = variant["weight"] ?? product["weight"]
      const weight = Number(raw)
      if (!Number.isFinite(weight) || weight <= 0) {
        continue
      }

      const rawQuantity = Number(item["quantity"])
      const quantity =
        Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1

      sum += weight * quantity
      known = true
    }

    return known ? sum : null
  }

  /**
   * Versandkosten berechnen.
   * Gratis ab der Schwelle, sonst Brief- oder Pakettarif nach Gewicht.
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

    const weight = this.resolveCartWeight(ctx)

    if (weight === null) {
      this.logger_.warn(
        `No variant weight on any cart line — falling back to the parcel ` +
          `rate (CHF ${this.options_.parcelPrice.toFixed(2)}). Maintain ` +
          `weights in grams to unlock the letter rate.`
      )
      return {
        calculated_amount: this.options_.parcelPrice,
        is_calculated_price_tax_inclusive: true,
      }
    }

    const isLetter = weight <= this.options_.letterMaxWeight

    return {
      calculated_amount: isLetter
        ? this.options_.letterPrice
        : this.options_.parcelPrice,
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
        price: this.options_.parcelPrice,
        currency: "CHF",
        description:
          `Brief CHF ${this.options_.letterPrice.toFixed(2)}, ` +
          `Paket CHF ${this.options_.parcelPrice.toFixed(2)} — ` +
          `ab CHF ${this.options_.freeShippingThreshold.toFixed(2)} gratis`,
      },
      {
        id: "swiss-standard-return",
        name: "Rücksendung Schweiz",
        is_return: true,
        price: this.options_.parcelPrice,
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
