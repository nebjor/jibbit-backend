/**
 * Webhook-Verhalten des OFFIZIELLEN zahls.ch-Plugins (@zahls/medusa-plugin)
 * auf Medusa 2.13.6 — Signaturprüfung und Status→Aktion-Mapping, geprüft
 * gegen den echten kompilierten Provider-Service aus node_modules.
 *
 * ─── Was hier festgenagelt wird ────────────────────────────────────────────
 *
 * 1. Signatur: HMAC-SHA256 über den ROHEN Body, hex, im Header
 *    X-Webhook-Signature; Vergleich timing-sicher. Falsche oder fehlende
 *    Signatur → Wurf (kein stilles Durchwinken).
 *
 * 2. Mapping: `confirmed` → "captured" (PaymentActions.SUCCESSFUL). Das war
 *    ANDERS beim früheren Eigenbau-Modul, das confirmed bewusst auf
 *    "authorized" abbildete. Beim Plugin ist "captured" trotzdem sicher:
 *    Medusas processPaymentWorkflow ruft dann capturePaymentWorkflow, und
 *    dessen provider-seitiges capturePayment ist beim Plugin für einen
 *    bereits bestätigten Gateway ein No-Op (Status "confirmed" → Daten
 *    zurück, kein zweiter API-Aufruf). Doppelbelastung ist zusätzlich durch
 *    payment.captured_at im Payment-Modul ausgeschlossen (2.13.6,
 *    capturePayment_: bereits captured → return ohne neue Capture).
 *
 * 3. Bekannte 2.13.6-Lücke, hier DOKUMENTIERT statt wegtestet: für
 *    `waiting` liefert das Plugin PaymentActions.PENDING_AUTHORIZATION —
 *    diese Konstante existiert erst in neueren Medusa-Versionen, auf 2.13.6
 *    ist sie undefined. Der Webhook-Subscriber überspringt undefined nicht
 *    und stösst processPaymentWorkflow an, wo keine Aktion greift; es
 *    entsteht kein falscher Zustand, aber Log-Rauschen. Der Test hält den
 *    Ist-Zustand fest, damit ein Medusa-Upgrade die Änderung sichtbar macht.
 */

import { createHmac } from "node:crypto"
import { dirname, join } from "node:path"

const pluginDir = dirname(require.resolve("@zahls/medusa-plugin/package.json"))
const providerPath = join(
  pluginDir, ".medusa", "server", "src", "providers", "zahls"
)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ZahlsService = require(join(providerPath, "service.js")).default
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require(join(providerPath, "utils.js")) as {
  mapZahlsStatusToWebhookAction: (status: string) => string | undefined
  mapZahlsStatusToPaymentSessionStatus: (status: string) => string
}

/** Nur ein Testwert — kein echtes Secret. */
const TEST_SECRET = "unit-test-webhook-secret"

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

function makeService() {
  return new ZahlsService(
    { logger: silentLogger },
    { apiKey: "unit-test-key", instance: "unit-test", webhookSecret: TEST_SECRET }
  )
}

function makeWebhookPayload(status: string, amountRappen: number) {
  const body = JSON.stringify({
    transaction: {
      id: 4711,
      status,
      amount: amountRappen,
      referenceId: "payses_unit_test",
      invoice: { currency: "CHF", referenceId: "payses_unit_test" },
    },
  })
  const signature = createHmac("sha256", TEST_SECRET)
    .update(body, "utf8")
    .digest("hex")
  return {
    data: JSON.parse(body),
    rawData: body,
    headers: { "x-webhook-signature": signature },
  }
}

describe("zahls-Plugin: Webhook-Signaturprüfung", () => {
  it("akzeptiert eine gültige HMAC-SHA256-Signatur über den rohen Body", async () => {
    const service = makeService()
    const result = await service.getWebhookActionAndData(
      makeWebhookPayload("confirmed", 375)
    )
    expect(result.action).toBe("captured")
    expect(result.data.session_id).toBe("payses_unit_test")
  })

  it("wirft bei falscher Signatur — kein stilles 'failed'", async () => {
    const service = makeService()
    const payload = makeWebhookPayload("confirmed", 375)
    payload.headers["x-webhook-signature"] = "00".repeat(32)
    await expect(service.getWebhookActionAndData(payload)).rejects.toThrow(
      /webhook signature/i
    )
  })

  it("wirft bei fehlendem Signatur-Header", async () => {
    const service = makeService()
    const payload = makeWebhookPayload("confirmed", 375)
    delete (payload.headers as Record<string, string>)["x-webhook-signature"]
    await expect(service.getWebhookActionAndData(payload)).rejects.toThrow(
      /X-Webhook-Signature/i
    )
  })

  it("eine Signatur über einen ANDEREN Body wird abgelehnt (Betrags-Manipulation)", async () => {
    const service = makeService()
    const genuine = makeWebhookPayload("confirmed", 375)
    const forged = makeWebhookPayload("confirmed", 1)
    // Signatur der 375er-Nachricht an den 1-Rappen-Body geheftet:
    forged.headers["x-webhook-signature"] =
      genuine.headers["x-webhook-signature"]
    await expect(service.getWebhookActionAndData(forged)).rejects.toThrow(
      /webhook signature/i
    )
  })
})

