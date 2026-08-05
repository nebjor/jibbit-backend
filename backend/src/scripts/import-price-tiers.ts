/**
 * Importiert Mengenstaffeln aus dem Odoo-Export in die Medusa-Preise.
 *
 *   node scripts/odoo-export.mjs            # erzeugt odoo-export/tiers.json
 *   cd backend
 *   npx medusa exec ./src/scripts/import-price-tiers.ts \
 *       ../odoo-export/tiers.json --pricelist "Public Pricelist" --dry-run
 *
 * Optionen:
 *   --pricelist <name>   nur diese Odoo-Preisliste importieren (sonst: alle,
 *                        was bei mehreren Listen zu Konflikten führt)
 *   --currency <code>    Zielwährung in Medusa, Default chf
 *   --round <schritt>    Rundungsschritt, Default 0.05 (Schweizer Preisoptik).
 *                        --round 0.01 für rappengenaue Preise.
 *   --dry-run            nur anzeigen, nichts schreiben
 *
 * WICHTIG — Beträge sind Dezimalzahlen, nicht Rappen. CHF 27.00 === 27.
 * (Gleiche Konvention wie seed.ts.)
 *
 * WICHTIG — updateProductVariantsWorkflow ersetzt die Preise eines Price Sets
 * vollständig. Preise in anderen Währungen werden deshalb vorher gelesen und
 * unverändert wieder mitgeschickt. Preislisten-Preise (Aktionen, B2B) liegen
 * ausserhalb und werden nicht angefasst — das bitte nach dem ersten echten
 * Lauf einmal im Admin gegenprüfen.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows"

type ExportTier = {
  min_quantity: number
  max_quantity: number | null
  price: number
}

type ExportEntry = {
  sku: string | null
  name: string
  pricelist: string
  currency: string
  has_discount: boolean
  tiers: ExportTier[]
}

type PriceInput = {
  amount: number
  currency_code: string
  min_quantity?: number | null
  max_quantity?: number | null
}

const BATCH = 50

/**
 * Schweizer Preisoptik: alles auf 5 Rappen. Der kleinste Münzwert ist
 * CHF 0.05, Preise dazwischen wirken hier fremd.
 */
const ROUND_DEFAULT = 0.05

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

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
 * Staffeln müssen bei 1 beginnen und lückenlos sein — sonst findet der
 * Warenkorb für kleine Mengen keinen Preis und bricht die Bestellung ab
 * ("Variants with IDs … do not have a price").
 */
function validateTiers(tiers: ExportTier[]): string | null {
  if (!tiers.length) {
    return "keine Staffeln"
  }
  if (tiers[0].min_quantity !== 1) {
    return `beginnt bei ${tiers[0].min_quantity} statt 1`
  }
  for (let i = 0; i < tiers.length - 1; i++) {
    const expected = tiers[i + 1].min_quantity - 1
    if (tiers[i].max_quantity !== expected) {
      return `Lücke zwischen Stufe ${i + 1} und ${i + 2}`
    }
  }
  if (tiers[tiers.length - 1].max_quantity !== null) {
    return "oberste Staffel ist nicht nach oben offen"
  }
  return null
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

const chunk = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n)
  )

