/**
 * Payrexx Payment Provider für MedusaJS v2
 * Unterstützt TWINT und Powerpay (Rechnungskauf) via Payrexx Gateway API.
 *
 * Flow:
 * 1. initiatePayment → Payrexx Gateway erstellen → Redirect-URL in data
 * 2. Kunde bezahlt auf Payrexx-Seite (TWINT/Powerpay)
 * 3. Webhook → getWebhookActionAndData → authorize/capture
 * 4. Admin → capturePayment / refundPayment
 *
 * Security (Ist-Zustand, nicht Wunschzustand):
 * - HMAC-SHA256 Webhook-Signatur-Validierung (Header: X-Webhook-Signature)
 * - Plausibilitätsprüfung der Beträge (> 0, endlich) beim Gateway-Erstellen
 *   und beim Webhook-Eingang
 * - Idempotency via Redis (`SET key val NX EX ttl`, atomar). Der Key ist
 *   pro Payrexx-Instance (= Tenant) genamespaced, siehe idempotency-store.ts
 *   und den Kommentar bei WEBHOOK_IDEMPOTENCY_TTL_SECONDS unten. Ohne
 *   REDIS_URL fällt der Store auf eine in-memory Variante zurück (nur für
 *   lokale Entwicklung geeignet — service.ts loggt das als Warnung).
 *
 * NICHT implementiert (bewusst dokumentiert):
 * - Ein echter "Price Manipulation Guard", der den Webhook-Betrag gegen den
 *   Cart-/Payment-Session-Betrag abgleicht. getWebhookActionAndData() hat
 *   keinen Zugriff auf die Payment Session; Medusa selbst prüft den Betrag
 *   beim Autorisieren nicht gegen den Provider-Report. Siehe SECURITY-NOTES.md.
 */

import { AbstractPaymentProvider, BigNumber } from "@medusajs/framework/utils"
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
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { PayrexxClient } from "./client"
import {
  IdempotencyStore,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
} from "./idempotency-store"

export interface PayrexxProviderOptions {
  instance: string
  apiSecret: string
  webhookSecret: string
  enabledPsps: number[]
}

type InjectedDependencies = {
  logger: Logger
  /**
   * Optional — nur zum Injizieren in Tests (z.B. InMemoryIdempotencyStore),
   * damit kein Test einen echten Redis-Server braucht. Medusa's DI-Container
   * registriert diesen Key normalerweise nicht; der Constructor baut in dem
   * Fall selbst einen RedisIdempotencyStore aus REDIS_URL.
   */
  idempotencyStore?: IdempotencyStore
}

class PayrexxPaymentProviderService extends AbstractPaymentProvider<PayrexxProviderOptions> {
  static identifier = "payrexx"

  protected logger_: Logger
  protected options_: PayrexxProviderOptions
  protected client: PayrexxClient

  /**
   * Idempotency-Store: Verhindert doppelte Buchungen bei Webhook-Retries.
   * Redis-backed in Produktion (siehe idempotency-store.ts), atomares
   * check-and-set, per Tenant genamespaced.
   */
  private idempotencyStore_: IdempotencyStore

  /**
   * TTL für Idempotency-Keys. Payrexx' genaues Retry-Fenster für Webhooks
   * ist uns nicht öffentlich dokumentiert bekannt — 48h ist eine grosszügige
   * Annahme mit Sicherheitsmarge, KEIN verifizierter Wert. Vor
   * Produktivbetrieb mit Payrexx-Support abgleichen.
   *
   * Akzeptierter Trade-off: nach Ablauf der TTL würde ein erneut
   * zugestelltes "confirmed"-Event (extrem später Retry, oder Payrexx
   * schickt es aus anderem Grund nochmal) als neu behandelt und ERNEUT
   * verarbeitet. Eine unbegrenzte TTL ist keine Alternative — der Store
   * würde nie leer und wüchse pro Tenant unbegrenzt.
   */
  private static readonly WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 48 // 48h

