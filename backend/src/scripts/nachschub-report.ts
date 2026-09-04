/**
 * Nachschubbericht — welche Varianten liegen auf oder unter ihrem
 * Meldebestand, und wo bestellt der Betreiber sie nach? Das Terminal-Pendant
 * zur Admin-Seite «Nachschub», analog zu galaxus-report.ts.
 *
 *   cd backend
 *   npx medusa exec ./src/scripts/nachschub-report.ts
 *   npx medusa exec ./src/scripts/nachschub-report.ts csv=../export/nachschub.csv
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte
 * Optionen ab, siehe script-args.ts.
 *
 *   csv=<pfad>   Bericht zusätzlich als CSV schreiben (Semikolon, UTF-8) —
 *                ALLE Varianten mit Statusspalte, zum Ausdrucken/Abhaken.
 *
 * WICHTIG — eine leere Fällig-Liste ist KEINE Entwarnung: Varianten ohne
 * Bestandsführung (inventory.json quantity=null) oder ohne Meldebestand
 * (reorder_point in catalog.json) können gar nicht überwacht werden. Der
 * Bericht nennt deshalb immer beide Zahlen: wie viele Varianten überwacht
 * werden und wie viele nicht überwachbar sind.
 *
 * Der Bericht liest NUR und schreibt nie in die Datenbank. Gepflegt werden
 * die Daten in data/catalog.json (reorder_point, suppliers) und
 * data/inventory.json (quantity), eingespielt mit update-catalog.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { ExecArgs, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { toCsv, Cell } from "./galaxus-common"
import { parseScriptArgs } from "./script-args"
import {
  istFaellig,
  nachDringlichkeit,
  nachschubUebersicht,
  parseLieferanten,
  parseMeldebestand,
  NachschubZeile,
} from "../lib/nachschub"

/**
 * Alle Varianten mit Bestand, Meldebestand und Lieferanten aus der Datenbank
 * lesen. Bestandslogik wie galaxus-common.loadVariantSnapshots(): verfügbar =
 * Summe (stocked - reserved) über alle Levels; ohne manage_inventory oder
 * ohne Inventory-Item bleibt der Bestand null ("nicht überwachbar").
 */
export async function loadNachschubZeilen(
  container: MedusaContainer
): Promise<NachschubZeile[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.manage_inventory",
      "variants.metadata",
      "variants.inventory_items.inventory_item_id",
    ],
  })

  const { data: levels } = await query.graph({
    entity: "inventory_level",
    fields: ["inventory_item_id", "stocked_quantity", "reserved_quantity"],
  })

  const stockByItem = new Map<string, number>()
  for (const level of levels as any[]) {
    const have = stockByItem.get(level.inventory_item_id) ?? 0
    const free =
      Number(level.stocked_quantity ?? 0) - Number(level.reserved_quantity ?? 0)
    stockByItem.set(level.inventory_item_id, have + free)
  }

  const zeilen: NachschubZeile[] = []
  for (const p of products as any[]) {
    for (const v of p.variants ?? []) {
      let bestand: number | null = null
      if (v.manage_inventory) {
        const itemIds: string[] = (v.inventory_items ?? [])
          .map((l: any) => l.inventory_item_id)
          .filter(Boolean)
        if (itemIds.length) {
          const sum = itemIds.reduce(
            (n: number, id: string) => n + (stockByItem.get(id) ?? 0),
            0
          )
          bestand = Math.max(0, sum)
        }
      }
      zeilen.push({
        sku: v.sku ?? null,
        produkt: p.title,
        variante: v.title ?? "",
        productId: p.id,
        bestand,
        meldebestand: parseMeldebestand(v.metadata ?? null),
        lieferanten: parseLieferanten(v.metadata ?? null),
      })
    }
  }
  return zeilen
}

