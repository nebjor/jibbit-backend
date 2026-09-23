/**
 * GTIN (EAN/UPC) je Variante — Prüfung der Katalognummern. Reine Funktionen,
 * von import-catalog.ts und update-catalog.ts geteilt.
 *
 * WOHIN DIE NUMMER GEHT
 * Jede gültige GTIN — 8, 12, 13 oder 14 Ziffern — landet in `variant.ean`.
 * Das ist die Konvention der Galaxus-Anbindung (galaxus-common.ts liest
 * ausschliesslich `variants.ean` und nimmt dort 8–14 Ziffern), und eine
 * zweite daneben hiesse: eine UPC-A oder EAN-8 fehlt im Galaxus-Export, nur
 * weil sie kürzer ist. `upc` und `barcode` setzen die Katalog-Scripts
 * nie; sie bleiben frei für das, was der Betreiber im Admin dort pflegt
 * (etwa einen hauseigenen Lagercode). Einzige Ausnahme: steht dort exakt die
 * Katalog-GTIN der Variante (ein früherer Stand verteilte nach Länge), leert
 * update-catalog.ts das Feld. In `metadata` gehört die Nummer nicht —
 * das Admin zeigt und pflegt die native Spalte, und die Store-API liefert
 * sie typisiert aus. Die Storefront liest `ean` zuerst und bestimmt die
 * Länge selbst (lib/gtin.ts dort).
 *
 * Die Katalogfelder `gtin` und `ean` zielen damit auf dieselbe Spalte; beide
 * werden gleich streng geprüft (`isValidGtin`). `variant.ean` trägt einen
 * Unique-Index: dieselbe Nummer an zwei Varianten lässt den Schreiblauf
 * mittendrin scheitern. Deshalb prüft `validateCatalogGtins` auch auf
 * Doppelte — vor dem ersten Schreibzugriff.
 */

import type { CatalogProduct } from "./import-catalog"

const GTIN_LENGTHS = [8, 12, 13, 14]

/**
 * GS1-Prüfziffer: von rechts, ohne die Prüfziffer selbst, abwechselnd mit 3
 * und 1 gewichten; die Prüfziffer ergänzt die Summe auf das nächste Vielfache
 * von 10. Gilt unverändert für alle vier Längen.
 */
export function isValidGtin(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return false
  }
  if (!GTIN_LENGTHS.includes(value.length)) {
    return false
  }
  // Lauter Nullen bestehen die Prüfziffer, sind aber ein Platzhalter.
  if (/^0+$/.test(value)) {
    return false
  }
  const digits = [...value].map(Number)
  const check = digits.pop()!
  const sum = digits
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}

/**
 * Der Wert für `variant.ean` aus den beiden Katalogfeldern. `gtin` zuerst;
 * die Validierung garantiert, dass ein zusätzliches `ean` gleich lautet.
 */
export function catalogEan(v: {
  gtin?: string | null
  ean?: string | null
}): string | undefined {
  return v.gtin ?? v.ean ?? undefined
}

/**
 * Alle GTINs eines Katalogs prüfen. Liefert die Fehler als Text, leer = gut.
 *
 * `gtin` ist optional — fehlt das Feld, gibt es nichts zu prüfen. Steht es
 * da, muss es stimmen: eine Zahl statt eines Strings (JSON frisst führende
 * Nullen), eine falsche Prüfziffer oder eine doppelt vergebene Nummer sind
 * Tippfehler, die draussen als falscher Artikel bei Google landen.
 */
export function validateCatalogGtins(catalog: CatalogProduct[]): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()

  // Das Katalogfeld `ean` (Galaxus-Anbindung, siehe import-catalog.ts)
  // schreibt in dieselbe Spalte. Eine GTIN, die dort schon an einer ANDEREN
  // Variante steht, liefe auf denselben Unique-Index.
  const eanOwner = new Map<string, string>()
  for (const p of catalog) {
    for (const v of p.variants) {
      if (typeof v.ean === "string" && !eanOwner.has(v.ean)) {
        eanOwner.set(v.ean, `${p.product} / ${v.label}`)
      }
    }
  }

  for (const p of catalog) {
    for (const v of p.variants) {
      const raw: unknown = v.gtin
      if (raw === undefined || raw === null) {
        continue
      }
      const where = `${p.product} / ${v.label}`
      if (v.ean != null && v.ean !== raw) {
        errors.push(
          `${where}: gtin ${JSON.stringify(raw)} und ean ${JSON.stringify(v.ean)} ` +
            `widersprechen sich — eines der beiden Felder streichen`
        )
        continue
      }
      if (!isValidGtin(raw)) {
        errors.push(
          `${where}: ${JSON.stringify(raw)} ist keine gültige GTIN ` +
            `(String aus 8/12/13/14 Ziffern mit korrekter GS1-Prüfziffer)`
        )
        continue
      }
      const eanAt = eanOwner.get(raw)
      const owner = seen.get(raw) ?? (eanAt !== where ? eanAt : undefined)
      if (owner) {
        errors.push(`${where}: GTIN ${raw} steht schon bei "${owner}"`)
        continue
      }
      seen.set(raw, where)
    }
  }

  return errors
}

/** Bricht laut ab — mit allen Fehlern auf einmal, nicht nur dem ersten. */
export function assertCatalogGtins(catalog: CatalogProduct[]): void {
  const errors = validateCatalogGtins(catalog)
  if (errors.length) {
    throw new Error(
      `Ungültige GTIN im Katalog — nichts wurde geschrieben:\n  ` +
        errors.join("\n  ")
    )
  }
}
