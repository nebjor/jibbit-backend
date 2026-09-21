/**
 * Galaxus-Exporte — erzeugt die CSV-Dateien für das Händlerprogramm aus den
 * ECHTEN Medusa-Daten (Preise, Bestände, Bilder stehen in der Datenbank):
 *
 *   ProductData_<provider>.csv        Stammdaten inkl. Bild-URLs
 *                                     (Datenaufteilung Option 2 des Handbuchs:
 *                                     Stammdaten + Medien in einer Datei)
 *   PriceData_<provider>.csv          Preise
 *   StockData_<provider>.csv          Verfügbarkeit (= Assortment-File)
 *   SpecificationData_<provider>.csv  Eigenschaften
 *
 *   cd backend
 *   npx medusa exec ./src/scripts/galaxus-export.ts
 *   npx medusa exec ./src/scripts/galaxus-export.ts out=../export/galaxus provider=jibbit
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte
 * Optionen ab, siehe script-args.ts.
 *
 *   out=<verzeichnis>  Zielverzeichnis, Default ../export/galaxus
 *   provider=<name>    Namensteil der Dateien, Default jibbit
 *   mit-luecken        auch unvollständige Varianten aufnehmen (leere
 *                      Pflichtzellen) — nur zum Sichten, nicht hochladen!
 *
 * Varianten, denen Pflichtangaben fehlen (allen voran die GTIN/EAN), werden
 * NICHT stillschweigend weggelassen: jede wird hier mit Begründung gemeldet
 * und steht im Bereitschaftsbericht (galaxus-report.ts).
 *
 * Es gibt bewusst KEINEN FTP-Upload: die Zugangsdaten vergibt Galaxus erst
 * nach der Aufnahme als Händler. Die Dateien landen im Dateisystem.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { buildGalaxusExport, loadVariantSnapshots } from "./galaxus-common"
import { parseScriptArgs } from "./script-args"

export default async function galaxusExport({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const opts = parseScriptArgs(args)

  const outDir = resolve(opts.value("out") ?? "../export/galaxus")
  const provider = opts.value("provider") ?? "jibbit"
  const mitLuecken = opts.flag("mit-luecken")

  const snapshots = await loadVariantSnapshots(container)
  if (!snapshots.length) {
    logger.warn(
      "Keine Varianten in der Datenbank."
    )
    return
  }

  const result = buildGalaxusExport(snapshots, { mitLuecken })

  if (result.ausgeschlossen.length) {
    logger.warn(
      `${result.ausgeschlossen.length} Varianten sind NICHT im Export ` +
        `(Pflichtangaben fehlen):`
    )
    for (const a of result.ausgeschlossen) {
      logger.warn(
        `  ${a.sku ?? "(ohne SKU)"}  ${a.produkt} · ${a.variante} — ` +
          `fehlt: ${a.fehlt.join(", ")}`
      )
    }
    logger.warn(
      "  Details und Arbeitsliste: npx medusa exec ./src/scripts/galaxus-report.ts"
    )
  }

  mkdirSync(outDir, { recursive: true })
  const files: [string, string][] = [
    [`ProductData_${provider}.csv`, result.productData],
    [`PriceData_${provider}.csv`, result.priceData],
    [`StockData_${provider}.csv`, result.stockData],
    [`SpecificationData_${provider}.csv`, result.specificationData],
  ]
  for (const [name, content] of files) {
    writeFileSync(join(outDir, name), content, "utf8")
    logger.info(`geschrieben: ${join(outDir, name)}`)
  }

  logger.info(
    `${result.exportiert} von ${snapshots.length} Varianten exportiert` +
      (mitLuecken ? " (mit-luecken: unvollständige Zeilen enthalten)." : ".")
  )
  if (!result.exportiert) {
    logger.warn(
      "Die Dateien enthalten nur Kopfzeilen — erst Daten nachpflegen " +
        "(galaxus-report.ts zeigt, was fehlt)."
    )
  }
}
