import {
  sperreAlsGeliefertMarkieren,
  ZUGESTELLT_NICHT_VERWENDET,
} from "../lib/zugestellt-schutz"
import middlewares from "../api/middlewares"

describe("Sperre «Als geliefert markieren»", () => {
  it("antwortet 403 mit deutscher Meldung und ruft next nicht auf", () => {
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const next = jest.fn()
    sperreAlsGeliefertMarkieren({} as any, { status } as any, next)
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({
      type: "not_allowed",
      message: ZUGESTELLT_NICHT_VERWENDET,
    })
    expect(ZUGESTELLT_NICHT_VERWENDET).toMatch(/nicht verwendet/)
    expect(next).not.toHaveBeenCalled()
  })

  it("hängt an der Route mark-as-delivered (nur POST)", () => {
    const route = (middlewares as any).routes.find((r: any) =>
      String(r.matcher).endsWith("/mark-as-delivered")
    )
    expect(route.matcher).toBe(
      "/admin/orders/:id/fulfillments/:fulfillment_id/mark-as-delivered"
    )
    expect([route.method, route.methods].flat()).toContain("POST")
    expect(route.middlewares).toContain(sperreAlsGeliefertMarkieren)
  })
})