export default async function importPriceTiers({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const file = args.find((a) => !a.startsWith("--") && a.endsWith(".json"))
  if (!file) {
    logger.error("Pfad zu tiers.json fehlt.")
    return
  }

  const pricelistFilter = flag(args, "pricelist")
  const currency = (flag(args, "currency") ?? "chf").toLowerCase()
  const step = Number(flag(args, "round") ?? String(ROUND_DEFAULT))
  const dryRun = args.includes("--dry-run")

  const raw: ExportEntry[] = JSON.parse(readFileSync(resolve(file), "utf8"))

  const entries = raw.filter(
    (e) =>
      e.sku &&
      e.has_discount &&
      (!pricelistFilter || e.pricelist === pricelistFilter)
  )

  const lists = [...new Set(raw.map((e) => e.pricelist))]
  if (!pricelistFilter && lists.length > 1) {
    logger.error(
      `Der Export enthält ${lists.length} Preislisten (${lists.join(", ")}). ` +
        `Bitte mit --pricelist "<name>" eine auswählen, sonst überschreiben ` +
        `sie sich gegenseitig.`
    )
    return
  }

  if (!entries.length) {
    logger.warn("Keine Artikel mit Mengenstaffeln im Export gefunden.")
    return
  }

  logger.info(
    `${entries.length} Artikel mit Staffeln${
      pricelistFilter ? ` aus "${pricelistFilter}"` : ""
    }, Zielwährung ${currency.toUpperCase()}, Rundung ${step}.`
  )

  // ─── Varianten über die SKU zuordnen ──────────────────────────
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const skus = entries.map((e) => e.sku as string)

  const { data: variants } = await query.graph({
    entity: "variants",
    fields: ["id", "sku"],
    filters: { sku: skus },
  })

  const variantBySku = new Map<string, string>(
    variants.map((v: { id: string; sku: string }) => [v.sku, v.id])
  )

  const unmatched = entries.filter((e) => !variantBySku.has(e.sku as string))
  if (unmatched.length) {
    logger.warn(
      `${unmatched.length} Artikelnummern haben keine Medusa-Variante, ` +
        `z.B.: ${unmatched.slice(0, 5).map((e) => e.sku).join(", ")}`
    )
  }

  // ─── Preise anderer Währungen erhalten ────────────────────────
  // Der Workflow ersetzt die Preisliste des Price Sets komplett.
  const link = container.resolve(ContainerRegistrationKeys.LINK) as {
    getLinkModule: (
      a: string,
      ak: string,
      b: string,
      bk: string
    ) => { list: (f: object, c: object) => Promise<Record<string, string>[]> }
  }

  const variantIds = [...variantBySku.values()]
  const links = await link
    .getLinkModule(Modules.PRODUCT, "variant_id", Modules.PRICING, "price_set_id")
    .list({ variant_id: variantIds }, { select: ["variant_id", "price_set_id"] })

  const pricingService = container.resolve(Modules.PRICING)
  const priceSetToVariant = new Map(
    links.map((l) => [l.price_set_id, l.variant_id])
  )

  const keepByVariant = new Map<string, PriceInput[]>()

  if (priceSetToVariant.size) {
    const existing = (await pricingService.listPrices(
      { price_set_id: [...priceSetToVariant.keys()] },
      {
        select: [
          "amount",
          "currency_code",
          "min_quantity",
          "max_quantity",
          "price_list_id",
          "price_set_id",
        ],
        take: null,
      }
    )) as unknown as {
      amount: number | string
      currency_code: string
      min_quantity: number | null
      max_quantity: number | null
      price_list_id: string | null
      price_set_id: string
    }[]

    for (const p of existing) {
      if (p.price_list_id || p.currency_code.toLowerCase() === currency) {
        continue
      }
      const variantId = priceSetToVariant.get(p.price_set_id)
      if (!variantId) {
        continue
      }
      const list = keepByVariant.get(variantId) ?? []
      list.push({
        amount: Number(p.amount),
        currency_code: p.currency_code,
        min_quantity: p.min_quantity,
        max_quantity: p.max_quantity,
      })
      keepByVariant.set(variantId, list)
    }
  }

  // ─── Payload bauen ────────────────────────────────────────────
  const payload: { id: string; prices: PriceInput[] }[] = []
  const skipped: string[] = []
  const flattened: string[] = []
  const preview = new Map<string, PriceInput[]>()
  let collapsed = 0

  for (const entry of entries) {
    const variantId = variantBySku.get(entry.sku as string)
    if (!variantId) {
      continue
    }

    const problem = validateTiers(entry.tiers)
    if (problem) {
      skipped.push(`${entry.sku}: ${problem}`)
      continue
    }

    const rounded: PriceInput[] = entry.tiers.map((t) => ({
      amount: roundTo(t.price, step),
      currency_code: currency,
      min_quantity: t.min_quantity,
      max_quantity: t.max_quantity,
    }))

    const prices = collapseEqual(rounded)
    if (prices.length < rounded.length) {
      collapsed += rounded.length - prices.length
    }

    // Nach dem Zusammenfassen kann eine einzige Stufe übrig bleiben — dann
    // ist der Mengenrabatt durch die Rundung komplett verschwunden.
    if (prices.length === 1) {
      flattened.push(entry.sku as string)
    }

    preview.set(entry.sku as string, prices)

    payload.push({
      id: variantId,
      prices: [...prices, ...(keepByVariant.get(variantId) ?? [])],
    })
  }

  if (skipped.length) {
    logger.warn(`${skipped.length} Artikel übersprungen:`)
    skipped.slice(0, 10).forEach((s) => logger.warn(`  ${s}`))
  }

  if (collapsed) {
    logger.info(
      `${collapsed} Staffeln fielen durch die Rundung auf ${step} mit der ` +
        `darunterliegenden zusammen und wurden verschmolzen.`
    )
  }

  if (flattened.length) {
    logger.warn(
      `${flattened.length} Artikel haben nach der Rundung gar keinen ` +
        `Mengenrabatt mehr (der Unterschied war kleiner als ${step}): ` +
        `${flattened.slice(0, 5).join(", ")}${flattened.length > 5 ? " …" : ""}`
    )
  }

  if (dryRun) {
    logger.info("— Probelauf, es wird nichts geschrieben —")
    for (const [sku, prices] of [...preview].slice(0, 10)) {
      const staffeln = prices
        .map(
          (p) =>
            `${p.min_quantity}${p.max_quantity ? `–${p.max_quantity}` : "+"}: ` +
            `${p.amount.toFixed(2)}`
        )
        .join("  |  ")
      logger.info(`  ${sku.padEnd(20)} ${staffeln}`)
    }
    if (preview.size > 10) {
      logger.info(`  … und ${preview.size - 10} weitere`)
    }
    logger.info(`Würde ${payload.length} Varianten aktualisieren.`)
    return
  }

  let done = 0
  for (const batch of chunk(payload, BATCH)) {
    await updateProductVariantsWorkflow(container).run({
      input: { product_variants: batch },
    })
    done += batch.length
    logger.info(`  ${done}/${payload.length} Varianten aktualisiert`)
  }

  logger.info(`Fertig. ${payload.length} Varianten mit Staffelpreisen versehen.`)
}
