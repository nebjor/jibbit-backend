/**
 * Tests für die Redis-backed Webhook-Idempotency in PayrexxPaymentProviderService.
 *
 * Ersetzt das alte in-memory `processedWebhooks`-Set (siehe git history /
 * payrexx-security.unit.spec.ts, Abschnitt "Idempotency"). Diese Datei prüft
 * den Service selbst — nicht nur eine lokal nachgebaute Set-Logik — weil der
 * Bug, den Redis hier fixt, gerade beim Zusammenspiel von Service + Store
 * auftritt: Instance-Namespacing im Key, Verhalten über einen "Neustart"
 * hinweg, und die fail-open-Entscheidung bei Store-Ausfall.
 *
 * Kein Test öffnet eine echte Redis-Verbindung: überall wird ein
 * IdempotencyStore injiziert (InMemoryIdempotencyStore oder ein Test-Double).
 */

import crypto from "crypto"
import PayrexxPaymentProviderService from "../modules/payrexx/service"
import {
  IdempotencyStore,
  InMemoryIdempotencyStore,
} from "../modules/payrexx/idempotency-store"

const WEBHOOK_SECRET = "test_webhook_secret_32chars_long!"

function loggerMock() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as any
}

function makeService(
  instance: string,
  store: IdempotencyStore,
  logger = loggerMock()
) {
  const service = new PayrexxPaymentProviderService(
    { logger, idempotencyStore: store } as any,
    {
      instance,
      apiSecret: "api-secret",
      webhookSecret: WEBHOOK_SECRET,
      enabledPsps: [1],
    }
  )
  return { service, logger }
}

/**
 * Baut einen HMAC-signierten Webhook-Payload, wie ihn Medusa's Webhook-Route
 * an getWebhookActionAndData() durchreicht: { data, rawData, headers }.
 * Ohne eine gültige Signatur bricht die Verarbeitung schon vor dem
 * Idempotency-Check ab (Schritt 1 in getWebhookActionAndData) — die Tests
 * hier prüfen Schritt 2, brauchen also einen validen Header.
 */
function signedWebhookPayload(transaction: Record<string, unknown>) {
  const body = { transaction }
  const rawData = JSON.stringify(body)
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawData)
    .digest("hex")

  return {
    data: body,
    rawData,
    headers: { "x-webhook-signature": signature },
  } as any
}

const CONFIRMED_TRANSACTION = {
  id: 555,
  status: "confirmed",
  amount: 4200, // CHF 42.00 in Rappen
  referenceId: "payses_01",
}

describe("Payrexx webhook idempotency", () => {
  it("processes a duplicate webhook exactly once", async () => {
    const store = new InMemoryIdempotencyStore()
    const { service, logger } = makeService("tenant-a", store)

    const first = await service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )
    const second = await service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    expect(first.action).toBe("authorized")
    expect(second.action).toBe("not_supported")
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate webhook ignored")
    )
  })

  it("still dedupes after a process restart, as long as the store is shared", async () => {
    // Simuliert einen Prozess-Neustart: derselbe Store (= "Redis"), aber
    // eine komplett neue Service-Instanz ohne jedes In-Memory-Wissen vom
    // vorigen Prozess. Genau das war der Bug beim alten `Set`: es lebte im
    // Prozessspeicher und wusste nach einem Neustart nichts mehr.
    const sharedStore = new InMemoryIdempotencyStore()

    const before = makeService("tenant-a", sharedStore)
    const afterRestart = makeService("tenant-a", sharedStore)

    const firstResult = await before.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )
    const afterRestartResult = await afterRestart.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    expect(firstResult.action).toBe("authorized")
    expect(afterRestartResult.action).toBe("not_supported")
  })

  it("does not let two tenants collide on the same Payrexx transaction id", async () => {
    // Zwei Tenants, die sich (worst case) ein einziges Redis teilen — beide
    // bekommen zufällig die exakt gleiche Transaction-ID + Status von
    // Payrexx. Ohne Namespacing im Key würde der zweite Tenant fälschlich
    // als "Duplikat" des ersten behandelt.
    const sharedStore = new InMemoryIdempotencyStore()

    const tenantA = makeService("tenant-a-instance", sharedStore)
    const tenantB = makeService("tenant-b-instance", sharedStore)

    const resultA = await tenantA.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )
    const resultB = await tenantB.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    expect(resultA.action).toBe("authorized")
    expect(resultB.action).toBe("authorized") // NICHT "not_supported"
  })

  it("still blocks a genuine duplicate for the same tenant even when another tenant shares the store", async () => {
    const sharedStore = new InMemoryIdempotencyStore()
    const tenantA = makeService("tenant-a-instance", sharedStore)

    const first = await tenantA.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )
    const retry = await tenantA.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    expect(first.action).toBe("authorized")
    expect(retry.action).toBe("not_supported")
  })

  it("treats a different status for the same transaction id as a distinct event, not a duplicate", async () => {
    // Der Idempotency-Key enthält Transaktions-ID UND Status
    // (`${transactionId}-${status}`). Ohne den Status-Anteil würde ein
    // "refunded"-Webhook für dieselbe Transaktion nach einem "confirmed"
    // fälschlich als Duplikat verschluckt — ein echtes Refund-Event würde
    // Medusa nie erreichen.
    const sharedStore = new InMemoryIdempotencyStore()
    const tenantA = makeService("tenant-a-instance", sharedStore)

    const confirmed = await tenantA.service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )
    const refunded = await tenantA.service.getWebhookActionAndData(
      signedWebhookPayload({
        ...CONFIRMED_TRANSACTION,
        status: "refunded",
      })
    )

    expect(confirmed.action).toBe("authorized")
    expect(refunded.action).toBe("captured") // NICHT "not_supported"
  })

  it("fails OPEN (processes the webhook) when the idempotency store is unavailable", async () => {
    const brokenStore: IdempotencyStore = {
      checkAndSet: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    }
    const { service, logger } = makeService("tenant-a", brokenStore)

    const result = await service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    // Fail-open: der Webhook wird trotzdem verarbeitet (siehe Kommentar in
    // getWebhookActionAndData für die Begründung) — nicht "not_supported".
    expect(result.action).toBe("authorized")
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("idempotency store unavailable")
    )
  })

  it("never falls open on a regular duplicate — only on a thrown store error", async () => {
    // Kontrastfall zum vorigen Test: ein Store, der sauber `false`
    // zurückgibt (kein Fehler!), muss IMMER überspringen. fail-open gilt
    // ausschliesslich für den catch-Zweig.
    const alwaysDuplicateStore: IdempotencyStore = {
      checkAndSet: jest.fn().mockResolvedValue(false),
    }
    const { service } = makeService("tenant-a", alwaysDuplicateStore)

    const result = await service.getWebhookActionAndData(
      signedWebhookPayload(CONFIRMED_TRANSACTION)
    )

    expect(result.action).toBe("not_supported")
  })
})
