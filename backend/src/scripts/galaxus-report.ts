/**
 * Galaxus-Bereitschaftsbericht — prüft den Katalog in der Datenbank gegen
 * die Pflichtangaben des Galaxus-Händlerprogramms und listet je Variante,
 * was fehlt (EAN, Gewicht, Marke, Bild, Bestand, Preis, Beschreibung).
 *
 *   cd backend
 *   npx medusa exec ./src/scripts/galaxus-report.ts
 *   npx medusa exec ./src/scripts/galaxus-report.ts csv=../export/galaxus-bereitschaft.csv
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte
 * Optionen ab, siehe script-args.ts.
 *
 *   csv=<pfad>   Bericht zusätzlich als CSV schreiben (Semikolon, UTF-8) —
 *                als Arbeitsliste zum Nachpflegen der Daten.
 *
 * Der Bericht liest NUR und schreibt nie in die Datenbank. Nachgepflegt
 * werden die Daten im Admin — siehe nebjor/jibbit-internal (privat), galaxus-marktplatz.md.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import {
  fehlendeFelder,
  loadVariantSnapshots,
  toCsv,
} from "./galaxus-common"
import { parseScriptArgs } from "./script-args"

export default async function galaxusReport({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const opts = parseScriptArgs(args)

  const snapshots = await loadVariantSnapshots(container)
  if (!snapshots.length) {
    logger.warn(
      "Keine Varianten in der Datenbank."
    )
    return
  }

  const rows = snapshots
    .map((s) => ({ s, fehlt: fehlendeFelder(s) }))
    .sort((a, b) => (a.s.sku ?? "").localeCompare(b.s.sku ?? ""))

  const bereit = rows.filter((r) => !r.fehlt.length)

  logger.info("— Galaxus-Bereitschaftsbericht —")
  for (const { s, fehlt } of rows) {
    const name = `${s.productTitle} · ${s.variantTitle}`
    const status = fehlt.length ? `fehlt: ${fehlt.join(", ")}` : "✓ vollständig"
    logger.info(`  ${(s.sku ?? "(ohne SKU)").padEnd(30)} ${name}`)
    logger.info(`  ${"".padEnd(30)} ${status}`)
  }

  // Zusammenfassung: wie oft fehlt welches Feld?
  const counts = new Map<string, number>()
  for (const { fehlt } of rows) {
    for (const f of fehlt) {
      // «ean ungültig («…»)» unter «ean ungültig» zusammenfassen.
      const key = f.startsWith("ean ungültig") ? "ean ungültig" : f
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  logger.info("— Zusammenfassung —")
  logger.info(
    `  Lieferfähig für Galaxus: ${bereit.length} von ${rows.length} Varianten.`
  )
  for (const [field, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    logger.info(`  ${String(n).padStart(4)}× fehlt: ${field}`)
  }
  if (bereit.length < rows.length) {
    logger.info(
      "  Nachpflegen im Admin: EAN und Gewicht an der Variante, Marke " +
        "(brand) in den Produkt-Metadaten, Bestand im Lager. " +
        "Details: nebjor/jibbit-internal (privat), galaxus-marktplatz.md"
    )
  }

  const csvPath = opts.value("csv")
  if (csvPath) {
    const columns = [
      "Sku",
      "Produkt",
      "Variante",
      "Ean",
      "GewichtG",
      "Marke",
      "Preis",
      "Bestand",
      "Bilder",
      "Fehlend",
    ]
    const csv = toCsv(
      columns,
      rows.map(({ s, fehlt }) => ({
        Sku: s.sku,
        Produkt: s.productTitle,
        Variante: s.variantTitle,
        Ean: s.ean,
        GewichtG: s.weightG,
        Marke: s.brand,
        Preis: s.price,
        Bestand: s.stock,
        Bilder: s.imageUrls.length,
        Fehlend: fehlt.join(", "),
      }))
    )
    const target = resolve(csvPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, csv, "utf8")
    logger.info(`Bericht geschrieben: ${target}`)
  }
}
