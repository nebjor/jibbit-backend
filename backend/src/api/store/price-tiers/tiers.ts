/**
 * Reine Rechenlogik der /store/price-tiers-Route — bewusst ohne jede
 * Medusa-Abhängigkeit, damit sie sich in Unit-Tests isoliert prüfen lässt.
 *
 * Grundidee: Wir zählen NICHT selbst nach, welche Preiszeile für einen Gast
 * gilt (Preislisten-Status, Datumsfenster, Kundengruppen-Regeln …) — diese
 * Auswertung hat Medusa bereits, und der Warenkorb rechnet mit ihr
 * (`calculatePrices`). Die Route fragt deshalb für jede Mengen-Sprungstelle
 * den berechneten Preis ab und setzt daraus die Staffeltabelle zusammen.
 * Die Anzeige kann so nie von der Abrechnung abweichen.
 *
 * Die Sprungstellen stammen aus den rohen Preiszeilen (`listPrices`),
 * einschliesslich der Zeilen aus Preislisten, die für den Gast gar nicht
 * gelten. Das ist unbedenklich: Eine Sprungstelle ist nur eine MENGE, zu der
 * wir Medusa nach dem gültigen Preis fragen. Liefert eine eingeschränkte
 * Liste (z.B. Händlerpreise je Kundengruppe) die Sprungstelle 50, dann ist
 * der berechnete Gast-Preis bei 50 derselbe wie davor — und
 * `tiersFromProbes` verschmilzt gleiche Nachbarn, sodass von der Liste
 * nichts übrig bleibt. Beträge aus den Rohzeilen werden nie übernommen.
 */

export type QuantityRow = {
  min_quantity?: number | string | null
  max_quantity?: number | string | null
}

/** Ein bewerteter Punkt: „Was kostet die Variante bei Menge q?" */
export type Probe = {
  quantity: number
  amount: number | null
  currency_code: string | null
}

export type Tier = {
  min_quantity: number
  max_quantity: number | null
  amount: number
  currency_code: string
}

/**
 * Obergrenze der Preisabfragen pro Request. Jede Sprungstelle kostet eine
 * `calculatePrices`-Abfrage (über alle Varianten des Requests gebündelt);
 * reale Kataloge liegen bei einer Handvoll Stufen. Die Kappung schützt nur
 * gegen pathologische Daten — dann fehlen die hintersten Stufen, statt dass
 * die Route zum Denial-of-Service-Vektor wird.
 */
export const MAX_PROBES = 30

/**
 * Preislisten, die für DIESEN anonymen Request niemals legitim gewinnen
 * können: Sie tragen mindestens eine Regel, deren Attribut der Request gar
 * nicht sendet (allen voran `customer.groups.id` — Händlerpreise).
 *
 * Im Normalfall filtert Medusas `calculatePrices` solche Listen selbst.
 * Dieser Riegel existiert, weil die SQL-Auswertung Preislisten-Regeln NUR
 * dann prüft, wenn der Kontext nach Abzug von `quantity` und `currency_code`
 * noch Attribute enthält (siehe @medusajs/pricing,
 * repositories/pricing.js: der `hasComplexContext=false`-Zweig lässt jede
 * Zeile mit `price.rules_count = 0` durch — auch aus regelbehafteten
 * Listen). Die Route stopft das Loch primär über den Gast-Marker im
 * Kontext; sollte je doch ein Gewinner aus einer solchen Liste kommen,
 * wird er über diese Menge verworfen. Lieber den regulären Preis anzeigen
 * als Händlerpreise an jeden Besucher ausliefern.
 */
export function restrictedPriceListIds(
  priceLists: { id: string; price_list_rules?: { attribute: string }[] | null }[],
  sentAttributes: string[]
): Set<string> {
  const sent = new Set(sentAttributes)
  const restricted = new Set<string>()
  for (const pl of priceLists) {
    const rules = pl.price_list_rules ?? []
    if (rules.some((r) => !sent.has(r.attribute))) {
      restricted.add(pl.id)
    }
  }
  return restricted
}

/**
 * Alle Mengen, an denen sich der Preis ändern KANN: jedes `min_quantity`
 * und jedes `max_quantity + 1` (dort endet eine Zeile, ohne dass zwingend
 * eine neue beginnt). Menge 1 ist immer dabei — sie ist der Einstiegspreis.
 */
export function collectQuantityBreakpoints(
  rows: QuantityRow[],
  cap: number = MAX_PROBES
): number[] {
  const breakpoints = new Set<number>([1])

  for (const row of rows) {
    const min = Number(row.min_quantity ?? 1)
    if (Number.isFinite(min) && min >= 1) {
      breakpoints.add(min)
    }
    if (row.max_quantity !== null && row.max_quantity !== undefined) {
      const afterMax = Number(row.max_quantity) + 1
      if (Number.isFinite(afterMax) && afterMax >= 1) {
        breakpoints.add(afterMax)
      }
    }
  }

  return [...breakpoints].sort((a, b) => a - b).slice(0, cap)
}

/**
 * Aus den bewerteten Punkten die Staffeln bauen: aufsteigend durchgehen,
 * gleiche Nachbarbeträge zu einer Stufe verschmelzen, Lücken (kein gültiger
 * Preis bei dieser Menge) schliessen die laufende Stufe.
 */
export function tiersFromProbes(
  probes: Probe[],
  fallbackCurrency: string
): Tier[] {
  const sorted = [...probes].sort((a, b) => a.quantity - b.quantity)
  const tiers: Tier[] = []
  let current: Tier | null = null

  for (const probe of sorted) {
    if (probe.amount === null) {
      if (current) {
        current.max_quantity = probe.quantity - 1
      }
      current = null
      continue
    }
    if (current && current.amount === probe.amount) {
      continue
    }
    if (current) {
      current.max_quantity = probe.quantity - 1
    }
    current = {
      min_quantity: probe.quantity,
      max_quantity: null,
      amount: probe.amount,
      currency_code: probe.currency_code ?? fallbackCurrency,
    }
    tiers.push(current)
  }

  return tiers
}
