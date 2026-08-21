/**
 * Durchstich gegen einen NACHGEBAUTEN zahls.ch-Server.
 *
 * zahls.ch ist ein White-Label der Payrexx-Plattform (Betreiber: siebenberge
 * gmbh). Das offizielle zahls.ch-WooCommerce-Plugin bündelt den
 * Payrexx-PHP-Client mit `API_URL_BASE_DOMAIN = 'zahls.ch'` — dieselbe
 * REST API v1.0, nur unter `https://api.zahls.ch/`. Genau das bildet dieser
 * Test nach: ein lokaler HTTP-Server, der sich verhält wie api.zahls.ch
 * (inklusive Prüfung der ApiSignature), und das Modul läuft mit
 * `apiBaseUrl` dagegen — kein einziger Request darf api.payrexx.com treffen.
 *
 * Durchgespielt wird, was der Betreiber im Testmodus durchspielen soll:
 *
 *   1. Gateway anlegen (initiatePayment) — Betrag in Rappen, signiert,
 *      richtige Instanz, Redirect-Link kommt zurück
 *   2. Webhook mit GÜLTIGER Signatur → Bestellung wird abgeschlossen
 *   3. Webhook-Retry → Duplikat, nichts passiert doppelt
 *   4. Webhook mit GEFÄLSCHTER Signatur → 401, keine Verarbeitung
 *   5. Rückkehr-Abgleich → gleiche Idempotenz wie der Webhook
 *   6. Betragsabgleich: ein signierter Webhook mit falschem Betrag wird
 *      NICHT verarbeitet, sondern laut zur manuellen Prüfung gemeldet
 *
 * Zusätzlich: die Normalisierung von PAYREXX_API_BASE_URL selbst.
 */

const workflowRun = jest.fn()
jest.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflow: jest.fn(() => ({ run: workflowRun })),
}))

import crypto from "crypto"
import http from "http"
import { AddressInfo } from "net"
import {
  PayrexxClient,
  DEFAULT_PAYREXX_API_BASE_URL,
  normalizePayrexxApiBaseUrl,
} from "../modules/payrexx/client"
import PayrexxPaymentProviderService from "../modules/payrexx/service"
import { handlePayrexxWebhook } from "../api/hooks/payment/payrexx/route"
import { handlePayrexxReturn } from "../api/store/payrexx/return/route"
import { InMemoryIdempotencyStore } from "../modules/payrexx/idempotency-store"
import { InMemorySessionStateStore } from "../modules/payrexx/session-store"
import type { PayrexxRuntime } from "../modules/payrexx/runtime"
import { Modules } from "@medusajs/framework/utils"

const INSTANCE = "jibbit"
const API_SECRET = "zahls_test_api_secret_not_a_real_one"
const WEBHOOK_SECRET = "zahls_test_webhook_secret_32chars!"

// ─── Der nachgebaute zahls.ch-API-Server ────────────────────────────────────

interface MockGateway {
  id: number
  hash: string
  link: string
  status: string
  referenceId: string
  amount: number
  currency: string
  transaction?: { id: number; status: string; amount: number }
}

