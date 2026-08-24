/**
 * Payrexx Payment Provider für MedusaJS v2
 * Unterstützt TWINT, Karten und Powerpay (Rechnungskauf) via Payrexx Gateway API.
 *
 * Flow:
 * 1. initiatePayment → Payrexx Gateway erstellen → Redirect-URL in data.link
 * 2. Kunde bezahlt auf der Payrexx-Seite (bleibt ausserhalb unseres PCI-Scopes)
 * 3. ENTWEDER Webhook (src/api/hooks/payment/payrexx) ODER Rückkehr-Abgleich
 *    (src/api/store/payrexx/return) — beide gehen durch denselben
 *    PayrexxWebhookProcessor und teilen sich denselben Idempotency-Key.
 *    Wer zuerst kommt, gewinnt; der andere ist ein No-Op. Erreicht der Kunde
 *    die Rückkehrseite nie, entsteht die Bestellung trotzdem.
 * 4. Admin → capturePayment / refundPayment
 *
 * Security (Ist-Zustand):
 * - HMAC-SHA256 Webhook-Signatur-Validierung (Header: X-Webhook-Signature)
 * - Idempotenz via Redis, atomar, pro Payrexx-Instance (= Tenant) genamespact
 * - Betrags-Abgleich gegen den zuletzt für die Session erzeugten Gateway
 *   (session-store.ts) — schliesst die in SECURITY-NOTES.md beschriebene
 *   Stale-Gateway-Lücke
 * - Alle Beträge ausschliesslich über amounts.ts (Rappen ↔ Dezimal-CHF)
 */

import { AbstractPaymentProvider } from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"
import type {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  PayrexxClient,
  extractGatewayTransaction,
  normalizePayrexxApiBaseUrl,
} from "./client"
import { toRappen } from "./amounts"
import {
  IdempotencyStore,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
} from "./idempotency-store"
import {
  SessionStateStore,
  InMemorySessionStateStore,
  RedisSessionStateStore,
} from "./session-store"
import { PayrexxWebhookProcessor } from "./webhook"

export interface PayrexxProviderOptions {
  instance: string
  apiSecret: string
  webhookSecret: string
  enabledPsps: number[]
  /**
   * REST-API-Basis-Adresse inkl. Versionspfad. Leer = api.payrexx.com.
   * Für die White-Label-Instanz zahls.ch: `https://api.zahls.ch/v1.0/`.
   * Kommt aus PAYREXX_API_BASE_URL (medusa-config.ts).
   */
  apiBaseUrl?: string
}

type InjectedDependencies = {
  logger: Logger
  /**
   * Optional — nur zum Injizieren in Tests, damit kein Test einen echten
   * Redis-Server braucht. Medusas DI-Container registriert diese Keys
   * normalerweise nicht; der Constructor baut sie dann selbst aus REDIS_URL.
   */
  idempotencyStore?: IdempotencyStore
  sessionStateStore?: SessionStateStore
}

/**
 * Eine OPTIONALE Abhaengigkeit aus dem Container lesen.
 *
 * ⚠️ WARUM NICHT EINFACH `container.idempotencyStore`: Medusa reicht zur
 * Laufzeit Awilix' Cradle-Proxy herein. Ein Zugriff auf einen NICHT
 * registrierten Namen liefert dort kein `undefined` — er WIRFT
 * (`AwilixResolutionError`). Der Ausdruck
 *
 *     container.idempotencyStore ?? fallback
 *
 * kommt deshalb nie beim Fallback an, sondern reisst die Erzeugung des
 * Providers ab. Medusa meldet das anschliessend als «Unable to retrieve the
 * payment provider with id: pp_payrexx_payrexx» — eine Meldung, die auf eine
 * falsche Konfiguration zeigt, obwohl die Konfiguration stimmt. Die Kasse
 * antwortet dem Kunden mit 500.
 *
 * In den Tests wird ein schlichtes Objekt uebergeben; dort IST ein fehlender
 * Schluessel `undefined`. Genau deshalb blieb der Fehler in einer gruenen
 * Testsuite unsichtbar und trat erst im Container auf.
 */