describe("zahls-Plugin: Webhook-Betrag kommt als Dezimalbetrag bei Medusa an", () => {
  it("375 Rappen im Webhook → amount 3.75 im WebhookActionResult", async () => {
    const service = makeService()
    const result = await service.getWebhookActionAndData(
      makeWebhookPayload("confirmed", 375)
    )
    // Medusas processPaymentWorkflow reicht diesen Betrag an
    // capturePaymentWorkflow weiter — stünden hier 375 statt 3.75, würde
    // das Hundertfache als Capture verbucht.
    expect(result.data.amount.numeric).toBe(3.75)
  })
})

describe("zahls-Plugin: Status → Medusa-Webhook-Aktion (Medusa 2.22.2)", () => {
  it("confirmed → 'captured' (PaymentActions.SUCCESSFUL)", () => {
    expect(utils.mapZahlsStatusToWebhookAction("confirmed")).toBe("captured")
  })

  it("authorized / reserved / uncaptured → 'authorized'", () => {
    expect(utils.mapZahlsStatusToWebhookAction("authorized")).toBe("authorized")
    expect(utils.mapZahlsStatusToWebhookAction("reserved")).toBe("authorized")
    expect(utils.mapZahlsStatusToWebhookAction("uncaptured")).toBe("authorized")
  })

  it("cancelled → 'canceled', failed/declined → 'failed'", () => {
    expect(utils.mapZahlsStatusToWebhookAction("cancelled")).toBe("canceled")
    expect(utils.mapZahlsStatusToWebhookAction("failed")).toBe("failed")
    expect(utils.mapZahlsStatusToWebhookAction("declined")).toBe("failed")
  })

  it("waiting → 'pending_authorization' (Lücke aus 2.13.6 seit 2.14+ geschlossen)", () => {
    expect(utils.mapZahlsStatusToWebhookAction("waiting")).toBe("pending_authorization")
  })

  it("unbekannte Stati → 'not_supported' (werden ignoriert, nie verbucht)", () => {
    expect(utils.mapZahlsStatusToWebhookAction("something-new")).toBe(
      "not_supported"
    )
  })
})

describe("zahls-Plugin: Status → PaymentSessionStatus (auf 2.13.6)", () => {
  it("confirmed → 'captured', authorized → 'authorized'", () => {
    expect(utils.mapZahlsStatusToPaymentSessionStatus("confirmed")).toBe("captured")
    expect(utils.mapZahlsStatusToPaymentSessionStatus("authorized")).toBe("authorized")
  })

  it("waiting → 'pending' — authorizePayment kann damit auf 2.13.6 nie fälschlich autorisieren", () => {
    // Der Service mappt PENDING beim Autorisieren zwar weiter auf das (in
    // 2.13.6 nicht existente) PENDING_AUTHORIZATION → undefined, aber
    // authorizePaymentSession akzeptiert ausschliesslich 'authorized' oder
    // 'captured' — alles andere (auch undefined) führt zum Abbruch der
    // Autorisierung. Ein unbezahlter Gateway kann so nie zur Bestellung werden.
    expect(utils.mapZahlsStatusToPaymentSessionStatus("waiting")).toBe("pending")
  })
})

describe("zahls-Plugin: unvollständige Konfiguration", () => {
  it("validateOptions wirft bei fehlendem webhookSecret (deshalb die bedingte Registrierung)", () => {
    expect(() =>
      ZahlsService.validateOptions({ apiKey: "k", instance: "i" })
    ).toThrow(/webhookSecret/)
    expect(() =>
      ZahlsService.validateOptions({ instance: "i", webhookSecret: "s" })
    ).toThrow(/apiKey/)
    expect(() =>
      ZahlsService.validateOptions({ apiKey: "k", webhookSecret: "s" })
    ).toThrow(/instance/)
  })

  it("Provider-Identifier ist 'zahls' → Provider-Kennung pp_zahls_zahls", () => {
    expect(ZahlsService.identifier).toBe("zahls")
  })
})
