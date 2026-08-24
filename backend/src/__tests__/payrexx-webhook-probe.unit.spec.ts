/**
 * Die Erreichbarkeitsprüfung der Webhook-Route.
 *
 * Hintergrund: zahls.ch wies die eingetragene Adresse als «nicht gültig»
 * zurück. Ursache war nicht die Adresse, sondern dass die Route
 * ausschliesslich POST kannte — die Prüfung des Anbieters ist ein GET und
 * lief damit in Medusas 404.
 *
 * Dieser Test hält zwei Dinge fest: dass GET mit 200 antwortet, und dass die
 * Antwort NICHTS über den Zustand des Systems verrät. Die Adresse ist
 * öffentlich und unauthentifiziert.
 */

import { GET } from "../api/hooks/payment/payrexx/route"

function makeRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe("GET /hooks/payment/payrexx", () => {
  it("antwortet mit 200, damit der Anbieter die Adresse annimmt", async () => {
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
    for (const leak of [
      "secret",
      "instance",
      "configured",
      "redis",
      "payrexx.com",
      "zahls",
      "psp",
      "token",
    ]) {
      expect(body).not.toContain(leak)
    }
  })

  it("kommt ohne die Payrexx-Laufzeit aus — keine Seiteneffekte", async () => {
    // Ein leeres Request-Objekt ohne `scope` genuegt. Griffe der Handler auf
    // den Container oder die Laufzeit zu, wuerde das hier werfen.
    const res = makeRes()
    await expect(GET({} as any, res)).resolves.toBeUndefined()
  })
})