function optionalDependency<T>(
  container: unknown,
  key: "idempotencyStore" | "sessionStateStore"
): T | undefined {
  try {
    return (container as Record<string, T | undefined>)[key]
  } catch {
    return undefined
  }
}

/**
 * Payrexx-Status → Medusa-PaymentSessionStatus.
 *
 * Dieselbe Tabelle, die webhook.ts für die Webhook-Aktionen benutzt — nur in
 * die Session-Status-Domäne übersetzt. Die beiden MÜSSEN übereinstimmen: vor
 * dieser Änderung meldete der Webhook für `waiting` (Powerpay) "authorized",
 * während getPaymentStatus() und authorizePayment() für denselben Zustand
 * "pending" lieferten. Eine per Webhook autorisierte Powerpay-Bestellung
 * blieb dadurch beim Abschluss des Warenkorbs hängen.
 */
export function mapPayrexxStatus(status: string | undefined): PaymentSessionStatus {
  switch (status) {
    case "confirmed":
    case "authorized":
    case "reserved":
    case "waiting":
      return "authorized"
    case "refunded":
    case "partially-refunded":
    case "refundpending":
      // Geld ist geflossen — aus Medusas Sicht war die Zahlung erfasst.
      return "captured"
    case "cancelled":
    case "canceled":
    case "declined":
    case "expired":
    case "error":
    case "chargeback":
      return "canceled"
    default:
      return "pending"
  }
}

/** Payrexx-Status, nach denen eine Transaktion bereits verbucht ist. */
const SETTLED_STATUSES = new Set([
  "confirmed",
  "refunded",
  "partially-refunded",
])

class PayrexxPaymentProviderService extends AbstractPaymentProvider<PayrexxProviderOptions> {
  static identifier = "payrexx"

  protected logger_: Logger
  protected options_: PayrexxProviderOptions
  protected client: PayrexxClient
  protected processor_: PayrexxWebhookProcessor

  constructor(container: InjectedDependencies, options: PayrexxProviderOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client = new PayrexxClient({
      instance: options.instance,
      apiSecret: options.apiSecret,
      baseUrl: options.apiBaseUrl,
    })

    const redisUrl = process.env.REDIS_URL

    // Ueber optionalDependency() lesen, NICHT direkt — siehe dort.
    const injectedIdempotencyStore = optionalDependency<IdempotencyStore>(
      container,
      "idempotencyStore"
    )
    const injectedSessionStateStore = optionalDependency<SessionStateStore>(
      container,
      "sessionStateStore"
    )

    if (!redisUrl && !injectedIdempotencyStore) {
      this.logger_.warn(
        "Payrexx: REDIS_URL not set — falling back to in-memory webhook " +
          "idempotency and session state. This survives neither a process " +
          "restart nor a second instance and must not be used in production."
      )
    }

    this.processor_ = new PayrexxWebhookProcessor({
      instance: options.instance,
      webhookSecret: options.webhookSecret,
      logger: this.logger_,
      idempotencyStore:
        injectedIdempotencyStore ??
        (redisUrl
          ? new RedisIdempotencyStore({ redisUrl, logger: this.logger_ })
          : new InMemoryIdempotencyStore()),
      sessionStore:
        injectedSessionStateStore ??
        (redisUrl
          ? new RedisSessionStateStore({ redisUrl, logger: this.logger_ })
          : new InMemorySessionStateStore()),
    })
  }

  static validateOptions(options: Record<string, unknown>): void {
    // Skip validation in dev mode when Payrexx is not yet configured
    if (!options.instance && !options.apiSecret && !options.webhookSecret) {
      return
    }
    if (!options.instance) {
      throw new Error("Payrexx 'instance' is required.")
    }
    if (!options.apiSecret) {
      throw new Error("Payrexx 'apiSecret' is required.")
    }
    if (!options.webhookSecret) {
      throw new Error("Payrexx 'webhookSecret' is required.")
    }
    // Wirft bei einem unbrauchbaren Wert (kein https, keine URL) — ein
    // Tippfehler in PAYREXX_API_BASE_URL soll den Start scheitern lassen,
    // nicht den ersten Bezahlversuch.
    normalizePayrexxApiBaseUrl(
      typeof options.apiBaseUrl === "string" ? options.apiBaseUrl : undefined
    )
  }

