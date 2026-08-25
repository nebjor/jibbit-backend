/**
 * Fehler der Payrexx-API muessen den Grund mitbringen.
 *
 * Vorher stand im Log ausschliesslich «Request failed with status code 403» —
 * Axios' Standardmeldung. Payrexx legt den Grund in den Antwortkoerper, und
 * der wurde verworfen. Ein 403 konnte damit ebenso gut ein falscher
 * Schluessel, eine falsche Instanz oder der falsche Host sein; die
 * Fehlersuche lief entsprechend blind.
 *
 * Der zweite Test ist der wichtigere: die Adresse darf NICHT mit
 * Query-String protokolliert werden, denn dort steht die `ApiSignature`.
 */

import { PayrexxClient } from "../modules/payrexx/client"

function interceptorOf(client: PayrexxClient) {
  // Der Interceptor haengt an der internen axios-Instanz.
  const http = (client as unknown as { httpClient: any }).httpClient
  const handlers = http.interceptors.response.handlers
  return handlers[handlers.length - 1].rejected as (e: unknown) => Promise<never>
}

const client = new PayrexxClient({ instance: "jibbit", apiSecret: "s3cr3t" })

async function messageFor(error: unknown): Promise<string> {
  try {
    await interceptorOf(client)(error)
    throw new Error("Interceptor haette ablehnen muessen")
  } catch (e) {
    return (e as Error).message
  }
}

describe("Fehlermeldungen der Payrexx-API", () => {
  it("nennt Status, Methode und den Grund aus dem Antwortkoerper", async () => {
    const msg = await messageFor({
      response: {
        status: 403,
        data: { status: "error", message: "Invalid signature" },
      },
      config: { method: "post", url: "Gateway/?instance=jibbit" },
      message: "Request failed with status code 403",
    })

    expect(msg).toContain("403")
    expect(msg).toContain("POST")
    expect(msg).toContain("Invalid signature")
  })

  it("protokolliert die ApiSignature NICHT mit", async () => {
    const msg = await messageFor({
      response: { status: 403, data: { message: "nope" } },
      config: {
        method: "get",
        url: "Gateway/42/?instance=jibbit&ApiSignature=SUPERGEHEIM%3D%3D",
      },
      message: "Request failed with status code 403",
    })

    expect(msg).not.toContain("ApiSignature")
    expect(msg).not.toContain("SUPERGEHEIM")
    expect(msg).toContain("Gateway/42/")
  })

  it("deckelt einen ausufernden Antwortkoerper", async () => {
    const msg = await messageFor({
      response: { status: 500, data: "x".repeat(5000) },
      config: { method: "post", url: "Gateway/" },
      message: "Request failed with status code 500",
    })

    expect(msg.length).toBeLessThan(600)
  })

  it("laesst Fehler ohne Antwort unveraendert (Zeitueberschreitung, DNS)", async () => {
    const msg = await messageFor({ message: "connect ETIMEDOUT" })
    expect(msg).toBe("connect ETIMEDOUT")
  })
})
