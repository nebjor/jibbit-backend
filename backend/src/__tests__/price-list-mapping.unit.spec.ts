/**
 * Tests für die Zuordnung Odoo-Shop-Preise → Medusa-Katalog
 * (price-list-mapping.ts) und die Preisrechnung des Preislisten-Imports.
 *
 * Die Fixtures sind den echten Daten nachgebildet: die Namen auf jibbit.ch
 * weichen genau so vom Katalog ab (Gebinde als eigenes Produkt, [ref] im
 * Namen, Umformulierungen). Getestet wird die reine Logik — keine Datenbank.
 */

import {
  CatalogProduct,
  ShopPrice,
  buildImportPlan,
  diceSimilarity,
  matchShopPrices,
  normalizeName,
  parseOdooName,
  resolveVariant,
} from "../scripts/price-list-mapping"
import { roundTo, samePriceRows } from "../scripts/pricing-helpers"

// ─── Fixtures ────────────────────────────────────────────────────

const tiers = (...rows: [number, number | null, number][]) =>
  rows.map(([min, max, price]) => ({
    min_quantity: min,
    max_quantity: max,
    price,
  }))

const smokingBrown: CatalogProduct = {
  product: "Smoking Brown kurz (double window)",
  ref: null,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, 24, 1.9], [25, null, 1.7]),
    },
    {
      label: "Display (25 Stk.)",
      pack_type: "display",
      units_per_pack: 25,
      tiers: tiers([1, 1, 24], [2, null, 22]),
    },
  ],
}

const elementsBlue: CatalogProduct = {
  product: "Elements BLUE Rolls SW",
  ref: null,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, 23, 1.7], [24, null, 1.5]),
    },
    {
      label: "Box (24 Stk.)",
      pack_type: "box",
      units_per_pack: 24,
      tiers: tiers([1, 1, 33.6], [2, null, 31.2]),
    },
  ],
}

const rawClassic: CatalogProduct = {
  product: "RAW Classic Rolls Slim",
  ref: 4,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, null, 1.95]),
    },
  ],
}

const purizeXtraWhite: CatalogProduct = {
  product: "Purize Xtra SLIM White, 50er Pack, 5.9mm",
  ref: 6,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, null, 7.8]),
    },
  ],
}

const purizeXmas: CatalogProduct = {
  product: "PURIZE XTRA Slim XMAS ø 6mm",
  ref: null,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, null, 7.8]),
    },
  ],
}

const kailarSchwarz: CatalogProduct = {
  product: "Kailar Filter 5.9mm 65stk schwarz",
  ref: null,
  variants: [
    {
      label: "Einzeln",
      pack_type: "single",
      units_per_pack: 1,
      tiers: tiers([1, null, 8.5]),
    },
  ],
}

const catalog: CatalogProduct[] = [
  smokingBrown,
  elementsBlue,
  rawClassic,
  purizeXtraWhite,
  purizeXmas,
  kailarSchwarz,
]

const shop = (over: Partial<ShopPrice> & { odoo_name: string }): ShopPrice => ({
  odoo_template_id: 0,
  regular_price: 10,
  promo_price: 5,
  has_discount: true,
  ...over,
})

// ─── Namenszerlegung ─────────────────────────────────────────────

describe("parseOdooName", () => {
  it("liest die Artikelnummer aus [4] heraus", () => {
    expect(parseOdooName("[4] RAW Classic Rolls Slim")).toEqual({
      ref: "4",
      pack_type: "single",
      units: null,
      base: "RAW Classic Rolls Slim",
    })
  })

  it("erkennt Display-Produkte samt Stückzahl", () => {
    expect(
      parseOdooName("Display: 25x Smoking Brown kurz (double window)")
    ).toEqual({
      ref: null,
      pack_type: "display",
      units: 25,
      base: "Smoking Brown kurz (double window)",
    })
  })

  it("erkennt Box-Produkte", () => {
    expect(parseOdooName("Box: 24x Elements BLUE Rolls SW")).toEqual({
      ref: null,
      pack_type: "box",
      units: 24,
      base: "Elements BLUE Rolls SW",
    })
  })

  it("wirft den (Einzel)-Marker weg", () => {
    expect(parseOdooName("Angel Slim Filters (Einzel)").base).toBe(
      "Angel Slim Filters"
    )
  })
})

describe("normalizeName", () => {
  it("macht ø, Umlaute und Satzzeichen vergleichbar", () => {
    expect(normalizeName("dubi Aktivkohlefilter ø7mm")).toBe(
      "dubi aktivkohlefilter o7mm"
    )
    expect(normalizeName("PURIZE XTRA Slim XMAS ø 5,9mm")).toBe(
      "purize xtra slim xmas o 5 9mm"
    )
  })
})

// ─── Zuordnung ───────────────────────────────────────────────────