export default async function nachschubReport({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const opts = parseScriptArgs(args)

  const zeilen = await loadNachschubZeilen(container)
  if (!zeilen.length) {
    logger.warn(
      "Keine Varianten in der Datenbank — zuerst import-catalog.ts laufen lassen."
    )
    return
  }

  const u = nachschubUebersicht(zeilen)

  logger.info("— Nachschubbericht —")
  if (!u.faellig.length) {
    logger.info("  Keine überwachte Variante liegt auf oder unter dem Meldebestand.")
  }
  for (const z of u.faellig) {
    const haupt = z.lieferanten[0]
    const lieferant = haupt
      ? `${haupt.name}` +
        (haupt.artikelnummer ? ` (Art. ${haupt.artikelnummer})` : "") +
        (haupt.url ? ` ${haupt.url}` : " — keine gültige Adresse") +
        (z.lieferanten.length > 1
          ? ` (+${z.lieferanten.length - 1} weitere)`
          : "")
      : "KEIN Lieferant gepflegt"
    logger.info(
      `  ${(z.sku ?? "(ohne SKU)").padEnd(30)} ${z.produkt} · ${z.variante}`
    )
    logger.info(
      `  ${"".padEnd(30)} Bestand ${z.bestand} / Meldebestand ${z.meldebestand}` +
        ` → ${lieferant}`
    )
  }

  logger.info("— Zusammenfassung —")
  logger.info(
    `  Nachzubestellen: ${u.faellig.length} von ${u.ueberwacht} überwachten ` +
      `Varianten (${u.gesamt} gesamt).`
  )
  if (u.nichtUeberwachbar > 0) {
    // Als Warnung, damit die Zahl ins Auge springt: eine leere Fällig-Liste
    // ist keine Entwarnung, solange Varianten gar nicht überwacht werden.
    logger.warn(
      `  NICHT überwachbar: ${u.nichtUeberwachbar} von ${u.gesamt} Varianten ` +
        `(${u.ohneBestand} ohne Bestandsführung, ${u.ohneMeldebestand} ohne ` +
        `Meldebestand) — für diese Varianten sagt der Bericht NICHTS aus.`
    )
    logger.warn(
      "  Nachpflegen: quantity in data/inventory.json, reorder_point und " +
        "suppliers in data/catalog.json, dann update-catalog.ts."
    )
  } else {
    logger.info(`  Alle ${u.gesamt} Varianten werden überwacht.`)
  }

  const csvPath = opts.value("csv")
  if (csvPath) {
    // ALLE Varianten mit Status, fällige zuerst — die Statusspalte macht im
    // Ausdruck sichtbar, welche Zeilen mangels Pflege keine Aussage haben.
    const sortiert = [...zeilen].sort((a, b) => {
      const rang = (z: NachschubZeile) =>
        istFaellig(z) ? 0 : z.bestand !== null && z.meldebestand !== null ? 1 : 2
      const r = rang(a) - rang(b)
      if (r !== 0) {
        return r
      }
      return rang(a) === 0
        ? nachDringlichkeit(a, b)
        : (a.sku ?? "").localeCompare(b.sku ?? "")
    })

    const columns = [
      "Status",
      "Sku",
      "Produkt",
      "Variante",
      "Bestand",
      "Meldebestand",
      "Fehlmenge",
      "Lieferant",
      "LieferantenArtikelNr",
      "Link",
      "WeitereLieferanten",
      "Hinweis",
    ]
    const rows: Record<string, Cell>[] = sortiert.map((z) => {
      const haupt = z.lieferanten[0]
      const status = istFaellig(z)
        ? "NACHBESTELLEN"
        : z.bestand === null
          ? "NICHT ÜBERWACHBAR (kein Bestand)"
          : z.meldebestand === null
            ? "NICHT ÜBERWACHBAR (kein Meldebestand)"
            : "ok"
      const hinweise: string[] = []
      if (istFaellig(z) && !haupt) {
        hinweise.push("kein Lieferant gepflegt")
      }
      if (haupt && !haupt.url) {
        // Beim Rendern geprüft: eine Nicht-http(s)-Adresse landet nie in der
        // Link-Spalte — sie würde beim Anklicken im Admin Code ausführen.
        hinweise.push("Lieferanten-Adresse ungültig (nur http/https erlaubt)")
      }
      return {
        Status: status,
        Sku: z.sku,
        Produkt: z.produkt,
        Variante: z.variante,
        Bestand: z.bestand,
        Meldebestand: z.meldebestand,
        Fehlmenge:
          z.bestand !== null && z.meldebestand !== null
            ? Math.max(0, z.meldebestand - z.bestand)
            : null,
        Lieferant: haupt?.name ?? null,
        LieferantenArtikelNr: haupt?.artikelnummer ?? null,
        Link: haupt?.url ?? null,
        WeitereLieferanten: z.lieferanten
          .slice(1)
          .map((l) => `${l.name}${l.url ? ` ${l.url}` : ""}`)
          .join(" | "),
        Hinweis: hinweise.join("; "),
      }
    })

    const csv = toCsv(columns, rows)
    const target = resolve(csvPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, csv, "utf8")
    logger.info(`Bericht geschrieben: ${target}`)
  }
}