  constructor(container: InjectedDependencies, options: PayrexxProviderOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.client = new PayrexxClient({
      instance: options.instance,
      apiSecret: options.apiSecret,
    })
    this.idempotencyStore_ =
      container.idempotencyStore ?? this.createDefaultIdempotencyStore()
  }

  /**
   * Baut den produktiven Idempotency-Store aus REDIS_URL (wie STORE_URL an
   * anderer Stelle in diesem Modul auch direkt aus process.env gelesen wird
   * — medusa-config.ts reicht REDIS_URL nur an projectConfig.redisUrl durch,
   * nicht an die Provider-Options, siehe medusa-config.ts).
   *
   * Kein REDIS_URL konfiguriert → in-memory Fallback + laute Warnung. Das
   * ist für lokale Entwicklung ok, in Produktion (mehrere Instanzen,
   * Prozess-Restarts) NICHT sicher — exakt das Problem, das dieser Store
   * ersetzt.
   */
  private createDefaultIdempotencyStore(): IdempotencyStore {
    const redisUrl = process.env.REDIS_URL

    if (!redisUrl) {
      this.logger_.warn(
        "Payrexx: REDIS_URL not set — falling back to an in-memory webhook " +
          "idempotency store. This does NOT survive a process restart or a " +
          "second instance and must not be used in production."
      )
      return new InMemoryIdempotencyStore()
    }

    return new RedisIdempotencyStore({ redisUrl, logger: this.logger_ })
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
    // (node_modules/@medusajs/payment/dist/services/payment-module.js)
    // Ohne diese ID kann der Webhook später keine Session zuordnen.
    const sessionId =
      (data?.session_id as string | undefined) ??
      context?.idempotency_key ??
      ""

    if (!sessionId) {
      this.logger_.warn(
        "Payrexx: initiatePayment without a session id — webhooks will not be attributable."
      )
    }

    // Medusa v2 liefert Dezimalbeträge (CHF 27.00 === 27),
    // die Payrexx-API erwartet Rappen. Umrechnung ist zwingend.
    const amountInRappen = Math.round(Number(amount) * 100)

    if (!Number.isFinite(amountInRappen) || amountInRappen <= 0) {
      throw new Error(
        `Payrexx: invalid payment amount (${String(amount)} ${currency_code}). Amount must be a positive number.`
      )
    }

    const gateway = await this.client.createGateway({
      amount: amountInRappen,
      currency: currency_code.toUpperCase(),
      purpose: `jibbit.ch Bestellung`,
      referenceId: sessionId,
      successRedirectUrl: `${storeUrl}/checkout/success`,
      failedRedirectUrl: `${storeUrl}/checkout/failed`,
      cancelRedirectUrl: `${storeUrl}/checkout/cancel`,
      psp: this.options_.enabledPsps,
      fields: context?.customer
        ? {
            forename: { value: (context.customer as any).first_name || "" },
            surname: { value: (context.customer as any).last_name || "" },
            email: { value: (context.customer as any).email || "" },
          }
        : undefined,
    })

    const gatewayData = gateway.data?.[0]
    if (!gatewayData) {
      throw new Error("Payrexx Gateway creation failed: no data returned.")
    }

    this.logger_.info(
      `Payrexx Gateway created: id=${gatewayData.id}, hash=${gatewayData.hash}`
    )

    return {
      id: String(gatewayData.id),
      data: {
        id: gatewayData.id,
        hash: gatewayData.hash,
        link: gatewayData.link, // Redirect-URL für Storefront
        status: gatewayData.status,
        referenceId: gatewayData.referenceId,
      },
    }
  }

  /**
   * Zahlung autorisieren.
   * Bei Payrexx passiert die Autorisierung über den Webhook.
   * Diese Methode wird nach dem Webhook-Event aufgerufen.
   */
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const gatewayId = input.data?.id as number

    // Gateway-Status von Payrexx abrufen
    const gateway = await this.client.retrieveGateway(gatewayId)
    const gatewayData = gateway.data?.[0]

    if (!gatewayData) {
      return { data: input.data as Record<string, unknown>, status: "error" }
    }

