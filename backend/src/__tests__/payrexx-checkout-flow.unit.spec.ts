/**
 * Der eigentliche Bezahlvorgang, End-to-End auf Routen-Ebene.
 *
 * Geprüft wird genau das, was in Produktion schiefgeht:
 *
 *  - Ein Kunde, der die Rückkehrseite NIE erreicht (TWINT-App geschlossen,
 *    Netz weg, Tab zu), bekommt trotzdem eine bezahlte Bestellung — der
 *    Webhook allein schliesst den Warenkorb ab.
 *  - Payrexx wiederholt Webhooks. Die Wiederholung darf nichts doppelt tun.
 *  - Scheitert die Verarbeitung vorübergehend (typisch: der Webhook ist
 *    schneller als die geschriebene Payment Session), muss die Route 500
 *    antworten UND die Idempotenz-Reservierung freigeben — sonst verwirft
 *    sie Payrexx' Retry als Duplikat und die Zahlung ist still verloren.
 *  - Rückkehr und Webhook führen zum selben Ergebnis und laufen sich nicht
 *    gegenseitig über den Haufen.
 *
 * Kein Test spricht mit Payrexx, Redis oder Postgres: der Client ist
 * abgeklemmt, die Stores sind in-memory, der Workflow ist gemockt.
 */

const workflowRun = jest.fn()
jest.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflow: jest.fn(() => ({ run: workflowRun })),
}))

import crypto from "crypto"
import { handlePayrexxWebhook } from "../api/hooks/payment/payrexx/route"
import { handlePayrexxReturn } from "../api/store/payrexx/return/route"
import { PayrexxWebhookProcessor } from "../modules/payrexx/webhook"
import { InMemoryIdempotencyStore } from "../modules/payrexx/idempotency-store"
import { InMemorySessionStateStore } from "../modules/payrexx/session-store"
import type { PayrexxRuntime } from "../modules/payrexx/runtime"

const WEBHOOK_SECRET = "test_webhook_secret_32chars_long!"
const INSTANCE = "jibbit-test"
const SESSION_ID = "payses_01HTEST"
const GATEWAY_ID = 900

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
  res.statusCode = undefined
  res.payload = undefined
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

function signedBody(transaction: Record<string, unknown>) {
  const rawBody = JSON.stringify({ transaction })
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex")
  return { rawBody, signature }
}

/** Ein Warenkorb über CHF 42.00, bezahlt per TWINT. */
const CONFIRMED = {
  id: 555,
  status: "confirmed",
  amount: 4200,
  referenceId: SESSION_ID,
  psp: "twint",
}

type Harness = {
  processor: PayrexxWebhookProcessor
  webhookRuntime: PayrexxRuntime
  returnRuntime: PayrexxRuntime
  retrieveGateway: jest.Mock
  listPaymentSessions: jest.Mock
  logger: any
}

/**
 * Webhook-Route und Rückkehr-Route bekommen denselben Processor — in
 * Produktion teilen sie sich denselben Redis. Genau das ist die Bedingung
 * dafür, dass die beiden Wege sich gegenseitig als Duplikat erkennen.
 */
function harness(): Harness {
  const logger = loggerMock()
  const retrieveGateway = jest.fn()
  const listPaymentSessions = jest.fn()

  const processor = new PayrexxWebhookProcessor({
    instance: INSTANCE,
    webhookSecret: WEBHOOK_SECRET,
    logger,
    idempotencyStore: new InMemoryIdempotencyStore(),
    sessionStore: new InMemorySessionStateStore(),
  })

  const client = { retrieveGateway } as any
  const runtime: PayrexxRuntime = { configured: true, client, processor }

  return {
    processor,
    webhookRuntime: runtime,
    returnRuntime: runtime,
    retrieveGateway,
    listPaymentSessions,
    logger,
  }
}

function webhookRequest(rawBody: string, signature: string) {
  return {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: { "x-webhook-signature": signature },
    scope: { resolve: jest.fn() },
  } as any
}

function returnRequest(h: Harness, body: unknown) {
  return {
    body,
    scope: {
      resolve: jest.fn(() => ({ listPaymentSessions: h.listPaymentSessions })),
    },
  } as any
}

beforeEach(() => {
  workflowRun.mockReset()
  workflowRun.mockResolvedValue({ result: {} })
})

describe("Webhook-Route — der Kunde erreicht die Rückkehrseite nie", () => {
  it("completes the order from the webhook alone", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(200)
    expect(res.payload).toEqual({ status: "authorized" })

    // Der Warenkorb wird von processPaymentWorkflow abgeschlossen — ohne
    // jedes Zutun der Storefront.
    expect(workflowRun).toHaveBeenCalledTimes(1)
    const input = workflowRun.mock.calls[0][0].input
    expect(input.action).toBe("authorized")
    expect(input.data.session_id).toBe(SESSION_ID)
    // 4200 Rappen bei Payrexx → 42 CHF in Medusa.
    expect(Number(input.data.amount)).toBe(42)
  })

  it("does not depend on the storefront ever calling back", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      makeRes(),
      h.webhookRuntime,
      h.logger
    )

    // Die Rückkehr-Route wurde nie aufgerufen, der Payrexx-Client nie befragt.
    expect(h.retrieveGateway).not.toHaveBeenCalled()
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })
})

