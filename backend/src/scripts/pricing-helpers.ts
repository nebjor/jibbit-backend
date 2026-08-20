/**
 * Preis-Hilfsfunktionen, bewusst OHNE @medusajs-Importe.
 *
 * Sie steckten ursprünglich in import-price-tiers.ts. Das Modul zieht aber
 * beim Laden @medusajs/medusa/core-flows mit — und die Unit-Tests (und
 * price-list-mapping.ts) brauchen nur diese zwei reinen Funktionen. Nach der
 * Konvention von odoo-customer-mapping.ts liegt die testbare Logik deshalb
 * hier; import-price-tiers.ts re-exportiert sie unverändert.
 */

export type PriceInput = {
  amount: number
  currency_code: string
  min_quantity?: number | null
  max_quantity?: number | null
}

/**
 * Schweizer Preisoptik: alles auf 5 Rappen. Der kleinste Münzwert ist
 * CHF 0.05, Preise dazwischen wirken hier fremd.
 */
export const ROUND_DEFAULT = 0.05

/**
 * Auf `step` runden — und danach auf 2 Nachkommastellen festklopfen.
 * Ohne das zweite Runden liefert die Binärarithmetik Werte wie
 * 1.2000000000000002 (Math.round(1.175 / 0.05) * 0.05), und genau die
 * landen dann als Preis in der Datenbank.
 */
export function roundTo(value: number, step: number): number {
  if (step <= 0) {
    return Number(value.toFixed(2))
  }
  return Number((Math.round(value / step) * step).toFixed(2))
}

/**
 * Nach dem Runden auf 5 Rappen können zwei benachbarte Staffeln auf demselben
 * Preis landen (1.12 und 1.08 werden beide zu 1.10). In der Preistabelle stünde
 * dann zweimal derselbe Betrag — es sähe aus, als lohne sich die grössere Menge
 * nicht. Solche Stufen werden zu einer zusammengefasst.
 *
 * Die Staffeln sind hier bereits validiert, also lückenlos und aufsteigend
 * sortiert — das Verschmelzen erhält beides.
 */
export function collapseEqual(prices: PriceInput[]): PriceInput[] {
  const out: PriceInput[] = []
  for (const price of prices) {
    const last = out[out.length - 1]
    if (last && last.amount === price.amount) {
      last.max_quantity = price.max_quantity
      continue
    }
    out.push({ ...price })
  }
  return out
}

/**
 * Zwei Preiszeilen-Mengen vergleichen, unabhängig von der Reihenfolge.
 *
 * Damit entscheidet der Preislisten-Import, ob überhaupt geschrieben werden
 * muss — der zweite Lauf ohne Datenänderung ist dann ein reiner Lesevorgang
 * (Idempotenz).
 */
export function samePriceRows(a: PriceInput[], b: PriceInput[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const key = (p: PriceInput) =>
    [
      p.currency_code.toLowerCase(),
      Number(p.amount),
      p.min_quantity ?? 1,
      p.max_quantity ?? "",
    ].join("|")
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  return sa.every((k, i) => k === sb[i])
}
