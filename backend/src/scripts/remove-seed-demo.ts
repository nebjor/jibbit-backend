/**
 * Entfernt die Demo-Produkte, die seed.ts anlegt.
 *
 * ─── WOFÜR ────────────────────────────────────────────────────────────────
 *
 * `seed.ts` legt neben Region, Währung, Verkaufskanal und Lagerort auch 13
 * Beispielprodukte an. Die sind beim Aufbau nützlich — sie beweisen, dass die
 * Kette Storefront → Medusa steht, bevor echte Daten da sind. Sobald der echte
 * Katalog importiert ist, stehen sie im Weg: Sie sind von echten Artikeln kaum
 * zu unterscheiden, haben erfundene Preise und keine Mengenstaffeln, und sie
 * schleppen Kategorien mit, die es im Sortiment gar nicht gibt
 * («Kräutermischungen»).
 *
 * ─── WARUM EINE FESTE LISTE ───────────────────────────────────────────────
 *
 * Gelöscht wird ausschliesslich, was hier namentlich steht. Keine Heuristik
 * über Erstellungsdatum, fehlende Bilder oder «hat keine Staffelpreise» — bei
 * so etwas löscht man irgendwann echte Ware. Die Liste stammt aus seed.ts; wer
 * dort Produkte ergänzt, muss sie hier nachtragen.
 *
 * Kategorien werden nur entfernt, wenn danach KEIN Produkt mehr darin liegt.
 * `papers`, `filter` und `zubehoer` überleben deshalb automatisch, ohne dass
 * sie hier auftauchen müssten.
 *
 *   npx medusa exec ./src/scripts/remove-seed-demo.js dry-run
 *   npx medusa exec ./src/scripts/remove-seed-demo.js
 *
 * Argumente ohne Bindestrich-Präfix — `medusa exec` lehnt unbekannte Optionen
 * ab, siehe script-args.ts.
 */

import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  deleteProductsWorkflow,
  deleteProductCategoriesWorkflow,
} from "@medusajs/medusa/core-flows"

import { parseScriptArgs } from "./script-args"

/** Exakt die Produkte aus seed.ts. Reihenfolge wie dort. */
const SEED_HANDLES = [
  "raw-classic-king-size-slim",
  "raw-black-organic-hemp-1-1-4",
  "elements-ultra-thin-rice-kss",
  "ocb-premium-black-kss",
  "smoking-blue-king-size",
  "zig-zag-blue-regular",
  "purize-aktivkohlefilter-6mm",
  "purize-xtra-slim-5-9mm",
  "raw-perforated-tips",
  "angel-filter-tips-slim",
  "greengo-kraeutermischung",
  "dubi-glasaschenbecher",
  "dubi-glasaschenbecher-xl",
] as const

export default async function removeSeedDemo({ container, args }: ExecArgs) {
  const logger = container.resolve("logger")
  const opts = parseScriptArgs(args)
  const dryRun = opts.flag("dry-run")

  const productService = container.resolve(Modules.PRODUCT)

  const found = await productService.listProducts({
    handle: [...SEED_HANDLES],
  })

  if (!found.length) {
    logger.info("Keine Demo-Produkte gefunden — nichts zu tun.")
    return
  }

  const missing = SEED_HANDLES.filter(
    (h) => !found.some((p) => p.handle === h),
  )

  logger.info(`${found.length} Demo-Produkte gefunden:`)
  for (const p of found) {
    logger.info(`  ${p.title}  (${p.handle})`)
  }
  if (missing.length) {
    logger.info(
      `${missing.length} aus der Liste sind nicht vorhanden — vermutlich ` +
        `schon gelöscht.`,
    )
  }

  // Bestand VOR dem Löschen, damit die Zahl am Ende einen Vergleich hat.
  const before = await productService.listProducts({})

  if (dryRun) {
    logger.info(
      `Trockenlauf: würde ${found.length} Produkte löschen. ` +
        `Danach blieben ${before.length - found.length} übrig.`,
    )
  } else {
    await deleteProductsWorkflow(container).run({
      input: { ids: found.map((p) => p.id) },
    })
    logger.info(`${found.length} Demo-Produkte gelöscht.`)
  }

  // ─── Leere Kategorien aufräumen ─────────────────────────────────────────
  //
  // Erst nach dem Löschen zählen: Eine Kategorie gilt als leer, wenn kein
  // Produkt mehr auf sie zeigt. So verschwinden «Kräutermischungen» und die
  // doppelten Filter-Kategorien von selbst, während papers/filter/zubehoer
  // stehen bleiben, ohne dass sie hier genannt werden müssten.
  const categoryService = container.resolve(Modules.PRODUCT)
  const categories = await categoryService.listProductCategories(
    {},
    { relations: ["products"] },
  )

  const empty = categories.filter((c) => !(c.products?.length ?? 0))

  if (!empty.length) {
    logger.info("Keine leeren Kategorien.")
    return
  }

  logger.info(`${empty.length} Kategorien ohne Produkte:`)
  for (const c of empty) {
    logger.info(`  ${c.name}  (${c.handle})`)
  }

  if (dryRun) {
    logger.info("Trockenlauf: würde diese Kategorien löschen.")
    return
  }

  await deleteProductCategoriesWorkflow(container).run({
    input: empty.map((c) => c.id),
  })

  const after = await productService.listProducts({})
  logger.info(
    `Fertig. ${empty.length} leere Kategorien gelöscht, ` +
      `${after.length} Produkte im Katalog.`,
  )
}