    // Transaktion aus dem Gateway extrahieren
    const transaction = gatewayData.invoices?.[0]?.transactions?.[0]

    if (transaction?.status === "confirmed") {
      return {
        data: {
          ...input.data as Record<string, unknown>,
          transactionId: transaction.id,
          transactionStatus: transaction.status,
        },
        status: "authorized",
      }
    }

    return {
      data: input.data as Record<string, unknown>,
      status: "pending",
    }
  }

  /**
   * Zahlung capturen.
   * Wird vom Admin ausgelöst, nachdem die Bestellung autorisiert wurde.
   */
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const transactionId = input.data?.transactionId as number

    if (!transactionId) {
      throw new Error("No transactionId found in payment data for capture.")
    }

    const result = await this.client.captureTransaction(transactionId)

    return {
      data: {
        ...input.data as Record<string, unknown>,
        capturedAt: new Date().toISOString(),
        captureResult: result.data?.[0],
      },
    }
  }

  /**
   * Zahlung stornieren.
   * Löscht den Payrexx Gateway (wenn noch nicht captured).
   */
  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const gatewayId = input.data?.id as number

    if (gatewayId) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch (err) {
        this.logger_.warn(`Failed to delete Payrexx gateway ${gatewayId}: ${err}`)
      }
    }

    return { data: input.data as Record<string, unknown> }
  }

  /**
   * Rückerstattung.
   */
  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const transactionId = input.data?.transactionId as number

    if (!transactionId) {
      throw new Error("No transactionId found in payment data for refund.")
    }

    const result = await this.client.refundTransaction(
      transactionId,
      Math.round(Number(input.amount) * 100) // Dezimalbetrag → Rappen
    )

    return {
      data: {
        ...input.data as Record<string, unknown>,
        refundedAt: new Date().toISOString(),
        refundResult: result.data?.[0],
      },
    }
  }

  /**
   * Payment Session löschen (Kunde wechselt Zahlungsart).
   */
  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    const gatewayId = input.data?.id as number

    if (gatewayId) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch {
        // Gateway existiert evtl. nicht mehr
      }
    }

    return { data: input.data as Record<string, unknown> }
  }

  /**
   * Payment abrufen.
   */
  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const gatewayId = input.data?.id as number

    if (!gatewayId) {
      return input.data as Record<string, unknown>
    }

    const gateway = await this.client.retrieveGateway(gatewayId)
    return gateway.data?.[0] as unknown as Record<string, unknown> || input.data as Record<string, unknown>
  }

  /**
   * Payment-Status von Payrexx abfragen und auf Medusa-Status mappen.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const gatewayId = input.data?.id as number

    if (!gatewayId) {
      return { status: "pending" }
    }

    const gateway = await this.client.retrieveGateway(gatewayId)
    const gatewayData = gateway.data?.[0]
    const transaction = gatewayData?.invoices?.[0]?.transactions?.[0]

    if (!transaction) {
      return { status: "pending" }
    }

    // Payrexx Status → Medusa Status Mapping
    switch (transaction.status) {
      case "confirmed":
        return { status: "authorized" }
      case "refunded":
      case "partially-refunded":
        return { status: "captured" } // Already captured if refunded
      case "cancelled":
      case "declined":
      case "error":
        return { status: "canceled" }
      case "waiting":
        return { status: "pending" }
      default:
        return { status: "pending" }
    }
  }

  /**
   * Payment aktualisieren (z.B. Betrag ändert sich im Cart).
   */
  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    // Payrexx Gateways sind immutable → alten löschen + neuen erstellen
    const gatewayId = input.data?.id as number

    if (gatewayId) {
      try {
        await this.client.deleteGateway(gatewayId)
      } catch {
        // Ignore
      }
    }

    // Neuen Gateway mit aktualisierten Daten erstellen.
    // `data` muss durchgereicht werden, sonst geht die session_id verloren
    // und der Webhook kann die Session nicht mehr zuordnen.
    return this.initiatePayment({
      amount: input.amount,
      currency_code: input.currency_code,
      context: input.context,
      data: input.data,
    })
  }

  /**
   * Webhook-Verarbeitung.
   * Validiert HMAC-Signatur und gibt die entsprechende Aktion zurück.
   *
   * Security:
   * - HMAC-SHA256 Signatur-Validierung (Webhook Forgery Protection)
   * - Idempotency Check (keine doppelten Buchungen)
   * - Betrags-Plausibilität (> 0). KEIN Abgleich gegen den Cart-Betrag —
   *   dafür fehlt hier der Zugriff auf die Payment Session.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    // 1. HMAC-SHA256 Signatur validieren (Webhook Forgery Protection)
    // Payrexx liefert die Signatur in "X-Webhook-Signature" (lowercase hex).
    // Node/Express normalisiert Header-Namen auf lowercase.
    const headerBag = (headers ?? {}) as Record<string, string | string[]>
    const rawSignature =
      headerBag[PayrexxClient.WEBHOOK_SIGNATURE_HEADER] ??
      headerBag["X-Webhook-Signature"] ??
      // Legacy-Fallback: so hiess der Header in der ersten Implementierung.
      headerBag["payrexx-signature"] ??
      ""
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature
    const rawBody =
      typeof rawData === "string"
        ? rawData
        : Buffer.isBuffer(rawData)
          ? rawData.toString("utf8")
          : JSON.stringify(rawData)

    if (!PayrexxClient.verifyWebhookSignature(rawBody, signature, this.options_.webhookSecret)) {
      this.logger_.error("Payrexx webhook signature verification failed!")
      return { action: "not_supported" }
    }

    // 2. Idempotency Check — verhindert doppelte Buchungen bei Retries.
    //
    // Namespacing: Der Key enthält options_.instance, die Payrexx-Merchant-
    // Instance — faktisch der Tenant in der Multi-Tenant-Architektur (siehe
    // docs/multi-tenancy-architecture.md, §8: pro Tenant ein eigener
    // Payrexx-Account). Selbst wenn sich mehrere Tenants ein Redis teilen
    // (§6.3 des Dokuments erwägt genau das als Alternative zu Redis pro
    // Tenant), können sich Transaktions-IDs zweier Tenants hier NIE
    // überschneiden — eine blanke Transaktions-ID als Key wäre sonst ein
    // Cross-Tenant-Hazard: Tenant A könnte (unabsichtlich per ID-Kollision
    // oder absichtlich) einen Webhook von Tenant B als "schon verarbeitet"
    // maskieren oder umgekehrt fälschlich blockieren.
    const webhookTransaction = (data as any)?.transaction
    const transactionId = webhookTransaction?.id
    const idempotencyKey = `payrexx:webhook:${this.options_.instance}:${transactionId}-${webhookTransaction?.status}`

    let isNewWebhook: boolean
    try {
      isNewWebhook = await this.idempotencyStore_.checkAndSet(
        idempotencyKey,
        PayrexxPaymentProviderService.WEBHOOK_IDEMPOTENCY_TTL_SECONDS
      )
    } catch (err) {
      // Store nicht erreichbar (z.B. Redis down). Drei Optionen abgewogen:
      //
      // (a) FAIL-OPEN: trotzdem verarbeiten, ohne Dedup-Garantie.
      // (b) FAIL-CLOSED via `not_supported`: wie einen "unbekannten Status"
      //     behandeln. Das ist ein STILLER Drop — die Webhook-Route
      //     antwortet Payrexx trotzdem mit 2xx (es wird kein Fehler
      //     geworfen), Payrexx stoppt also seine Retries. Die Zahlung wäre
      //     damit UNWIDERRUFLICH verloren, nicht nur verzögert. Nie richtig.
      // (c) FAIL-CLOSED via throw: Route liefert 5xx, Payrexx retried
      //     später erneut — würde Exactly-Once erhalten, ABER nur wenn
      //     Payrexx lange genug retried, um einen Redis-Ausfall zu
      //     überbrücken. Payrexx' Retry-Fenster ist uns nicht bekannt
      //     (nicht öffentlich dokumentiert); ein kurzes Retry-Fenster plus
      //     ein länger andauernder Redis-Ausfall würde die Zahlung dann
      //     genauso verlieren wie (b), nur mit Umweg über mehrere 5xx.
      //
      // Gewählt: (a) FAIL-OPEN. Die Begründung ist modul-spezifisch, nicht
      // generisch: capturePayment() wird in diesem Modul NIE vom Webhook
      // ausgelöst, sondern ausschliesslich vom Admin (siehe
      // capturePayment() oben). Ein doppelt verarbeiteter Webhook kann hier
      // also nie doppelt Geld bewegen — im schlimmsten Fall wird ein
      // bereits gesetzter "authorized"-Status ein zweites Mal gesetzt, was
      // im Payrexx-Dashboard und in der Medusa-Order sichtbar und manuell
      // korrigierbar ist. Ein verlorener Webhook (das Risiko bei (b)/(c) im
      // Fehlerfall) ist dagegen eine bezahlte, nie erfasste Bestellung —
      // für niemanden sichtbar bis zur Kundenreklamation.
      //
      // Wichtig: fail-open gilt NUR für einen geworfenen Fehler des Stores.
      // Eine regulär beantwortete `false` (= "schon gesehen") überspringt
      // IMMER — dieser catch-Block fängt ausschliesslich Store-Ausfälle.
      this.logger_.error(
        `Payrexx idempotency store unavailable (${String(err)}); processing ` +
          `webhook ${idempotencyKey} without duplicate-detection guarantee ` +
          `(fail-open, see comment in getWebhookActionAndData).`
      )
      isNewWebhook = true
    }

    if (!isNewWebhook) {
      this.logger_.info(`Duplicate webhook ignored: ${idempotencyKey}`)
      return { action: "not_supported" }
    }

    // 3. Status-basierte Aktion
    const status = webhookTransaction?.status
    const sessionId = webhookTransaction?.referenceId || (data as any)?.referenceId

    if (!sessionId) {
      this.logger_.warn("Webhook without referenceId (session_id) received.")
      return { action: "not_supported" }
    }

    // 4. Betrag: Payrexx meldet Rappen, Medusa erwartet Dezimalbeträge.
    // Plausibilitätsprüfung — ein Betrag <= 0 oder NaN ist nie legitim.
    const amountInRappen = Number(webhookTransaction?.amount)
    const amountDecimal = amountInRappen / 100

    const requiresAmount = [
      "confirmed",
      "waiting",
      "refunded",
      "partially-refunded",
    ].includes(status)

    if (requiresAmount && (!Number.isFinite(amountInRappen) || amountInRappen <= 0)) {
      this.logger_.error(
        `Payrexx webhook with implausible amount rejected: ${String(webhookTransaction?.amount)} (session ${sessionId})`
      )
      return {
        action: "failed",
        data: { session_id: sessionId, amount: new BigNumber(0) },
      }
    }

    switch (status) {
      case "confirmed":
        return {
          action: "authorized",
          data: {
            session_id: sessionId,
            amount: new BigNumber(amountDecimal),
          },
        }

      case "waiting":
        // Powerpay: Zahlung ist pending (Rechnungskauf)
        return {
          action: "authorized",
          data: {
            session_id: sessionId,
            amount: new BigNumber(amountDecimal),
          },
        }

      case "refunded":
      case "partially-refunded":
        return {
          action: "captured",
          data: {
            session_id: sessionId,
            amount: new BigNumber(amountDecimal),
          },
        }

      case "cancelled":
      case "declined":
      case "error":
        return {
          action: "failed",
          data: {
            session_id: sessionId,
            amount: new BigNumber(
              Number.isFinite(amountDecimal) ? amountDecimal : 0
            ),
          },
        }

      default:
        this.logger_.warn(`Unknown Payrexx webhook status: ${status}`)
        return { action: "not_supported" }
    }
  }
}

export default PayrexxPaymentProviderService