describe("matchShopPrices", () => {
  it("ordnet ein Display-Produkt der Display-Variante zu — der Kernfall", () => {
    const { matched, unmatched } = matchShopPrices(catalog, [
      shop({
        odoo_name: "Display: 25x Smoking Brown kurz (double window)",
        regular_price: 50,
        promo_price: 24,
      }),
    ])
    expect(unmatched).toHaveLength(0)
    expect(matched).toHaveLength(1)
    expect(matched[0].product.product).toBe("Smoking Brown kurz (double window)")
    expect(matched[0].variant.label).toBe("Display (25 Stk.)")
    expect(matched[0].level).toBe("exact")
  })

  it("ordnet ein Box-Produkt der Box-Variante zu", () => {
    const { matched } = matchShopPrices(catalog, [
      shop({
        odoo_name: "Box: 24x Elements BLUE Rolls SW",
        regular_price: 38.4,
        promo_price: 33.6,
      }),
    ])
    expect(matched[0].variant.label).toBe("Box (24 Stk.)")
    expect(matched[0].variant.pack_type).toBe("box")
  })

  it("findet Produkte über die Artikelnummer, auch wenn der Name abweicht", () => {
    const { matched } = matchShopPrices(catalog, [
      shop({ odoo_name: "[6] PURIZE White, 50er Pack", promo_price: 7.8 }),
    ])
    expect(matched[0].product.product).toBe(
      "Purize Xtra SLIM White, 50er Pack, 5.9mm"
    )
    expect(matched[0].level).toBe("ref")
  })

  it("ordnet umformulierte Namen unscharf zu und kennzeichnet das", () => {
    // Auf jibbit.ch heisst das Produkt anders als im Katalog.
    const { matched, unmatched } = matchShopPrices(catalog, [
      shop({
        odoo_name: "Smoking Brown Double Window",
        regular_price: 2,
        promo_price: 1.9,
      }),
    ])
    expect(unmatched).toHaveLength(0)
    expect(matched[0].product.product).toBe(
      "Smoking Brown kurz (double window)"
    )
    expect(matched[0].variant.label).toBe("Einzeln")
    expect(matched[0].level).toBe("fuzzy")
    expect(matched[0].score).toBeGreaterThan(0.65)
  })

  it("lässt den unscharfen Abgleich nicht auf bereits vergebene Varianten los", () => {
    // "PURIZE XTRA Slim XMAS ø 5,9mm" ähnelt der 50er-Pack-White — die ist
    // aber schon per [6] vergeben. Ohne diese Sperre wäre die Zuordnung
    // mehrdeutig und fiele weg.
    const { matched, unmatched } = matchShopPrices(catalog, [
      shop({ odoo_name: "[6] PURIZE White, 50er Pack", promo_price: 7.8 }),
      shop({ odoo_name: "PURIZE XTRA Slim XMAS ø 5,9mm", promo_price: 7.8 }),
    ])
    expect(unmatched).toHaveLength(0)
    const xmas = matched.find((m) => m.product.product.includes("XMAS"))
    expect(xmas).toBeDefined()
    expect(xmas?.level).toBe("fuzzy")
  })

  it("rät nicht, wenn nichts ähnlich genug ist — fehlendes Gegenstück", () => {
    const { matched, unmatched } = matchShopPrices(catalog, [
      shop({ odoo_name: "OCB Slim Filter Bio (120 Tips)" }),
    ])
    expect(matched).toHaveLength(0)
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0].reason).toContain("kein Katalogprodukt")
  })

  it("meldet ein Gebinde ohne passende Stückzahl statt es zu raten", () => {
    const { matched, unmatched } = matchShopPrices(catalog, [
      shop({ odoo_name: "Display: 99x Smoking Brown kurz (double window)" }),
    ])
    expect(matched).toHaveLength(0)
    expect(unmatched[0].reason).toContain("99")
  })

  it("warnt, wenn der Aktionspreis der Website vom Katalog abweicht", () => {
    const { matched } = matchShopPrices(catalog, [
      shop({
        odoo_name: "RAW Classic Rolls Slim",
        regular_price: 3.2,
        promo_price: 1.85, // Katalog sagt 1.95
      }),
    ])
    expect(matched[0].warnings.join(" ")).toContain("1.85")
    expect(matched[0].warnings.join(" ")).toContain("1.95")
  })

  it("warnt, wenn Odoo 'Display' sagt und der Katalog 'Box' — Stückzahl entscheidet", () => {
    const { matched } = matchShopPrices(catalog, [
      shop({
        odoo_name: "Display: 24x Elements BLUE Rolls SW",
        promo_price: 33.6,
      }),
    ])
    expect(matched).toHaveLength(1)
    expect(matched[0].variant.label).toBe("Box (24 Stk.)")
    expect(matched[0].warnings.join(" ")).toContain("Gebinde-Wort")
  })
})

describe("resolveVariant", () => {
  it("nimmt für Einzel-Produkte die Einzel-Variante", () => {
    const { variant } = resolveVariant(smokingBrown, {
      ref: null,
      pack_type: "single",
      units: null,
      base: "egal",
    })
    expect(variant?.label).toBe("Einzeln")
  })
})

