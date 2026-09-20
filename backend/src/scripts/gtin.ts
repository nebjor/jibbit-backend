/**
 * GTIN (EAN/UPC) je Variante — Prüfung und Zuordnung auf Medusas native
 * Spalten. Reine Funktionen, von import-catalog.ts und update-catalog.ts
 * geteilt.
 *
 * WOHIN DIE NUMMER GEHT
 * `product_variant` hat drei native Spalten, und die Nummer gehört dorthin,
 * nicht in `metadata` — das Admin zeigt und pflegt genau diese Felder, und
 * die Store-API liefert sie typisiert aus:
 *
 *   GTIN-13 (EAN-13) -> ean
 *   GTIN-12 (UPC-A)  -> upc
 *   GTIN-8  (EAN-8)  -> barcode
 *   GTIN-14 (ITF-14) -> barcode
 *
 * Für GTIN-8 und GTIN-14 gibt es keine eigene Spalte. `barcode` ist das
 * Feld für «was auf der Packung gescannt wird» und damit die ehrliche Wahl;
 * `ean` bleibt 13-stellig, damit niemand, der die Spalte später ausliest
 * (Feed, Lager), auf zwei Längen gefasst sein muss. Die Storefront liest
 * alle drei Felder und prüft selbst nach (lib/gtin.ts dort) — eine im Admin
 * von Hand in `ean` getippte EAN-8 kommt also trotzdem an.
 *
 * Alle drei Spalten tragen einen Unique-Index: dieselbe Nummer an zwei
 * Varianten lässt den Schreiblauf mittendrin scheitern. Deshalb prüft
 * `validateCatalogGtins` auch auf Doppelte — vor dem ersten Schreibzugriff.
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

export type GtinField = "ean" | "upc" | "barcode"

/** Die native Spalte für eine (gültige) GTIN — Zuordnung siehe Dateikopf. */
export function gtinFieldFor(gtin: string): GtinField {
  if (gtin.length === 13) {
    return "ean"
  }
  if (gtin.length === 12) {
    return "upc"
  }
  return "barcode"
}

/** `{ ean: "…" }`, `{ upc: "…" }` oder `{ barcode: "…" }`; ohne GTIN `{}`. */
export function gtinFields(
  gtin: string | null | undefined
): Partial<Record<GtinField, string>> {
  return gtin ? { [gtinFieldFor(gtin)]: gtin } : {}
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

  // Das ältere Katalogfeld `ean` (Galaxus-Anbindung, siehe import-catalog.ts)
  // schreibt ebenfalls in die Spalte ean. Eine GTIN, die dort schon an einer
  // ANDEREN Variante steht, liefe auf denselben Unique-Index.
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