describe("Webhook-Route — Signatur", () => {
  it("answers 401 and does nothing when the signature is forged", async () => {
    const h = harness()
    const { rawBody } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, "a".repeat(64)),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(401)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("answers 401 when the body was tampered with after signing", async () => {
    const h = harness()
    const { signature } = signedBody(CONFIRMED)
    const tampered = JSON.stringify({
      transaction: { ...CONFIRMED, amount: 1 },
    })
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(tampered, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(401)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("answers 401 (not 500) on an empty signature header", async () => {
    const h = harness()
    const { rawBody } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, ""),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(401)
  })

  it("never writes the signature or the secret into the response", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature.replace(/.$/, "0")),
      res,
      h.webhookRuntime,
      h.logger
    )

    const serialized = JSON.stringify(res.payload)
    expect(serialized).not.toContain(WEBHOOK_SECRET)
    expect(serialized).not.toContain(signature)
  })
})

describe("Webhook-Route — Wiederholungen von Payrexx", () => {
  it("processes a retried webhook exactly once and still answers 200", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)

    const first = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      first,
      h.webhookRuntime,
      h.logger
    )

    const retry = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      retry,
      h.webhookRuntime,
      h.logger
    )

    expect(first.statusCode).toBe(200)
    // 200, damit Payrexx aufhört zu wiederholen — die Arbeit ist getan.
    expect(retry.statusCode).toBe(200)
    expect(retry.payload).toEqual({ status: "duplicate" })
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })

  it("treats a later status change of the same transaction as a new event", async () => {
    // Powerpay: erst "waiting", dann "confirmed". Der zweite Webhook darf
    // NICHT als Duplikat des ersten verschluckt werden.
    const h = harness()

    const waiting = signedBody({ ...CONFIRMED, status: "waiting" })
    await handlePayrexxWebhook(
      webhookRequest(waiting.rawBody, waiting.signature),
      makeRes(),
      h.webhookRuntime,
      h.logger
    )

    const confirmed = signedBody(CONFIRMED)
    const res = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(confirmed.rawBody, confirmed.signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.payload).toEqual({ status: "authorized" })
    expect(workflowRun).toHaveBeenCalledTimes(2)
  })

  it("answers 500 and RELEASES the reservation when processing fails, so the retry works", async () => {
    // Der klassische Fall: Payrexx meldet die Zahlung, bevor Medusa die
    // Payment Session geschrieben hat. Ohne das Freigeben wäre der Retry
    // ein "Duplikat" und die bezahlte Bestellung für immer verloren.
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)

    workflowRun.mockRejectedValueOnce(new Error("payment session not found yet"))

    const failed = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      failed,
      h.webhookRuntime,
      h.logger
    )

    expect(failed.statusCode).toBe(500)

    // Payrexx wiederholt — und diesmal klappt es.
    const retry = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      retry,
      h.webhookRuntime,
      h.logger
    )

    expect(retry.statusCode).toBe(200)
    expect(retry.payload).toEqual({ status: "authorized" })
    expect(workflowRun).toHaveBeenCalledTimes(2)
  })

  it("treats a step error that did NOT fail the flow as a failure too", async () => {
    // completeCartAfterPaymentStep ist in Medusas processPaymentWorkflow als
    // `continueOnPermanentFailure: true` markiert — und ist bei einer
    // cart-gebundenen Session der EINZIGE Schritt, der die Bestellung
    // erzeugt. Scheitert er, laeuft der Flow trotzdem erfolgreich zu Ende
    // und `run()` wirft NICHT; der Fehler steht nur in `errors`.
    //
    // Ohne die Auswertung von `errors` waere die Folge: 200 an Payrexx,
    // Idempotenz-Key verbraucht, keine Wiederholung — bezahlt, aber nie
    // bestellt. Genau der Verlust, gegen den release() gebaut ist.
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)

    workflowRun.mockResolvedValueOnce({
      result: {},
      errors: [{ error: new Error("cart completion failed") }],
    })

    const failed = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      failed,
      h.webhookRuntime,
      h.logger
    )

    expect(failed.statusCode).toBe(500)

    // Und der Retry von Payrexx muss wieder greifen koennen.
    const retry = makeRes()
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      retry,
      h.webhookRuntime,
      h.logger
    )

    expect(retry.statusCode).toBe(200)
    expect(workflowRun).toHaveBeenCalledTimes(2)
  })
})