describe("diceSimilarity", () => {
  it("hält verschiedene Produkte derselben Marke auseinander", () => {
    expect(
      diceSimilarity("PURIZE XTRA Slim XMAS ø 5,9mm", "Kailar Filter 5.9mm 65stk schwarz")
    ).toBeLessThan(0.5)
  })
})

// ─── Importplan: Rundung und Auslassungen ────────────────────────

describe("buildImportPlan", () => {
  it("rundet reguläre Preise auf 5 Rappen", () => {
    // Odoo liefert für das Zig-Zag-Display 40.800000000000004.
    const plan = buildImportPlan(
      [rawClassic],
      [
        shop({
          odoo_name: "RAW Classic Rolls Slim",
          regular_price: 3.22,
          promo_price: 1.95,
        }),
      ],
      0.05
    )
    expect(plan.planned[0].regular).toBe(3.2)
  })

  it("verschmilzt Staffeln, die durch die Rundung gleich werden", () => {
    const product: CatalogProduct = {
      product: "Testprodukt",
      ref: null,
      variants: [
        {
          label: "Einzeln",
          pack_type: "single",
          units_per_pack: 1,
          tiers: tiers([1, 9, 1.12], [10, null, 1.08]),
        },
      ],
    }
    const plan = buildImportPlan(
      [product],
      [shop({ odoo_name: "Testprodukt", regular_price: 2, promo_price: 1.12 })],
      0.05
    )
    expect(plan.planned[0].tiers).toEqual([
      {
        amount: 1.1,
        currency_code: "chf",
        min_quantity: 1,
        max_quantity: null,
      },
    ])
  })

  it("überspringt Artikel ohne Rabatt — nichts durchzustreichen", () => {
    const plan = buildImportPlan(
      [rawClassic],
      [
        shop({
          odoo_name: "RAW Classic Rolls Slim",
          regular_price: 1.95,
          promo_price: 1.95,
          has_discount: false,
        }),
      ],
      0.05
    )
    expect(plan.planned).toHaveLength(0)
    expect(plan.skipped).toHaveLength(1)
    // Aber nicht doppelt als "ohne Gegenstück" gemeldet:
    expect(
      plan.noRegular.some((n) => n.product === "RAW Classic Rolls Slim")
    ).toBe(false)
  })

  it("überspringt Datenfehler, bei denen regulär <= Aktion wäre", () => {
    const plan = buildImportPlan(
      [rawClassic],
      [
        shop({
          odoo_name: "RAW Classic Rolls Slim",
          regular_price: 1.5,
          promo_price: 1.95,
        }),
      ],
      0.05
    )
    expect(plan.planned).toHaveLength(0)
    expect(plan.skipped[0].reason).toContain("liegt nicht über")
  })

  it("listet Katalog-Varianten ohne Gegenstück auf jibbit.ch auf", () => {
    // Nur das Display ist im Shop — die Einzel-Variante behält ihre Preise.
    const plan = buildImportPlan(
      [smokingBrown],
      [
        shop({
          odoo_name: "Display: 25x Smoking Brown kurz (double window)",
          regular_price: 50,
          promo_price: 24,
        }),
      ],
      0.05
    )
    expect(plan.planned).toHaveLength(1)
    expect(plan.noRegular).toEqual([
      {
        product: "Smoking Brown kurz (double window)",
        variantLabel: "Einzeln",
      },
    ])
  })
})

// ─── Idempotenz-Entscheid ────────────────────────────────────────

describe("samePriceRows", () => {
  const base = [
    { amount: 2.5, currency_code: "chf", min_quantity: 1, max_quantity: null },
  ]

  it("erkennt den unveränderten Zustand — zweiter Lauf schreibt nichts", () => {
    expect(
      samePriceRows(base, [
        {
          amount: 2.5,
          currency_code: "chf",
          min_quantity: 1,
          max_quantity: null,
        },
      ])
    ).toBe(true)
  })

  it("ist unempfindlich gegen Reihenfolge", () => {
    const a = [
      { amount: 1.9, currency_code: "chf", min_quantity: 1, max_quantity: 24 },
      { amount: 1.7, currency_code: "chf", min_quantity: 25, max_quantity: null },
    ]
    expect(samePriceRows(a, [...a].reverse())).toBe(true)
  })

  it("behandelt fehlendes min_quantity wie 1", () => {
    expect(
      samePriceRows(base, [{ amount: 2.5, currency_code: "chf" }])
    ).toBe(true)
  })

  it("meldet jede echte Abweichung", () => {
    expect(
      samePriceRows(base, [
        { amount: 2.45, currency_code: "chf", min_quantity: 1, max_quantity: null },
      ])
    ).toBe(false)
    expect(samePriceRows(base, [])).toBe(false)
  })
})

describe("roundTo", () => {
  it("klopft Binärarithmetik-Reste fest", () => {
    expect(roundTo(40.800000000000004, 0.05)).toBe(40.8)
    expect(roundTo(1.175, 0.05)).toBe(1.2)
  })
})
