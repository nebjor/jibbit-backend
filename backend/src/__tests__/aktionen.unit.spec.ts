/**
 * Aktionen-Mapping: laufend, beendet, noch nicht gestartet, ohne Kampagne,
 * nicht automatisch, Teilsortiment und Titel-Fallback.
 */
import { mappeAktion, mappeAktionen, RohPromotion } from "../lib/aktionen"
import { GET } from "../api/store/aktionen/route"

const JETZT = new Date("2026-10-29T20:00:00Z")

function promo(p: Partial<RohPromotion> = {}): RohPromotion {
  return {
    code: "EROEFFNUNG20",
    is_automatic: true,
    status: "active",
    type: "standard",
    campaign: {
      name: "Eröffnung",
      starts_at: "2026-10-29T18:30:00Z",
      ends_at: "2026-10-30T18:30:00Z",
    },
    application_method: {
      type: "percentage",
      value: 20,
      target_type: "items",
      allocation: "across",
      target_rules: [],
    },
    ...p,
  }
}

describe("mappeAktion", () => {
  it("gibt eine laufende Aktion mit Zeitfenster aus", () => {
    expect(mappeAktion(promo(), JETZT)).toEqual({
      code: "EROEFFNUNG20",
      titel: "Eröffnung",
      prozent: 20,
      gilt_ab: "2026-10-29T18:30:00.000Z",
      gilt_bis: "2026-10-30T18:30:00.000Z",
      nur_teilsortiment: false,
      auf_artikel: true,
    })
  })

  it("blendet beendete Aktionen aus", () => {
    expect(mappeAktion(promo(), new Date("2026-10-30T18:30:00Z"))).toBeNull()
  })

  it("blendet noch nicht gestartete Aktionen aus", () => {
    expect(mappeAktion(promo(), new Date("2026-10-29T18:00:00Z"))).toBeNull()
  })

  it("zeigt Aktionen ohne Kampagne unbefristet mit Titel-Fallback", () => {
    const a = mappeAktion(promo({ campaign: null }), JETZT)
    expect(a).toMatchObject({ gilt_ab: null, gilt_bis: null, titel: "20 % auf alles" })
  })

  it("filtert nicht automatische Codes", () => {
    expect(mappeAktion(promo({ is_automatic: false }), JETZT)).toBeNull()
  })

  it("filtert inaktive und Entwurfs-Promotionen", () => {
    expect(mappeAktion(promo({ status: "draft" }), JETZT)).toBeNull()
    expect(mappeAktion(promo({ status: "inactive" }), JETZT)).toBeNull()
  })

  it("filtert buyget-Promotionen", () => {
    expect(mappeAktion(promo({ type: "buyget" }), JETZT)).toBeNull()
  })

  it("markiert Zielregeln als Teilsortiment", () => {
    const p = promo()
    p.application_method!.target_rules = [{ id: "r1" }]
    expect(mappeAktion(p, JETZT)?.nur_teilsortiment).toBe(true)
  })

  it("gibt Fixbeträge mit Währung aus", () => {
    const p = promo({
      campaign: null,
      application_method: {
        type: "fixed",
        value: "5",
        currency_code: "chf",
        target_type: "order",
      },
    })
    expect(mappeAktion(p, JETZT)).toMatchObject({
      betrag: 5,
      waehrung: "CHF",
      titel: "CHF 5 Rabatt",
    })
  })

  it("verwirft Promotionen ohne positiven Wert", () => {
    const p = promo()
    p.application_method!.value = 0
    expect(mappeAktion(p, JETZT)).toBeNull()
  })
})

describe("mappeAktionen", () => {
  it("sortiert nach Ende und lässt unbefristete zuletzt", () => {
    const spaet = promo({ code: "B", campaign: { name: "B", ends_at: "2026-11-05T00:00:00Z" } })
    const frueh = promo({ code: "A" })
    const offen = promo({ code: "C", campaign: null })
    const codes = mappeAktionen(
      [offen, spaet, frueh, promo({ code: "X", is_automatic: false })],
      JETZT
    ).map((a) => a.code)
    expect(codes).toEqual(["A", "B", "C"])
  })
})

describe("GET /store/aktionen", () => {
  it("setzt den Cache-Header und fragt nur aktive automatische Promotionen ab", async () => {
    const graph = jest.fn().mockResolvedValue({ data: [promo({ campaign: null })] })
    const headers: Record<string, string> = {}
    let body: any
    const res: any = {
      setHeader: (k: string, v: string) => {
        headers[k] = v
      },
      json: (b: unknown) => {
        body = b
      },
    }
    await GET({ scope: { resolve: () => ({ graph }) } } as any, res)
    expect(graph.mock.calls[0][0].filters).toEqual({ status: "active", is_automatic: true })
    expect(headers["Cache-Control"]).toBe("public, max-age=60")
    expect(body.aktionen).toHaveLength(1)
  })
})