describe("Webhook-Route — nicht verarbeitbare Ereignisse", () => {
  it("answers 400 on a correctly signed but unusable body", async () => {
    const rawBody = JSON.stringify({ something: "else" })
    const signature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex")
    const h = harness()
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(400)
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("acknowledges a declined payment without running the workflow", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody({
      ...CONFIRMED,
      status: "declined",
    })
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(200)
    expect(res.payload).toEqual({ status: "failed" })
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("answers 503 while Payrexx credentials are missing", async () => {
    const h = harness()
    const { rawBody, signature } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      { ...h.webhookRuntime, configured: false },
      h.logger
    )

    expect(res.statusCode).toBe(503)
  })
})

describe("Rückkehr-Route", () => {
  function paymentSession(data: Record<string, unknown> = { id: GATEWAY_ID }) {
    return {
      id: SESSION_ID,
      provider_id: "pp_payrexx_payrexx",
      data,
    }
  }

  function gatewayWith(transaction: Record<string, unknown> | null) {
    return {
      data: [
        {
          id: GATEWAY_ID,
          invoices: transaction ? [{ transactions: [transaction] }] : [],
        },
      ],
    }
  }

  it("completes the order when the customer comes back before the webhook", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([paymentSession()])
    h.retrieveGateway.mockResolvedValue(gatewayWith(CONFIRMED))
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({
      payment_session_id: SESSION_ID,
      status: "authorized",
      transaction_status: "confirmed",
    })
    expect(workflowRun).toHaveBeenCalledTimes(1)
    expect(workflowRun.mock.calls[0][0].input.data.session_id).toBe(SESSION_ID)
  })

  it("reaches the same result as the webhook — and does the work only once", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([paymentSession()])
    h.retrieveGateway.mockResolvedValue(gatewayWith(CONFIRMED))

    // Webhook zuerst.
    const { rawBody, signature } = signedBody(CONFIRMED)
    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      makeRes(),
      h.webhookRuntime,
      h.logger
    )

    // Danach kommt der Kunde zurück.
    const res = makeRes()
    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    // Gleiches Ergebnis für die Storefront …
    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({ status: "authorized" })
    // … aber der Warenkorb wurde nur einmal abgeschlossen.
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })

  it("reports 'pending' when the customer returned without paying", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([paymentSession()])
    h.retrieveGateway.mockResolvedValue(gatewayWith(null))
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({ status: "pending" })
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("never trusts the browser — the status always comes from a fresh Payrexx query", async () => {
    // Ein Kunde, der /checkout/success von Hand aufruft, ohne bezahlt zu
    // haben, bekommt keine bezahlte Bestellung.
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([paymentSession()])
    h.retrieveGateway.mockResolvedValue(
      gatewayWith({ ...CONFIRMED, status: "declined" })
    )
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    expect(res.payload).toMatchObject({ status: "canceled" })
    expect(workflowRun).not.toHaveBeenCalled()
  })

  it("answers 502 (not 'failed') when Payrexx is unreachable", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([paymentSession()])
    h.retrieveGateway.mockRejectedValue(new Error("ETIMEDOUT"))
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    // Die Storefront darf daraus keinen Misserfolg ableiten — der Webhook
    // zieht ohnehin nach.
    expect(res.statusCode).toBe(502)
  })

  it("rejects a request without a payment_session_id", async () => {
    const h = harness()
    const res = makeRes()

    await handlePayrexxReturn(returnRequest(h, {}), res, h.returnRuntime, h.logger)

    expect(res.statusCode).toBe(400)
  })

  it("rejects a payment session that belongs to another provider", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([
      { ...paymentSession(), provider_id: "pp_stripe_stripe" },
    ])
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: SESSION_ID }),
      res,
      h.returnRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(400)
    expect(h.retrieveGateway).not.toHaveBeenCalled()
  })

  it("answers 404 for an unknown payment session", async () => {
    const h = harness()
    h.listPaymentSessions.mockResolvedValue([])
    const res = makeRes()

    await handlePayrexxReturn(
      returnRequest(h, { payment_session_id: "payses_nope" }),
      res,
      h.returnRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(404)
  })
})

describe("Betragsabgleich über den ganzen Weg", () => {
  it("refuses to complete an order paid on a stale gateway with a different amount", async () => {
    const h = harness()

    // Der aktuell gültige Gateway für diese Session lautet auf CHF 89.
    await h.processor.rememberGateway(SESSION_ID, {
      gatewayId: 901,
      amountInRappen: 8900,
      currency: "CHF",
    })

    // Der Kunde bezahlt aber auf einem alten, noch offenen Gateway CHF 42.
    const { rawBody, signature } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.statusCode).toBe(200) // Payrexx soll nicht endlos retryen
    expect(res.payload).toEqual({ status: "not_supported" })
    expect(workflowRun).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("MANUAL REVIEW REQUIRED")
    )
  })

  it("completes normally when the paid amount matches the current gateway", async () => {
    const h = harness()
    await h.processor.rememberGateway(SESSION_ID, {
      gatewayId: GATEWAY_ID,
      amountInRappen: 4200,
      currency: "CHF",
    })

    const { rawBody, signature } = signedBody(CONFIRMED)
    const res = makeRes()

    await handlePayrexxWebhook(
      webhookRequest(rawBody, signature),
      res,
      h.webhookRuntime,
      h.logger
    )

    expect(res.payload).toEqual({ status: "authorized" })
    expect(workflowRun).toHaveBeenCalledTimes(1)
  })
})