class MockZahlsServer {
  readonly gateways = new Map<number, MockGateway>()
  /** Requests, die an der Signaturprüfung gescheitert sind. */
  readonly rejectedRequests: string[] = []
  readonly seenPaths: string[] = []
  private server!: http.Server
  private nextId = 4000
  private nextTxId = 7000

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.route(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}/v1.0/`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    )
  }

  /** Simuliert den Kunden, der auf der zahls.ch-Seite (Testmodus) bezahlt. */
  pay(gatewayId: number, status = "confirmed", amountOverride?: number): number {
    const gw = this.gateways.get(gatewayId)
    if (!gw) throw new Error(`mock: no gateway ${gatewayId}`)
    const txId = this.nextTxId++
    gw.transaction = {
      id: txId,
      status,
      amount: amountOverride ?? gw.amount,
    }
    gw.status = status
    return txId
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const url = new URL(req.url ?? "/", "http://mock")
      this.seenPaths.push(`${req.method} ${url.pathname}`)

      // Wie das echte API: die Instanz muss stimmen.
      if (url.searchParams.get("instance") !== INSTANCE) {
        this.reject(res, `wrong instance '${url.searchParams.get("instance")}'`)
        return
      }

      const createMatch = url.pathname === "/v1.0/Gateway/"
      const gatewayMatch = url.pathname.match(/^\/v1\.0\/Gateway\/(\d+)\/$/)

      if (req.method === "POST" && createMatch) {
        this.createGateway(body, res)
        return
      }
      if (req.method === "GET" && gatewayMatch) {
        this.retrieveGateway(Number(gatewayMatch[1]), url, res)
        return
      }
      if (req.method === "DELETE" && gatewayMatch) {
        this.gateways.delete(Number(gatewayMatch[1]))
        this.json(res, 200, { status: "success", data: [] })
        return
      }
      this.json(res, 404, { status: "error", message: "no such route" })
    })
  }

  /**
   * POST Gateway/ — prüft die ApiSignature exakt so, wie die Plattform es
   * spezifiziert: BASE64-HMAC-SHA256 über den RFC-1738-kodierten Query-String
   * OHNE den Parameter ApiSignature (und ohne `instance`, das nur in der URL
   * steht).
   */
  private createGateway(body: string, res: http.ServerResponse): void {
    const marker = "&ApiSignature="
    const idx = body.lastIndexOf(marker)
    if (idx < 0) {
      this.reject(res, "missing ApiSignature")
      return
    }
    const queryString = body.slice(0, idx)
    const providedSignature = decodeURIComponent(body.slice(idx + marker.length))
    const expected = crypto
      .createHmac("sha256", API_SECRET)
      .update(queryString)
      .digest("base64")
    if (providedSignature !== expected) {
      this.reject(res, "bad ApiSignature on create")
      return
    }

    const params = new URLSearchParams(queryString)
    const id = this.nextId++
    const gateway: MockGateway = {
      id,
      hash: `hash_${id}`,
      link: `https://jibbit.zahls.ch/?payment=hash_${id}`,
      status: "waiting",
      referenceId: params.get("referenceId") ?? "",
      amount: Number(params.get("amount")),
      currency: params.get("currency") ?? "",
    }
    this.gateways.set(id, gateway)
    this.json(res, 200, { status: "success", data: [this.serialize(gateway)] })
  }

  private retrieveGateway(
    id: number,
    url: URL,
    res: http.ServerResponse
  ): void {
    // GET signiert den leeren Query-String.
    const expected = crypto
      .createHmac("sha256", API_SECRET)
      .update("")
      .digest("base64")
    if (url.searchParams.get("ApiSignature") !== expected) {
      this.reject(res, "bad ApiSignature on retrieve")
      return
    }
    const gw = this.gateways.get(id)
    if (!gw) {
      this.json(res, 404, { status: "error", message: "no such gateway" })
      return
    }
    this.json(res, 200, { status: "success", data: [this.serialize(gw)] })
  }

  private serialize(gw: MockGateway) {
    return {
      id: gw.id,
      hash: gw.hash,
      link: gw.link,
      status: gw.status,
      referenceId: gw.referenceId,
      invoices: gw.transaction
        ? [
            {
              transactions: [
                {
                  id: gw.transaction.id,
                  status: gw.transaction.status,
                  amount: gw.transaction.amount,
                  referenceId: gw.referenceId,
                },
              ],
            },
          ]
        : [],
    }
  }

  private reject(res: http.ServerResponse, reason: string): void {
    this.rejectedRequests.push(reason)
    this.json(res, 401, { status: "error", message: reason })
  }

  private json(res: http.ServerResponse, code: number, payload: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json" })
    res.end(JSON.stringify(payload))
  }
}

// ─── Test-Gerüst ────────────────────────────────────────────────────────────

function loggerMock() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as any
}

function makeRes() {
  const res: any = {}
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((body: unknown) => {
    res.payload = body
    return res
  })
  return res
}

function signWebhook(payload: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")
}

function webhookRequest(body: string, signature: string): any {
  return {
    rawBody: body,
    body: JSON.parse(body),
    headers: { "x-webhook-signature": signature },
    scope: { resolve: jest.fn(() => loggerMock()) },
  }
}

