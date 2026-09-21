/**
 * product-thumbnail — leere Vorschaubilder aus der Galerie füllen.
 *
 * updateProductsWorkflow ist gemockt: die Tests prüfen, WAS geschrieben würde,
 * ohne Datenbank. Die drei Zusicherungen, an denen alles hängt:
 *
 *   1. leeres Thumbnail + Bilder  -> erstes Bild wird eingesetzt
 *   2. gesetztes Thumbnail        -> bleibt unangetastet
 *   3. keine Bilder               -> nichts passiert
 */

const runMock = jest.fn(async () => ({ result: [] as any[] }))

jest.mock("@medusajs/medusa/core-flows", () => ({
  updateProductsWorkflow: jest.fn(() => ({ run: runMock })),
}))

import { updateProductsWorkflow } from "@medusajs/medusa/core-flows"

import {
  backfillProductThumbnails,
  firstImageUrl,
  hasThumbnail,
  planThumbnailBackfill,
  ProductThumbnailRow,
} from "../lib/product-thumbnail"

// ─── Bausteine ──────────────────────────────────────────────────

const img = (url: string, rank?: number) => ({ url, rank })

const product = (
  id: string,
  thumbnail: string | null,
  images: { url?: string | null; rank?: number | null }[]
): ProductThumbnailRow => ({ id, thumbnail, images })

/** Container-Attrappe: query.graph liefert die übergebenen Produkte. */
const containerWith = (products: ProductThumbnailRow[]) => {
  const graph = jest.fn(async () => ({ data: products }))
  return {
    container: { resolve: jest.fn(() => ({ graph })) } as any,
    graph,
  }
}

afterEach(() => {
  jest.clearAllMocks()
})

// ─── hasThumbnail ───────────────────────────────────────────────

describe("hasThumbnail", () => {
  it("null, undefined und Leerstring gelten als leer", () => {
    expect(hasThumbnail(null)).toBe(false)
    expect(hasThumbnail(undefined)).toBe(false)
    expect(hasThumbnail("")).toBe(false)
    expect(hasThumbnail("   ")).toBe(false)
  })

  it("eine URL gilt als gesetzt", () => {
    expect(hasThumbnail("https://api.jibbit.ch/static/a.webp")).toBe(true)
  })
})

// ─── firstImageUrl ──────────────────────────────────────────────

describe("firstImageUrl", () => {
  it("nimmt das Bild mit dem kleinsten rank, nicht das erste der Liste", () => {
    // Die Zeilenreihenfolge aus der Datenbank ist nach einem Update nicht
    // garantiert — massgeblich ist rank (die Sortierung im Admin).
    const row = product("p1", null, [
      img("https://x/second.webp", 1),
      img("https://x/first.webp", 0),
    ])
    expect(firstImageUrl(row)).toBe("https://x/first.webp")
  })

  it("überspringt Bilder ohne brauchbare URL", () => {
    const row = product("p1", null, [
      { url: "", rank: 0 },
      { url: null, rank: 1 },
      img("https://x/real.webp", 2),
    ])
    expect(firstImageUrl(row)).toBe("https://x/real.webp")
  })

  it("liefert null ohne Bilder", () => {
    expect(firstImageUrl(product("p1", null, []))).toBeNull()
    expect(firstImageUrl({ id: "p1", thumbnail: null, images: null })).toBeNull()
  })
})

// ─── planThumbnailBackfill ──────────────────────────────────────

describe("planThumbnailBackfill", () => {
  it("füllt ein leeres Thumbnail mit dem ersten Bild", () => {
    const plan = planThumbnailBackfill([
      product("p1", null, [img("https://x/a.webp", 0), img("https://x/b.webp", 1)]),
    ])
    expect(plan).toEqual([{ id: "p1", thumbnail: "https://x/a.webp" }])
  })

  it("auch ein Leerstring-Thumbnail gilt als leer und wird gefüllt", () => {
    const plan = planThumbnailBackfill([
      product("p1", "", [img("https://x/a.webp", 0)]),
    ])
    expect(plan).toEqual([{ id: "p1", thumbnail: "https://x/a.webp" }])
  })

  it("lässt ein gesetztes Thumbnail unangetastet", () => {
    // Der Betreiber hat absichtlich das dritte Bild gewählt — das bleibt so,
    // auch wenn es nicht das erste der Galerie ist.
    const plan = planThumbnailBackfill([
      product("p1", "https://x/drittes-bild.webp", [
        img("https://x/a.webp", 0),
        img("https://x/b.webp", 1),
        img("https://x/drittes-bild.webp", 2),
      ]),
    ])
    expect(plan).toEqual([])
  })

  it("ändert nichts an einem Produkt ohne Bilder", () => {
    const plan = planThumbnailBackfill([product("p1", null, [])])
    expect(plan).toEqual([])
  })

  it("mischt korrekt: nur die lückenhaften Produkte tauchen im Plan auf", () => {
    const plan = planThumbnailBackfill([
      product("ohne-bilder", null, []),
      product("hat-schon", "https://x/gewaehlt.webp", [img("https://x/a.webp", 0)]),
      product("braucht", null, [img("https://x/b.webp", 0)]),
    ])
    expect(plan).toEqual([{ id: "braucht", thumbnail: "https://x/b.webp" }])
  })
})

// ─── backfillProductThumbnails ──────────────────────────────────

describe("backfillProductThumbnails", () => {
  it("schreibt fehlende Thumbnails über updateProductsWorkflow — und NUR thumbnail", async () => {
    const { container } = containerWith([
      product("p1", null, [img("https://x/a.webp", 0)]),
      product("p2", "https://x/gesetzt.webp", [img("https://x/c.webp", 0)]),
    ])

    const filled = await backfillProductThumbnails(container)

    expect(filled).toBe(1)
    expect(updateProductsWorkflow).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({
      // Kein `images` im Update: sonst würde der Lauf Bildzeilen löschen,
      // neu anlegen oder umsortieren.
      input: { products: [{ id: "p1", thumbnail: "https://x/a.webp" }] },
    })
  })

  it("schreibt gar nichts, wenn nichts zu füllen ist", async () => {
    const { container } = containerWith([
      product("p1", "https://x/gesetzt.webp", [img("https://x/a.webp", 0)]),
      product("p2", null, []),
    ])

    const filled = await backfillProductThumbnails(container)

    expect(filled).toBe(0)
    expect(runMock).not.toHaveBeenCalled()
  })

  it("filtert auf die übergebenen Produkt-IDs", async () => {
    const { container, graph } = containerWith([])

    await backfillProductThumbnails(container, ["p1", "p2"])

    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { id: ["p1", "p2"] } })
    )
  })

  it("fragt bei leerer ID-Liste gar nicht erst ab", async () => {
    const { container, graph } = containerWith([])

    const filled = await backfillProductThumbnails(container, [])

    expect(filled).toBe(0)
    expect(graph).not.toHaveBeenCalled()
  })
})
