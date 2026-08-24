/**
 * Erreichbarkeitsprüfung der Webhook-Adresse des zahls.ch-Plugins.
 *
 * zahls.ch prüft eine eingetragene Webhook-Adresse mit einem GET, bevor es
 * sie annimmt. Das Plugin nutzt Medusas eingebaute Route
 * POST /hooks/payment/zahls_zahls — die kennt kein GET, und genau daran ist
 * die Einrichtung schon einmal gescheitert («nicht gültig»). Die statische
 * GET-Route in src/api/hooks/payment/zahls_zahls/route.ts schliesst die
 * Lücke; dieser Test hält fest, dass sie 200 antwortet und dabei nichts
 * über den Zustand des Systems verrät (öffentliche, unauthentifizierte
 * Adresse).
 */

import { GET } from "../api/hooks/payment/zahls_zahls/route"

function makeRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /hooks/payment/zahls_zahls", () => {
  it("antwortet mit 200, damit zahls.ch die Adresse annimmt", async () => {
    const res = makeRes()
    await GET({} as any, res)
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("nennt die erwartete Methode", async () => {
    const res = makeRes()
    await GET({} as any, res)
    expect(res.json).toHaveBeenCalledWith({ status: "ok", accepts: "POST" })
  })

  it("verraet nichts ueber Zugangsdaten oder Konfiguration", async () => {
    const res = makeRes()
    await GET({} as any, res)
    const body = JSON.stringify(res.json.mock.calls[0][0]).toLowerCase()
    for (const leak of ["instance", "secret", "key", "redis", "postgres", "api"]) {
      expect(body).not.toContain(leak)
    }
  })
})