describe("zahls.ch mock server end-to-end", () => {
  const mock = new MockZahlsServer()
  let baseUrl: string
  let service: PayrexxPaymentProviderService & {
    webhookProcessor: any
  }
  let runtime: PayrexxRuntime
  let logger: any

  beforeAll(async () => {
    baseUrl = await mock.start()
    logger = loggerMock()

    const ServiceCtor = PayrexxPaymentProviderService as any
    service = new ServiceCtor(
      {
        logger,
        idempotencyStore: new InMemoryIdempotencyStore(),
        sessionStateStore: new InMemorySessionStateStore(),
      },
      {
        instance: INSTANCE,
        apiSecret: API_SECRET,
        webhookSecret: WEBHOOK_SECRET,
        enabledPsps: [1],
        apiBaseUrl: baseUrl,
      }
    )

    runtime = {
      configured: true,
      client: new PayrexxClient({
        instance: INSTANCE,
        apiSecret: API_SECRET,
        baseUrl,
      }),
      processor: service.webhookProcessor,
    }
  })

  afterAll(async () => {
    await mock.stop()
  })

  beforeEach(() => {
    workflowRun.mockReset()
    workflowRun.mockResolvedValue({ errors: [] })
  })

  it("legt den Gateway auf dem zahls-Host an — signiert, in Rappen, mit Redirect-Link", async () => {
    const result = await service.initiatePayment({
      amount: 27.9, // Dezimal-CHF aus Medusa
      currency_code: "chf",
      context: {},
      data: { session_id: "payses_zahls_1" },
    } as any)

    expect(mock.rejectedRequests).toEqual([])
    expect(mock.seenPaths).toContain("POST /v1.0/Gateway/")

    const gatewayId = Number(result.id)
    const gw = mock.gateways.get(gatewayId)!
    expect(gw.amount).toBe(2790) // Rappen, nicht Dezimal
    expect(gw.currency).toBe("CHF")
    expect(gw.referenceId).toBe("payses_zahls_1")
    expect((result.data as any).link).toBe(
      `https://jibbit.zahls.ch/?payment=hash_${gatewayId}`
    )
  })

  it("verarbeitet einen korrekt signierten Webhook genau einmal", async () => {
    const init = await service.initiatePayment({
      amount: 42,
      currency_code: "chf",
      context: {},
      data: { session_id: "payses_zahls_2" },
    } as any)
    const gatewayId = Number(init.id)
    const txId = mock.pay(gatewayId)

    const body = JSON.stringify({
      transaction: {
        id: txId,
        status: "confirmed",
        amount: 4200,
        referenceId: "payses_zahls_2",
      },
    })

    // Gültige Signatur → 200, Bestellung wird abgeschlossen
    const res = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(body, signWebhook(body)),
      res,
      runtime,
      logger
    )
    expect(res.statusCode).toBe(200)
    expect(workflowRun).toHaveBeenCalledTimes(1)
    expect(workflowRun.mock.calls[0][0].input.action).toBe("authorized")

    // Retry desselben Webhooks → Duplikat, keine zweite Verarbeitung
    const retryRes = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(body, signWebhook(body)),
      retryRes,
      runtime,
      logger
    )
    expect(retryRes.statusCode).toBe(200)
    expect(retryRes.payload).toEqual({ status: "duplicate" })
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })

  it("weist einen Webhook mit gefälschter Signatur mit 401 ab", async () => {
    const body = JSON.stringify({
      transaction: {
        id: 999999,
        status: "confirmed",
        amount: 4200,
        referenceId: "payses_zahls_2",
      },
    })
    const res = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(body, "0".repeat(64)),
      res,
      runtime,
      logger
    )
    expect(res.statusCode).toBe(401)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("Rückkehr-Abgleich fragt den zahls-Host ab und teilt sich die Idempotenz mit dem Webhook", async () => {
    const sessionId = "payses_zahls_3"
    const init = await service.initiatePayment({
      amount: 15.5,
      currency_code: "chf",
      context: {},
      data: { session_id: sessionId },
    } as any)
    const gatewayId = Number(init.id)
    const txId = mock.pay(gatewayId)

    const scope = {
      resolve: jest.fn((key: string) => {
        if (key === Modules.PAYMENT) {
          return {
            listPaymentSessions: jest.fn(async () => [
              {
                id: sessionId,
                provider_id: "pp_payrexx_payrexx",
                data: { id: gatewayId },
              },
            ]),
          }
        }
        return logger
      }),
    }

    // 1. Kunde kommt zurück → Rückkehr-Route schliesst ab
    const res = makeRes()
    await handlePayrexxReturn(
      { body: { payment_session_id: sessionId }, scope } as any,
      res,
      runtime,
      logger
    )
    expect(res.statusCode).toBe(200)
    expect(res.payload.status).toBe("authorized")
    expect(workflowRun).toHaveBeenCalledTimes(1)

    // 2. Der Webhook trifft später ein → Duplikat, kein zweiter Abschluss
    const body = JSON.stringify({
      transaction: {
        id: txId,
        status: "confirmed",
        amount: 1550,
        referenceId: sessionId,
      },
    })
    const hookRes = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(body, signWebhook(body)),
      hookRes,
      runtime,
      logger
    )
    expect(hookRes.statusCode).toBe(200)
    expect(hookRes.payload).toEqual({ status: "duplicate" })
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })

  it("Betragsabgleich: signierter Webhook mit falschem Betrag wird nicht verarbeitet", async () => {
    const sessionId = "payses_zahls_4"
    const init = await service.initiatePayment({
      amount: 100,
      currency_code: "chf",
      context: {},
      data: { session_id: sessionId },
    } as any)
    const gatewayId = Number(init.id)
    const txId = mock.pay(gatewayId, "confirmed", 100) // Kunde zahlte 1.00 statt 100.00

    const body = JSON.stringify({
      transaction: {
        id: txId,
        status: "confirmed",
        amount: 100, // Rappen — weicht von den erwarteten 10000 ab
        referenceId: sessionId,
      },
    })
    const res = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(body, signWebhook(body)),
      res,
      runtime,
      logger
    )

    // 200 (kein Retry sinnvoll), aber KEIN Abschluss — nur die laute Meldung.
    expect(res.statusCode).toBe(200)
    expect(workflowRun).not.toHaveBeenCalled()
    const errorLogs = (logger.error as jest.Mock).mock.calls.flat().join("\n")
    expect(errorLogs).toContain("AMOUNT MISMATCH")
  })
})