  /**
   * Payment Session initialisieren.
   * Erstellt einen Payrexx Gateway und gibt die Redirect-URL zurück.
   */
  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, context, data } = input

    const storeUrl = process.env.STORE_URL || "http://localhost:8000"

    // Die Medusa-Payment-Session-ID kommt NICHT über den Context, sondern über
    // data.session_id — PaymentModuleService.createPaymentSession() setzt
    // `data: { ...input.data, session_id: paymentSession.id }` und zusätzlich
    // `context.idempotency_key = paymentSession.id`.
    // Ohne diese ID kann der Webhook später keine Session zuordnen.
    const sessionId =
      (data?.session_id as string | undefined) ?? context?.idempotency_key ?? ""

    if (!sessionId) {
      this.logger_.warn(
        "Payrexx: initiatePayment without a session id — webhooks will not be attributable."
      )
    }

    // Medusa v2 liefert Dezimalbeträge (CHF 27.00 === 27), die Payrexx-API
    // erwartet Rappen. Die Umrechnung gehört ausschliesslich in amounts.ts —
    // dort steht auch, warum der Faktor 100 ist und warum kein blankes
    // Number(amount) genügt.
    const amountInRappen = toRappen(amount)

    if (amountInRappen <= 0) {
      throw new Error(
        `Payrexx: invalid payment amount (${String(amount)} ${currency_code}). Amount must be a positive number.`
      )
    }

    const currency = currency_code.toUpperCase()

    // Die session_id wandert in die Rückkehr-URLs, damit die Storefront beim
    // Zurückkommen weiss, welche Payment Session sie abgleichen lassen muss
    // (POST /store/payrexx/return). Payrexx hängt selbst keine für uns
    // brauchbare Kennung an die Redirect-URL an.
    const returnQuery = `payment_session_id=${encodeURIComponent(sessionId)}`

    const gateway = await this.client.createGateway({
      amount: amountInRappen,
      currency,
      purpose: `jibbit.ch Bestellung`,
      referenceId: sessionId,
      successRedirectUrl: `${storeUrl}/checkout/success?${returnQuery}`,
      failedRedirectUrl: `${storeUrl}/checkout/failed?${returnQuery}`,
      cancelRedirectUrl: `${storeUrl}/checkout/cancel?${returnQuery}`,
      psp: this.options_.enabledPsps,
      fields: context?.customer
        ? {
            forename: { value: context.customer.first_name || "" },
            surname: { value: context.customer.last_name || "" },
            email: { value: context.customer.email || "" },
          }
        : undefined,
    })

    const gatewayData = gateway.data?.[0]
    if (!gatewayData) {
      throw new Error("Payrexx Gateway creation failed: no data returned.")
    }

    // Merken, welcher Gateway und welcher Betrag für diese Session gerade
    // gültig sind. Der Webhook-Handler hat keinen Zugriff auf die Payment
    // Session und kann den gemeldeten Betrag sonst gegen nichts prüfen.
    if (sessionId) {
      await this.processor_.rememberGateway(sessionId, {
        gatewayId: gatewayData.id,
        amountInRappen,
        currency,
      })
    }

    this.logger_.info(
      `Payrexx Gateway created: id=${gatewayData.id}, session=${sessionId}, amount=${amountInRappen} Rappen`
    )

    return {
      id: String(gatewayData.id),
      data: {
        id: gatewayData.id,
        hash: gatewayData.hash,
        link: gatewayData.link, // Redirect-URL für die Storefront
        status: gatewayData.status,
        referenceId: gatewayData.referenceId,
        session_id: sessionId,
        // Für updatePayment(): erlaubt den Vergleich "hat sich der Betrag
        // überhaupt geändert?", ohne den Session-Store zu befragen.
        amountInRappen,
        currency,
      },
    }
  }

  /**
   * Zahlung autorisieren.
   *
   * Wird von Medusa beim Abschluss des Warenkorbs aufgerufen (und vom
   * processPaymentWorkflow). Fragt den echten Stand bei Payrexx ab —
   * Statusquelle ist immer Payrexx, nie der Client.
   */
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const gatewayId = Number(input.data?.id)
    const data = (input.data ?? {}) as Record<string, unknown>

    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      this.logger_.error(
        "Payrexx authorizePayment without a gateway id in payment session data."
      )
      return { data, status: "error" }
    }

    let transaction
    try {
      const gateway = await this.client.retrieveGateway(gatewayId)
      transaction = extractGatewayTransaction(gateway.data?.[0])
    } catch (err) {
      // Bewusst "pending" statt "error": ein Netzwerkfehler gegen Payrexx
      // heisst NICHT, dass die Zahlung gescheitert ist. "error" würde die
      // Session als endgültig kaputt markieren und den Kunden aus einer
      // möglicherweise längst bezahlten Bestellung werfen. "pending" lässt
      // den Webhook bzw. den nächsten Rückkehr-Abgleich nachziehen.
      this.logger_.error(
        `Payrexx: could not retrieve gateway ${gatewayId} during authorize (${String(err)}) — reporting pending.`
      )
      return { data, status: "pending" }
    }

    if (!transaction) {
      return { data, status: "pending" }
    }

    const status = mapPayrexxStatus(transaction.status)

    return {
      data: {
        ...data,
        transactionId: transaction.id,
        transactionStatus: transaction.status,
        transactionAmountInRappen: transaction.amount,
      },
      status,
    }
  }

  /**
   * Zahlung capturen. Wird vom Admin ausgelöst.
   *
   * Wichtig für Payrexx: Ein Gateway ohne Pre-Authorization ist bei
   * `confirmed` bereits verbucht. Ein zweiter Capture-Aufruf auf eine solche
   * Transaktion beantwortet Payrexx mit einem Fehler. Ohne die Prüfung unten
   * wäre die Bestellung im Admin dauerhaft nicht abschliessbar: "Capture"
   * scheitert, obwohl das Geld längst da ist.
   */
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const transactionId = await this.resolveTransactionId(data)

    if (!transactionId) {
      throw new Error(
        "Payrexx: no transaction found for this payment — nothing to capture. " +
          "The customer may not have completed the payment on the Payrexx page."
      )
    }

    const currentStatus = await this.fetchTransactionStatus(transactionId)

    if (currentStatus && SETTLED_STATUSES.has(currentStatus)) {
      this.logger_.info(
        `Payrexx transaction ${transactionId} is already '${currentStatus}' — ` +
          `recording the capture in Medusa without calling Payrexx again.`
      )
      return {
        data: {
          ...data,
          transactionId,
          capturedAt: new Date().toISOString(),
          captureSkippedReason: `already ${currentStatus} at Payrexx`,
        },
      }
    }

    const result = await this.client.captureTransaction(transactionId)

    return {
      data: {
        ...data,
        transactionId,
        capturedAt: new Date().toISOString(),
        captureResult: result.data?.[0],
      },
    }
  }

  /**
   * Zahlung stornieren. Löscht den Payrexx Gateway (wenn noch nicht bezahlt).
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const gatewayId = Number(data.id)

    if (Number.isFinite(gatewayId) && gatewayId > 0) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch (err) {
        this.logger_.warn(
          `Failed to delete Payrexx gateway ${gatewayId}: ${String(err)}`
        )
      }
    }

    await this.forgetSessionState(data)

    return { data }
  }

  /**
   * Rückerstattung. `input.amount` ist ein Dezimalbetrag, Payrexx will Rappen.
   */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const transactionId = await this.resolveTransactionId(data)

    if (!transactionId) {
      throw new Error("Payrexx: no transaction found for this payment — cannot refund.")
    }

    const amountInRappen = toRappen(input.amount)

    if (amountInRappen <= 0) {
      throw new Error(
        `Payrexx: refuse to refund a non-positive amount (${String(input.amount)}).`
      )
    }

    const result = await this.client.refundTransaction(transactionId, amountInRappen)

    return {
      data: {
        ...data,
        transactionId,
        refundedAt: new Date().toISOString(),
        refundedAmountInRappen: amountInRappen,
        refundResult: result.data?.[0],
      },
    }
  }

  /**
   * Payment Session löschen (Kunde wechselt die Zahlungsart).
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const gatewayId = Number(data.id)

    if (Number.isFinite(gatewayId) && gatewayId > 0) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch (err) {
        // Gateway existiert evtl. nicht mehr — kein Grund, den Wechsel der
        // Zahlungsart scheitern zu lassen. Aber loggen: ein Gateway, das
        // sich nicht löschen lässt, bleibt zahlbar.
        this.logger_.warn(
          `Payrexx: gateway ${gatewayId} could not be deleted (${String(err)}). ` +
            `It may still be payable at Payrexx.`
        )
      }
    }

    await this.forgetSessionState(data)

    return { data }
  }

  /**
   * Payment abrufen.
   */
  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const gatewayId = Number(data.id)

    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      return data
    }

    try {
      const gateway = await this.client.retrieveGateway(gatewayId)
      const gatewayData = gateway.data?.[0]
      if (!gatewayData) {
        return data
      }
      return { ...data, ...(gatewayData as unknown as Record<string, unknown>) }
    } catch (err) {
      this.logger_.warn(
        `Payrexx: could not retrieve gateway ${gatewayId} (${String(err)}).`
      )
      return data
    }
  }

  /**
   * Payment-Status von Payrexx abfragen und auf Medusa-Status mappen.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const gatewayId = Number(data.id)

    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      return { status: "pending" }
    }

    try {
      const gateway = await this.client.retrieveGateway(gatewayId)
      const transaction = extractGatewayTransaction(gateway.data?.[0])

      if (!transaction) {
        return { status: "pending" }
      }

      return {
        status: mapPayrexxStatus(transaction.status),
        data: {
          ...data,
          transactionId: transaction.id,
          transactionStatus: transaction.status,
        },
      }
    } catch (err) {
      // Wie bei authorizePayment: ein API-Fehler ist kein Zahlungsfehler.
      this.logger_.warn(
        `Payrexx: could not read status for gateway ${gatewayId} (${String(err)}) — reporting pending.`
      )
      return { status: "pending" }
    }
  }

  /**
   * Payment aktualisieren (z.B. der Betrag ändert sich im Cart).
   *
   * Payrexx-Gateways sind unveränderlich, also: alten löschen, neuen anlegen.
   * Zwei Härtungen gegenüber der Erstimplementierung:
   *
   * 1. Ist der Betrag UNVERÄNDERT, passiert gar nichts. Medusa ruft
   *    updatePayment() auch dann auf, wenn sich am Warenkorb nichts
   *    Zahlungsrelevantes geändert hat. Jedes unnötige Löschen+Neuanlegen
   *    entwertet den Link, den der Kunde eventuell schon offen hat, und
   *    erzeugt genau die Stale-Gateway-Situation aus SECURITY-NOTES.md.
   * 2. Scheitert das Löschen, wird das jetzt LAUT geloggt statt still
   *    verschluckt. Payrexx verweigert das Löschen, sobald eine Transaktion
   *    am Gateway hängt — dann existiert ein zweiter zahlbarer Gateway mit
   *    dem alten Betrag. Der Betragsabgleich im Webhook (webhook.ts) fängt
   *    die Folge ab; der Log-Eintrag macht die Ursache auffindbar.
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const gatewayId = Number(data.id)
    const newAmountInRappen = toRappen(input.amount)
    const previousAmountInRappen = Number(data.amountInRappen)
    const previousCurrency = String(data.currency ?? "")

    const unchanged =
      Number.isFinite(gatewayId) &&
      gatewayId > 0 &&
      Number.isFinite(previousAmountInRappen) &&
      previousAmountInRappen === newAmountInRappen &&
      previousCurrency === input.currency_code.toUpperCase()

    if (unchanged) {
      return { data }
    }

    if (Number.isFinite(gatewayId) && gatewayId > 0) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch (err) {
        this.logger_.error(
          `Payrexx: gateway ${gatewayId} could NOT be deleted while updating the ` +
            `amount from ${previousAmountInRappen} to ${newAmountInRappen} Rappen ` +
            `(${String(err)}). The old gateway may still be payable — a webhook ` +
            `for it will be rejected by the amount cross-check and needs manual review.`
        )
      }
    }

    // `data` muss durchgereicht werden, sonst geht die session_id verloren
    // und der Webhook kann die Session nicht mehr zuordnen.
    return this.initiatePayment({
      amount: input.amount,
      currency_code: input.currency_code,
      context: input.context,
      data,
    })
  }

  /**
   * Webhook-Verarbeitung für Medusas eingebaute Route
   * `POST /hooks/payment/payrexx_payrexx`.
   *
   * Die bei Payrexx zu hinterlegende URL ist `/hooks/payment/payrexx`
   * (src/api/hooks/payment/payrexx/route.ts) — die verarbeitet synchron und
   * kann Payrexx sinnvolle HTTP-Codes zurückgeben. Diese Methode bleibt
   * bestehen, damit auch der Standardweg funktioniert; beide teilen sich
   * denselben Processor und damit dieselbe Entscheidung und denselben
   * Idempotency-Key.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const evaluation = await this.processor_.evaluateRaw(
      payload.rawData,
      (payload.headers ?? {}) as Record<string, unknown>
    )

    if (evaluation.status === "evaluated") {
      return evaluation.action
    }

    if (evaluation.status === "malformed") {
      this.logger_.warn(`Payrexx webhook ignored: ${evaluation.reason}`)
    }

    return { action: "not_supported" }
  }

  /** Nur für die Routen/Tests: derselbe Processor, den der Provider benutzt. */
  get webhookProcessor(): PayrexxWebhookProcessor {
    return this.processor_
  }

  // ─── Interne Helfer ──────────────────────────────────────────────────────

  /**
   * Transaktions-ID ermitteln.
   *
   * Sie steht normalerweise in `data.transactionId` (von authorizePayment
   * gesetzt). Kam die Autorisierung aber allein über den Webhook zustande und
   * ist authorizePayment nie gelaufen, fehlt sie — dann wird sie beim Gateway
   * nachgeschlagen, statt Capture/Refund an einer fehlenden ID scheitern zu
   * lassen.
   */
  private async resolveTransactionId(
    data: Record<string, unknown>
  ): Promise<number | undefined> {
    const known = Number(data.transactionId)
    if (Number.isFinite(known) && known > 0) {
      return known
    }

    const gatewayId = Number(data.id)
    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      return undefined
    }

    try {
      const gateway = await this.client.retrieveGateway(gatewayId)
      return extractGatewayTransaction(gateway.data?.[0])?.id
    } catch (err) {
      this.logger_.warn(
        `Payrexx: could not resolve a transaction id from gateway ${gatewayId} (${String(err)}).`
      )
      return undefined
    }
  }

  private async fetchTransactionStatus(
    transactionId: number
  ): Promise<string | undefined> {
    try {
      const result = await this.client.retrieveTransaction(transactionId)
      return result.data?.[0]?.status
    } catch (err) {
      // Nicht fatal: im Zweifel wird der Capture regulär versucht.
      this.logger_.warn(
        `Payrexx: could not read transaction ${transactionId} before capture (${String(err)}).`
      )
      return undefined
    }
  }

  private async forgetSessionState(data: Record<string, unknown>): Promise<void> {
    const sessionId = data.session_id ?? data.referenceId
    if (typeof sessionId === "string" && sessionId) {
      await this.processor_.forgetGateway(sessionId)
    }
  }
}

export default PayrexxPaymentProviderService
