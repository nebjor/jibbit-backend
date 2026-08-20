/**
 * Betragsumrechnung Medusa <-> Payrexx.
 *
 * ─── In welcher Einheit erwartet Payrexx Beträge? ──────────────────────────
 *
 * Payrexx' REST API nimmt `amount` IMMER in der kleinsten Währungseinheit
 * entgegen — für CHF also RAPPEN, als GANZE ZAHL. CHF 42.00 ist `4200`,
 * nicht `42`. Dasselbe gilt in der Gegenrichtung: jeder Betrag, den ein
 * Payrexx-Webhook oder eine Transaktion meldet (`transaction.amount`), ist
 * ebenfalls in Rappen.
 *   Quelle: https://developers.payrexx.com/reference/create-a-gateway
 *   ("amount — The amount of the payment in cents.")
 *
 * Medusa v2 arbeitet dagegen durchgehend in DEZIMALBETRÄGEN: ein Cart-Total
 * von CHF 42.00 ist die Zahl `42`, nicht `4200`. Das gilt für
 * `InitiatePaymentInput.amount`, `RefundPaymentInput.amount` und für den
 * `amount`, den `WebhookActionResult.data` zurückgeben muss.
 *
 * Der Umrechnungsfaktor ist also 100, und er wird in BEIDEN Richtungen
 * gebraucht. Ein Fehler hier ist kein kosmetischer Bug: Faktor 100 zu viel
 * belastet den Kunden mit dem Hundertfachen, Faktor 100 zu wenig verschenkt
 * 99 % des Umsatzes. Deshalb geht JEDE Umrechnung in diesem Modul über
 * `toRappen()` / `fromRappen()` und nirgends über ein inline `* 100`.
 *
 * ─── MwSt. ────────────────────────────────────────────────────────────────
 *
 * Die Preise im Shop sind inklusive MwSt. (`is_tax_inclusive = true`, gesetzt
 * per price_preference auf currency_code=chf, siehe src/scripts/seed.ts).
 * Der Betrag, den Medusa der Payment Session gibt, ist also bereits der
 * BRUTTO-Betrag. Hier darf keine MwSt. mehr addiert oder abgezogen werden —
 * was Payrexx belastet, ist exakt das, was der Kunde im Warenkorb sieht.
 *
 * ─── 5-Rappen-Rundung ─────────────────────────────────────────────────────
 *
 * Die schweizerische 5-Rappen-Rundung ist eine BARGELD-Konvention. Für
 * elektronische Zahlungen (TWINT, Karte, Rechnung) ist jeder Rappen-Betrag
 * zulässig; Payrexx lehnt 1997 nicht ab. Wir runden hier deshalb NICHT auf
 * 5 Rappen — täten wir es, wiche der belastete Betrag vom Bestellbetrag in
 * Medusa ab, und genau diese Differenz würde der Betrags-Abgleich im
 * Webhook (siehe webhook.ts) als Manipulationsverdacht werten.
 */

import { BigNumber } from "@medusajs/framework/utils"
import type { BigNumberInput } from "@medusajs/framework/types"

/** CHF hat zwei Nachkommastellen: 1 CHF = 100 Rappen. */
export const RAPPEN_PER_CHF = 100

/**
 * Dezimalbetrag (Medusa) → Rappen (Payrexx), als ganze Zahl.
 *
 * `amount` ist ein `BigNumberInput` und kann zur Laufzeit vier verschiedene
 * Gestalten haben: `number`, `string`, eine `BigNumber`-Instanz oder ein
 * rohes `{ value: "42.00", precision: 20 }`. Ein blankes `Number(amount)`
 * ergibt für die letzte Variante `NaN` — und `Math.round(NaN)` ist `NaN`,
 * das dann als Betrag an Payrexx ginge. Deshalb IMMER über `new BigNumber()`
 * normalisieren; der Konstruktor kennt alle vier Formen und wirft bei allem
 * anderen.
 */
export function toRappen(amount: BigNumberInput): number {
  let numeric: number

  try {
    numeric = new BigNumber(amount).numeric
  } catch (err) {
    throw new Error(
      `Payrexx: cannot convert amount to Rappen — unsupported value (${String(err)}).`
    )
  }

  if (!Number.isFinite(numeric)) {
    throw new Error(`Payrexx: cannot convert non-finite amount to Rappen.`)
  }

  // Math.round fängt den Binär-Fliesskomma-Rest ab, den `19.99 * 100`
  // produziert (1998.9999999999998). Für Beträge in der Grössenordnung
  // eines Warenkorbs ist das exakt; erst jenseits von ~2^53 Rappen
  // (≈ 90 Billionen CHF) würde die Genauigkeit von double zum Thema.
  return Math.round(numeric * RAPPEN_PER_CHF)
}

/**
 * Rappen (Payrexx) → Dezimalbetrag (Medusa).
 *
 * `toFixed(2)` + `Number()` statt einer blanken Division, damit das Ergebnis
 * garantiert auf zwei Nachkommastellen normalisiert ist und nicht als
 * 19.990000000000002 in eine Medusa-BigNumber wandert.
 */
export function fromRappen(rappen: number): number {
  if (!Number.isFinite(rappen)) {
    throw new Error(`Payrexx: cannot convert non-finite Rappen amount.`)
  }
  return Number((rappen / RAPPEN_PER_CHF).toFixed(2))
}

/**
 * Plausibilitätsprüfung für einen Rappen-Betrag: ganzzahlig, endlich, > 0.
 * Ein Betrag <= 0 ist für eine Bestellung nie legitim, ein nicht-ganzzahliger
 * Rappen-Betrag ist ein Zeichen dafür, dass jemand versehentlich einen
 * Dezimalbetrag durchgereicht hat (CHF 42.00 als `42` statt `4200`).
 */
export function isPlausibleRappenAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  )
}