describe("normalizePayrexxApiBaseUrl", () => {
  it("fällt ohne Wert auf api.payrexx.com zurück", () => {
    expect(normalizePayrexxApiBaseUrl(undefined)).toBe(DEFAULT_PAYREXX_API_BASE_URL)
    expect(normalizePayrexxApiBaseUrl("")).toBe(DEFAULT_PAYREXX_API_BASE_URL)
    expect(normalizePayrexxApiBaseUrl("   ")).toBe(DEFAULT_PAYREXX_API_BASE_URL)
  })

  it("akzeptiert den zahls.ch-Host und ergänzt den fehlenden Slash", () => {
    expect(normalizePayrexxApiBaseUrl("https://api.zahls.ch/v1.0/")).toBe(
      "https://api.zahls.ch/v1.0/"
    )
    expect(normalizePayrexxApiBaseUrl("https://api.zahls.ch/v1.0")).toBe(
      "https://api.zahls.ch/v1.0/"
    )
  })

  it("erlaubt http nur für localhost (Tests gegen den Mock-Server)", () => {
    expect(normalizePayrexxApiBaseUrl("http://127.0.0.1:4242/v1.0/")).toBe(
      "http://127.0.0.1:4242/v1.0/"
    )
    expect(() =>
      normalizePayrexxApiBaseUrl("http://api.zahls.ch/v1.0/")
    ).toThrow(/https/)
  })

  it("weist Unbrauchbares beim Start ab, nicht erst beim Bezahlen", () => {
    expect(() => normalizePayrexxApiBaseUrl("api.zahls.ch")).toThrow(/not a valid URL/)
    expect(() => normalizePayrexxApiBaseUrl("ftp://api.zahls.ch/")).toThrow(/https/)
  })
})
