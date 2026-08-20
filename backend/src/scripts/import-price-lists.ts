/**
 * Reguläre Preise + Aktions-Preisliste aus data/price-lists.json anlegen.
 *
 * Ausgangslage: Medusa kennt bisher NUR die Aktionspreise — sie wurden von
 * import-catalog.ts als Standardpreise der Varianten angelegt. Auf jibbit.ch
 * steht aber bei jedem Artikel ein durchgestrichener regulärer Preis, und die
 * Storefront zeigt den Durchstreicher von selbst, sobald
 * `original_amount > calculated_amount` ist. Dieses Script stellt die
 * Datenlage dafür her:
 *
 *   Standardpreis der Variante  ←  regulärer Preis (von jibbit.ch erhoben)
 *   Price List "Aktionspreise"  ←  die Mengenstaffeln aus catalog.json
 *
 * Das geht, weil Price-List-Preise in Medusa dieselben `min_quantity`/
 * `max_quantity`-Spalten tragen wie Standardpreise (price-Tabelle; im
 * Workflow-Input: CreatePriceListPriceWorkflowDTO in
 * @medusajs/types/dist/pricing/workflows.d.ts). Die Staffeln wandern also
 * VOLLSTÄNDIG in die Preisliste; der Standardpreis ist eine einzige Zeile.
 *
 * Vorher:
 *   node scripts/jibbit-shop-prices.mjs            # erzeugt data/price-lists.json
 *
 * Dann:
 *   cd backend
 *   npx medusa exec ./src/scripts/import-price-lists.ts \
 *       ../data/price-lists.json dry-run
 *
 * Argumente OHNE Bindestrich-Präfix — `medusa exec` lehnt unbekannte
 * Optionen ab, siehe script-args.ts.
 *
 * Optionen:
 *   catalog=<pfad>   catalog.json (Staffeln); Default: neben price-lists.json
 *   title=<name>     Titel der Preisliste, Default "Aktionspreise jibbit.ch"
 *   currency=<code>  Zielwährung, Default chf
 *   round=<schritt>  Rundung, Default 0.05 (Schweizer Preisoptik)
 *   dry-run          nur anzeigen, nichts schreiben
 *
 * Idempotent: die Preisliste wird über ihren Titel wiedergefunden. Ein
 * zweiter Lauf mit unveränderten Daten schreibt nichts; geänderte Daten
 * AKTUALISIEREN die bestehende Liste, statt eine zweite anzulegen. Die
 * Preisliste gehört vollständig diesem Import — von Hand ergänzte Preise
 * darin werden beim nächsten Lauf ersetzt. (Ersetzte Zeilen löscht Medusa
 * soft, `deleted_at` — Standardverhalten von removePriceListPricesWorkflow.)
 *
 * WICHTIG — Beträge sind Dezimalzahlen, nicht Rappen (wie seed.ts).
 *
 * WICHTIG — updateProductVariantsWorkflow ersetzt die Standardpreise eines
 * Price Sets vollständig. Fremdwährungen werden deshalb gelesen und wieder
 * mitgeschickt; Preislisten-Preise hängen nicht am Standard-Preisbestand und
 * bleiben stehen (gleiches Vorgehen wie import-price-tiers.ts). Die
 * Reihenfolge — erst Standardpreise, dann Preisliste — stellt sicher, dass
 * selbst ein anders verdrahtetes Medusa-Update nichts verlieren würde.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PriceListStatus,
} from "@medusajs/framework/utils"
import {
  createPriceListPricesWorkflow,
  createPriceListsWorkflow,
  removePriceListPricesWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"

import { skuFor } from "./import-catalog"
import {
  CatalogProduct,
  ImportPlan,
  PlannedVariant,
  ShopPrice,
  buildImportPlan,
} from "./price-list-mapping"
import { PriceInput, ROUND_DEFAULT, samePriceRows } from "./pricing-helpers"
import { parseScriptArgs } from "./script-args"

const TITLE_DEFAULT = "Aktionspreise jibbit.ch"
const BATCH = 50

type PriceListsFile = {
  source?: { url?: string; fetched_at?: string }
  currency?: string
  prices: ShopPrice[]
}

const chunk = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n)
  )

const fmtTiers = (tiers: PriceInput[]) =>
  tiers
    .map(
      (t) =>
        `${t.min_quantity}${t.max_quantity ? `–${t.max_quantity}` : "+"}: ` +
        Number(t.amount).toFixed(2)
    )
    .join("  |  ")

export default async function importPriceLists({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const opts = parseScriptArgs(args)

  const file = opts.file(".json")
  if (!file) {
    logger.error("Pfad zu price-lists.json fehlt.")
    return
  }
  const priceListsPath = resolve(file)
  const catalogPath = resolve(
    opts.value("catalog") ?? join(dirname(priceListsPath), "catalog.json")
  )

  const title = opts.value("title") ?? TITLE_DEFAULT
  const currency = (opts.value("currency") ?? "chf").toLowerCase()
  const step = Number(opts.value("round") ?? String(ROUND_DEFAULT))
  const dryRun = opts.flag("dry-run")

  const shopFile: PriceListsFile = JSON.parse(readFileSync(priceListsPath, "utf8"))
  const catalog: CatalogProduct[] = JSON.parse(readFileSync(catalogPath, "utf8"))

  if (!shopFile.prices?.length) {
    logger.warn("price-lists.json enthält keine Preise.")
    return
  }

  logger.info(
    `${shopFile.prices.length} Shop-Preise (Quelle: ${
      shopFile.source?.url ?? "unbekannt"
    }, Stand ${shopFile.source?.fetched_at ?? "unbekannt"}), ` +
      `${catalog.length} Katalogprodukte, Währung ${currency.toUpperCase()}, Rundung ${step}.`
  )

  // ─── 1. Zuordnen und rechnen — pur, siehe price-list-mapping.ts ──
  const plan: ImportPlan = buildImportPlan(catalog, shopFile.prices, step, currency)

  for (const u of plan.unmatched) {
    logger.warn(`NICHT zugeordnet: "${u.entry.odoo_name}" — ${u.reason}`)
  }
  for (const s of plan.skipped) {
    logger.warn(`Übersprungen: "${s.odooName}" — ${s.reason}`)
  }
  const fuzzy = plan.planned.filter((p) => p.level === "fuzzy")
  if (fuzzy.length) {
    logger.warn(
      `${fuzzy.length} unscharfe Zuordnungen — bitte einmal gegenlesen:`
    )
    for (const f of fuzzy) {
      logger.warn(
        `  "${f.product}" / ${f.variantLabel}  (Ähnlichkeit ${f.score?.toFixed(2)})`
      )
    }
  }
  for (const p of plan.planned) {
    for (const w of p.warnings) {
      logger.warn(`"${p.product}" / ${p.variantLabel}: ${w}`)
    }
  }
  if (plan.noRegular.length) {
    logger.info(
      `${plan.noRegular.length} Katalog-Varianten ohne regulären Preis auf ` +
        `jibbit.ch — behalten ihre bisherigen Preise (kein Durchstreicher):`
    )
    for (const n of plan.noRegular) {
      logger.info(`  ${n.product} / ${n.variantLabel}`)
    }
  }

  if (!plan.planned.length) {
    logger.warn("Nichts zu importieren.")
    return
  }

  // ─── 2. Varianten über die deterministische SKU auflösen ──────
  const bySku = new Map<string, PlannedVariant>()
  for (const p of plan.planned) {
    bySku.set(
      skuFor(p.product, {
        pack_type: p.packType,
        units_per_pack: p.unitsPerPack,
      }),
      p
    )
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: variants } = await query.graph({
    entity: "variants",
    fields: ["id", "sku"],
    filters: { sku: [...bySku.keys()] },
  })

  const variantIdBySku = new Map<string, string>()
  for (const v of variants) {
    if (v.sku) variantIdBySku.set(v.sku, v.id)
  }

  const missing = [...bySku.keys()].filter((sku) => !variantIdBySku.has(sku))
  if (missing.length) {
    logger.warn(
      `${missing.length} Varianten fehlen in Medusa (erst import-catalog ` +
        `laufen lassen?): ${missing.join(", ")}`
    )
  }

  // ─── 3. Bestehende Preise lesen ───────────────────────────────
  const link = container.resolve(ContainerRegistrationKeys.LINK) as {
    getLinkModule: (
      a: string,
      ak: string,
      b: string,
      bk: string
    ) => { list: (f: object, c: object) => Promise<Record<string, string>[]> }
  }

  const variantIds = [...variantIdBySku.values()]
  const links = await link
    .getLinkModule(Modules.PRODUCT, "variant_id", Modules.PRICING, "price_set_id")
    .list({ variant_id: variantIds }, { select: ["variant_id", "price_set_id"] })

  const priceSetByVariant = new Map(
    links.map((l) => [l.variant_id, l.price_set_id])
  )
  const variantByPriceSet = new Map(
    links.map((l) => [l.price_set_id, l.variant_id])
  )

  const pricingService = container.resolve(Modules.PRICING)

  type PriceRow = {
    id: string
    amount: number | string
    currency_code: string
    min_quantity: number | null
    max_quantity: number | null
    price_list_id: string | null
    price_set_id: string
  }

  const existing = priceSetByVariant.size
    ? ((await pricingService.listPrices(
        { price_set_id: [...priceSetByVariant.values()] },
        {
          select: [
            "id",
            "amount",
            "currency_code",
            "min_quantity",
            "max_quantity",
            "price_list_id",
            "price_set_id",
          ],
          take: null,
        }
      )) as unknown as PriceRow[])
    : []

  const asInput = (p: PriceRow): PriceInput => ({
    amount: Number(p.amount),
    currency_code: p.currency_code,
    min_quantity: p.min_quantity === null ? null : Number(p.min_quantity),
    max_quantity: p.max_quantity === null ? null : Number(p.max_quantity),
  })

  /** Standardpreise (ohne Preisliste) je Variante, nach Währung getrennt. */
  const baseTarget = new Map<string, PriceInput[]>() // Zielwährung
  const baseKeep = new Map<string, PriceInput[]>() // Fremdwährungen
  for (const row of existing) {
    if (row.price_list_id) {
      continue
    }
    const variantId = variantByPriceSet.get(row.price_set_id)
    if (!variantId) {
      continue
    }
    const bucket =
      row.currency_code.toLowerCase() === currency ? baseTarget : baseKeep
    const list = bucket.get(variantId) ?? []
    list.push(asInput(row))
    bucket.set(variantId, list)
  }

  // ─── 4. Standardpreise: nur schreiben, was sich ändert ────────
  const variantPayload: { id: string; prices: PriceInput[] }[] = []
  let baseUnchanged = 0

  for (const [sku, planned] of bySku) {
    const variantId = variantIdBySku.get(sku)
    if (!variantId) {
      continue
    }
    const desired: PriceInput[] = [
      {
        amount: planned.regular,
        currency_code: currency,
        min_quantity: 1,
        max_quantity: null,
      },
    ]
    if (samePriceRows(baseTarget.get(variantId) ?? [], desired)) {
      baseUnchanged++
      continue
    }
    variantPayload.push({
      id: variantId,
      prices: [...desired, ...(baseKeep.get(variantId) ?? [])],
    })
  }

  // ─── 5. Preisliste: anlegen oder vollständig abgleichen ───────
  // FilterablePriceListProps kennt kein `title` — deshalb alle Listen holen
  // (es sind eine Handvoll) und im Speicher über den Titel wiederfinden.
  const priceLists = (await pricingService.listPriceLists(
    {},
    { select: ["id", "title", "status"], take: null }
  )) as unknown as { id: string; title: string; status: string }[]
  const priceList = priceLists.find((pl) => pl.title === title) ?? null

  const existingPlRows = priceList
    ? ((await pricingService.listPrices(
        { price_list_id: [priceList.id] },
        {
          select: [
            "id",
            "amount",
            "currency_code",
            "min_quantity",
            "max_quantity",
            "price_set_id",
          ],
          take: null,
        }
      )) as unknown as PriceRow[])
    : []

  /** Sollzustand der Preisliste: alle Staffeln, adressiert über die Variante. */
  const desiredPlPrices: {
    variant_id: string
    amount: number
    currency_code: string
    min_quantity: number | null
    max_quantity: number | null
  }[] = []
  for (const [sku, planned] of bySku) {
    const variantId = variantIdBySku.get(sku)
    if (!variantId) {
      continue
    }
    for (const t of planned.tiers) {
      desiredPlPrices.push({
        variant_id: variantId,
        amount: Number(t.amount),
        currency_code: t.currency_code,
        min_quantity: t.min_quantity ?? null,
        max_quantity: t.max_quantity ?? null,
      })
    }
  }

  const plKey = (p: {
    variant_id: string | undefined
    amount: number | string
    currency_code: string
    min_quantity: number | string | null
    max_quantity: number | string | null
  }) =>
    [
      p.variant_id ?? "?",
      Number(p.amount),
      p.currency_code.toLowerCase(),
      p.min_quantity === null ? 1 : Number(p.min_quantity),
      p.max_quantity === null ? "" : Number(p.max_quantity),
    ].join("|")

  const plUnchanged =
    priceList !== null &&
    existingPlRows.length === desiredPlPrices.length &&
    (() => {
      const have = existingPlRows
        .map((p) =>
          plKey({
            variant_id: variantByPriceSet.get(p.price_set_id),
            amount: p.amount,
            currency_code: p.currency_code,
            min_quantity: p.min_quantity,
            max_quantity: p.max_quantity,
          })
        )
        .sort()
      const want = desiredPlPrices.map(plKey).sort()
      return have.every((k, i) => k === want[i])
    })()

  // ─── 6. Bericht / Probelauf ───────────────────────────────────
  logger.info(
    `Plan: ${plan.planned.length} Varianten ` +
      `(${plan.planned.length - missing.length} in Medusa gefunden), ` +
      `${variantPayload.length} Standardpreise zu schreiben, ${baseUnchanged} unverändert. ` +
      `Preisliste "${title}": ${
        priceList
          ? plUnchanged
            ? "unverändert"
            : `aktualisieren (${existingPlRows.length} → ${desiredPlPrices.length} Preise)`
          : `neu anlegen (${desiredPlPrices.length} Preise)`
      }.`
  )

  if (dryRun) {
    logger.info("— Probelauf, es wird nichts geschrieben —")
    for (const [sku, p] of bySku) {
      const state = variantIdBySku.has(sku) ? "" : "  [FEHLT IN MEDUSA]"
      logger.info(
        `  ${sku.padEnd(30)} regulär ${p.regular.toFixed(2).padStart(7)}  ` +
          `Aktion ${fmtTiers(p.tiers)}${state}`
      )
    }
    return
  }

  // ─── 7. Schreiben ─────────────────────────────────────────────
  let done = 0
  for (const batch of chunk(variantPayload, BATCH)) {
    await updateProductVariantsWorkflow(container).run({
      input: { product_variants: batch },
    })
    done += batch.length
    logger.info(`  ${done}/${variantPayload.length} Standardpreise gesetzt`)
  }

  if (!priceList) {
    await createPriceListsWorkflow(container).run({
      input: {
        price_lists_data: [
          {
            title,
            description:
              "Aktionspreise von jibbit.ch (Import über import-price-lists.ts " +
              "aus data/price-lists.json — nicht von Hand pflegen).",
            status: PriceListStatus.ACTIVE,
            prices: desiredPlPrices,
          },
        ],
      },
    })
    logger.info(
      `Preisliste "${title}" mit ${desiredPlPrices.length} Preisen angelegt.`
    )
  } else if (plUnchanged) {
    logger.info(`Preisliste "${title}" ist aktuell — nichts geschrieben.`)
  } else {
    if (existingPlRows.length) {
      await removePriceListPricesWorkflow(container).run({
        input: { ids: existingPlRows.map((p) => p.id) },
      })
    }
    await createPriceListPricesWorkflow(container).run({
      input: {
        data: [{ id: priceList.id, prices: desiredPlPrices }],
      },
    })
    logger.info(
      `Preisliste "${title}" aktualisiert: ${existingPlRows.length} Preise ` +
        `ersetzt durch ${desiredPlPrices.length}.`
    )
  }

  logger.info(
    `Fertig. ${variantPayload.length} Standardpreise geschrieben, ` +
      `${baseUnchanged} waren schon aktuell.`
  )
}
