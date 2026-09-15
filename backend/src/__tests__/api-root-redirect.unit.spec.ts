/**
 * Die Wurzel der API-Domain leitet ins Admin-Dashboard.
 *
 * Regression: `https://api-test.jibbit.ch/` antwortete mit Express' nacktem
 * «Cannot GET /». Wer die Adresse eintippt, soll bei der Anmeldung landen.
 */

import { GET } from "../api/route"

function makeRes() {
  const res: any = {}
  res.redirect = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /", () => {
  it("leitet auf /app", async () => {
    const res = makeRes()
    await GET({} as any, res)
    expect(res.redirect).toHaveBeenCalledWith(302, "/app")
  })

  it("leitet VORUEBERGEHEND (302), damit das Ziel aenderbar bleibt", async () => {
    const res = makeRes()
    await GET({} as any, res)
    const [status] = res.redirect.mock.calls[0]
    expect(status).toBe(302)
    expect(status).not.toBe(301)
  })

  it("zeigt auf /app, nicht auf /app/login — /app entscheidet selbst", async () => {
    const res = makeRes()
    await GET({} as any, res)
    expect(res.redirect.mock.calls[0][1]).toBe("/app")
  })

  it("braucht weder Container noch Anfragedaten", async () => {
    const res = makeRes()
    await expect(GET({} as any, res)).resolves.toBeUndefined()
  })
})
