/**
 * Gemeinsame Webhook-/Statuslogik für Payrexx.
 *
 * Diese Datei ist die EINE Stelle, an der aus einer Payrexx-Transaktion eine
 * Medusa-Aktion wird. Sie wird von drei Aufrufern benutzt:
 *
 *   1. `PayrexxPaymentProviderService.getWebhookActionAndData()` — der Pfad,
 *      den Medusas eingebaute Route /hooks/payment/payrexx_payrexx nimmt.
 *   2. `src/api/hooks/payment/payrexx/route.ts` — unsere eigene, gehärtete
 *      Webhook-Route (die, die bei Payrexx hinterlegt wird).
 *   3. `src/api/store/payrexx/return/route.ts` — die Rückkehr-Abgleichsroute,
 *      die die Storefront aufruft, wenn der Kunde von Payrexx zurückkommt.
 *
 * Dass alle drei durch `PayrexxWebhookProcessor.evaluateTransaction()` gehen,
 * ist der Kern der Anforderung "Rückkehr und Webhook führen zum selben
 * Ergebnis": beide Pfade treffen dieselbe Entscheidung UND teilen sich
 * denselben Idempotency-Key. Wer zuerst kommt, verarbeitet; der andere sieht
 * ein Duplikat und tut nichts. Erreicht der Kunde die Rückkehrseite nie
 * (Abbruch, Verbindungsabbruch, App-Wechsel), erledigt der Webhook allein
 * die vollständige Bestellung — und umgekehrt, falls Payrexx' Webhook
 * ausbleibt oder verspätet kommt.
 */

import { BigNumber } from "@medusajs/framework/utils"
import type { Logger, WebhookActionResult } from "@medusajs/framework/types"
import { PayrexxClient } from "./client"
import { fromRappen, isPlausibleRappenAmount } from "./amounts"
import type { IdempotencyStore } from "./idempotency-store"
import type { SessionStateStore, PayrexxSessionState } from "./session-store"

/**
 * Transaktions-Ausschnitt, den Payrexx im Webhook-Body unter `transaction`
 * liefert. Bewusst alles optional — der Body kommt von aussen.
 */
export interface PayrexxTransaction {
  id?: number
  status?: string
  /** Betrag in Rappen (siehe amounts.ts). */
  amount?: number
  /** = Medusa payment session id, von uns beim Gateway-Erstellen gesetzt. */
  referenceId?: string
  psp?: string
}

export interface PayrexxDecision {
  action: WebhookActionResult
  /** Einheitliche Log-Ausgabe für alle Aufrufer. */
  log?: { level: "info" | "warn" | "error"; message: string }
}

/**
 * Payrexx-Transaktionsstatus → Medusa-Aktion.
 *
 * Statusliste: https://docs.payrexx.com/developer/guides/webhook
 *
 * Bewusste Entscheidungen:
 *
 * - `confirmed` → "authorized", NICHT "captured". Bei Payrexx ist ein
 *   bestätigtes Gateway ohne Pre-Authorization bereits verbucht; Medusa
 *   bekommt trotzdem nur "authorized", weil `capturePayment()` in diesem
 *   Modul ausschliesslich vom Admin ausgelöst wird. Würde der Webhook
 *   "captured" melden, liefe `capturePaymentWorkflow` los und riefe
 *   `capturePayment()` auf einer bereits verbuchten Transaktion auf.
 *   (capturePayment() ist trotzdem gegen genau diesen Fall abgesichert,
 *   siehe service.ts.)
 *
 * - `waiting` → "authorized". Das ist der Powerpay-/Rechnungskauf-Fall: die
 *   Zahlung ist zugesagt, aber noch nicht beglichen. Wir versenden trotzdem.
 *   Das ist nur korrekt, wenn MF Group das Delkredere-Risiko ab Zusage
 *   trägt — VOR Aktivierung von Powerpay im Vertrag prüfen
 *   (docs/payrexx-go-live.md).
 *
 * - `refunded` / `partially-refunded` → "not_supported" (bisher: "captured").
 *   Medusas Webhook-Aktionen kennen keine Rückerstattung. "captured"
 *   zurückzugeben wäre die falsche Ereignisform — es würde einen CAPTURE
 *   auslösen, also Geld in die GEGENRICHTUNG bewegen, und bei
 *   `partially-refunded` ausserdem mit einem Betrag, dessen Bedeutung
 *   (Gesamtbetrag oder Teilbetrag?) bei Payrexx nicht dokumentiert ist.
 *   Siehe SECURITY-NOTES.md, "Secondary finding". Rückerstattungen laufen
 *   in diesem Modul über den Admin (`refundPayment`); ein Refund, der im
 *   Payrexx-Dashboard ausgelöst wurde, wird hier laut geloggt und muss im
 *   Admin nachgezogen werden.
 */
const AUTHORIZING_STATUSES = new Set([
  "confirmed",
  "authorized",
  "reserved",
  "waiting",
])

const FAILING_STATUSES = new Set([
  "cancelled",
  "canceled",
  "declined",
  "expired",
  "error",
  "chargeback",
])

const REFUND_STATUSES = new Set([
  "refunded",
  "partially-refunded",
  "refundpending",
])

/**
 * Trifft die Entscheidung. Rein, ohne I/O — deshalb direkt testbar.
 *
 * @param expected Der zuletzt für diese Session erzeugte Gateway-Zustand
 *   (Betrag!), falls bekannt. `null` bedeutet "keine Erwartung vorhanden"
 *   (Store leer, abgelaufen oder ausgefallen) — dann wird NICHT abgeglichen,
 *   sondern verarbeitet. Fail-open, wie überall in diesem Modul: ein
 *   verlorener Webhook ist teurer als ein ungeprüfter.
 */
export function decideAction(
  transaction: PayrexxTransaction,
  expected: PayrexxSessionState | null
): PayrexxDecision {
  const status = String(transaction.status ?? "")
  const sessionId = transaction.referenceId

  if (!sessionId) {
    return {
      action: { action: "not_supported" },
      log: {
        level: "warn",
        message:
          "Payrexx webhook without referenceId (Medusa session id) — cannot be attributed to a payment session.",
      },
    }
  }

  if (REFUND_STATUSES.has(status)) {
    return {
      action: { action: "not_supported" },
      log: {
        level: "warn",
        message:
          `Payrexx reported '${status}' for session ${sessionId} (transaction ${transaction.id}). ` +
          `Refunds are not represented by Medusa webhook actions and are NOT applied automatically. ` +
          `If this refund was triggered in the Payrexx dashboard, mirror it in the Medusa Admin.`,
      },
    }
  }

  if (FAILING_STATUSES.has(status)) {
    return {
      action: {
        action: "failed",
        data: { session_id: sessionId, amount: new BigNumber(0) },
      },
      log: {
        level: "info",
        message: `Payrexx transaction ${transaction.id} for session ${sessionId} ended as '${status}'.`,
      },
    }
  }

  if (!AUTHORIZING_STATUSES.has(status)) {
    return {
      action: { action: "not_supported" },
      log: {
        level: "warn",
        message: `Unknown Payrexx transaction status '${status}' (session ${sessionId}) — ignored.`,
      },
    }
  }

  // Ab hier: ein Status, der Geld bedeutet. Betrag muss stimmen.
  const amountInRappen = transaction.amount

  if (!isPlausibleRappenAmount(amountInRappen)) {
    return {
      action: {
        action: "failed",
        data: { session_id: sessionId, amount: new BigNumber(0) },
      },
      log: {
        level: "error",
        message:
          `Payrexx webhook with implausible amount rejected: ${String(amountInRappen)} ` +
          `(session ${sessionId}). Expected a positive integer number of Rappen.`,
      },
    }
  }

  // Preis-Manipulations-/Stale-Gateway-Guard.
  //
  // Payrexx-Gateways sind unveränderlich; ändert sich der Warenkorb, legt
  // updatePayment() einen neuen an und versucht den alten zu löschen. Wenn
  // dieses Löschen scheitert (Payrexx verweigert es, sobald eine Transaktion
  // am Gateway hängt), bleibt ein zweiter, zahlbarer Gateway mit dem ALTEN
  // Betrag und derselben referenceId bestehen. Ein völlig legitimer, korrekt
  // signierter Webhook kann dann einen Betrag melden, der nicht mehr dem
  // Warenkorb entspricht — in beide Richtungen (Kunde zahlt zu wenig, oder
  // zu viel). Siehe SECURITY-NOTES.md.
  //
  // Wir brechen hier bewusst NICHT mit "failed" ab: die Zahlung IST bei
  // Payrexx eingegangen, "failed" würde sie in Medusa als gescheitert
  // markieren und die Diskrepanz verstecken. Stattdessen: nichts
  // automatisch tun, laut loggen, Betreiber entscheidet.
  if (expected && expected.amountInRappen !== amountInRappen) {
    return {
      action: { action: "not_supported" },
      log: {
        level: "error",
        message:
          `PAYREXX AMOUNT MISMATCH — MANUAL REVIEW REQUIRED. Session ${sessionId}: ` +
          `Payrexx reports ${amountInRappen} Rappen (transaction ${transaction.id}, gateway status '${status}'), ` +
          `but the gateway currently registered for this session is ${expected.gatewayId} ` +
          `over ${expected.amountInRappen} Rappen. The order was NOT completed automatically.`,
      },
    }
  }

  return {
    action: {
      action: "authorized",
      data: {
        session_id: sessionId,
        amount: new BigNumber(fromRappen(amountInRappen)),
      },
    },
    log: {
      level: "info",
      message:
        `Payrexx transaction ${transaction.id} for session ${sessionId} is '${status}' ` +
        `(${amountInRappen} Rappen) — authorizing.`,
    },
  }
}

/** Liest die Transaktion aus einem geparsten Webhook-Body. */
export function extractTransaction(data: unknown): PayrexxTransaction | null {
  const tx = (data as { transaction?: unknown } | null | undefined)?.transaction
  if (!tx || typeof tx !== "object") {
    return null
  }
  return tx as PayrexxTransaction
}

/**
 * Payrexx liefert die Signatur in `X-Webhook-Signature`. Node/Express
 * normalisiert Header-Namen auf lowercase; die Grossschreibung und der
 * Legacy-Name bleiben als Fallback stehen, damit eine ältere
 * Payrexx-Konfiguration nicht still ins Leere läuft.
 */
export function extractSignature(headers: Record<string, unknown>): string {
  const bag = headers ?? {}
  const raw =
    bag[PayrexxClient.WEBHOOK_SIGNATURE_HEADER] ??
    bag["X-Webhook-Signature"] ??
    bag["payrexx-signature"] ??
    ""
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "")
}

/**
 * Der Rohkörper MUSS byte-identisch zu dem sein, was Payrexx signiert hat.
 * Ein `JSON.stringify(req.body)` ist dafür NICHT ausreichend — Schlüssel-
 * reihenfolge und Whitespace gehen dabei verloren und die Signatur schlägt
 * fehl. Deshalb ist für die Webhook-Route `preserveRawBody` gesetzt (siehe
 * src/api/middlewares.ts); der JSON.stringify-Zweig hier ist nur ein
 * letzter Notnagel, damit ein fehlkonfigurierter Body-Parser einen
 * verständlichen Signaturfehler statt eines Absturzes produziert.
 */
export function rawBodyToString(rawData: unknown): string {
  if (typeof rawData === "string") {
    return rawData
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8")
  }
  // Medusa serialisiert Buffer über den Event-Bus zu { type: "Buffer", data: [...] }
  const maybeBuffer = rawData as { type?: string; data?: number[] } | null
  if (maybeBuffer?.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
    return Buffer.from(maybeBuffer.data).toString("utf8")
  }
  return JSON.stringify(rawData ?? {})
}

export type WebhookEvaluation =
  | { status: "invalid_signature" }
  | { status: "malformed"; reason: string }
  | { status: "duplicate"; idempotencyKey: string }
  | {
      status: "evaluated"
      idempotencyKey: string | null
      action: WebhookActionResult
    }

export interface PayrexxWebhookProcessorOptions {
  instance: string
  webhookSecret: string
  idempotencyStore: IdempotencyStore
  sessionStore: SessionStateStore
  logger: Logger
  idempotencyTtlSeconds?: number
}

/**
 * TTL für Idempotency-Keys. Payrexx' genaues Retry-Fenster ist uns nicht
 * öffentlich dokumentiert bekannt — 48h ist eine grosszügige Annahme mit
 * Sicherheitsmarge, KEIN verifizierter Wert. Vor Produktivbetrieb mit
 * Payrexx-Support abgleichen.
 */
export const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 48

/** TTL für den Session→Gateway-Zustand. Deckt einen langen Checkout ab. */
export const SESSION_STATE_TTL_SECONDS = 60 * 60 * 24

export class PayrexxWebhookProcessor {
  private readonly options: PayrexxWebhookProcessorOptions
  private readonly ttl: number

  constructor(options: PayrexxWebhookProcessorOptions) {
    this.options = options
    this.ttl = options.idempotencyTtlSeconds ?? WEBHOOK_IDEMPOTENCY_TTL_SECONDS
  }

  get logger(): Logger {
    return this.options.logger
  }

  verifySignature(rawBody: string, signature: string): boolean {
    return PayrexxClient.verifyWebhookSignature(
      rawBody,
      signature,
      this.options.webhookSecret
    )
  }

  /**
   * Idempotency-Key.
   *
   * Namespacing über `instance` (= Payrexx-Merchant-Account = Tenant): selbst
   * wenn sich mehrere Tenants ein Redis teilen, können Transaktions-IDs zweier
   * Tenants sich hier nie überschneiden. Eine blanke Transaktions-ID wäre ein
   * Cross-Tenant-Hazard.
   *
   * Der Status ist Teil des Keys, damit ein späterer Statuswechsel derselben
   * Transaktion (waiting → confirmed) nicht als Duplikat verschluckt wird.
   */
  idempotencyKeyFor(transaction: PayrexxTransaction): string {
    return `payrexx:webhook:${this.options.instance}:${transaction.id}-${transaction.status}`
  }

  sessionStateKeyFor(sessionId: string): string {
    return `payrexx:session:${this.options.instance}:${sessionId}`
  }

  async rememberGateway(
    sessionId: string,
    state: PayrexxSessionState
  ): Promise<void> {
    try {
      await this.options.sessionStore.put(
        this.sessionStateKeyFor(sessionId),
        state,
        SESSION_STATE_TTL_SECONDS
      )
    } catch (err) {
      // Best effort: ohne diesen Eintrag entfällt nur der Betragsabgleich.
      this.options.logger.warn(
        `Payrexx: could not record gateway state for session ${sessionId} (${String(err)}).`
      )
    }
  }

  async forgetGateway(sessionId: string): Promise<void> {
    try {
      await this.options.sessionStore.remove(this.sessionStateKeyFor(sessionId))
    } catch (err) {
      this.options.logger.warn(
        `Payrexx: could not clear gateway state for session ${sessionId} (${String(err)}).`
      )
    }
  }

  /** Voller Weg: Rohkörper + Header → Entscheidung. */
  async evaluateRaw(
    rawData: unknown,
    headers: Record<string, unknown>
  ): Promise<WebhookEvaluation> {
    const rawBody = rawBodyToString(rawData)
    const signature = extractSignature(headers)

    if (!this.verifySignature(rawBody, signature)) {
      // Bewusst ohne die Signatur selbst im Log.
      this.options.logger.error(
        "Payrexx webhook signature verification failed — request rejected."
      )
      return { status: "invalid_signature" }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return { status: "malformed", reason: "body is not valid JSON" }
    }

    const transaction = extractTransaction(parsed)
    if (!transaction) {
      return { status: "malformed", reason: "no 'transaction' object in body" }
    }

    return this.evaluateTransaction(transaction)
  }

  /**
   * Entscheidung für eine bereits extrahierte Transaktion.
   *
   * Diesen Einstieg benutzt auch die Rückkehr-Route: sie holt die Transaktion
   * per API bei Payrexx ab (statt sie signiert geliefert zu bekommen) und
   * schickt sie durch exakt dieselbe Idempotenz- und Entscheidungslogik.
   */
  async evaluateTransaction(
    transaction: PayrexxTransaction
  ): Promise<WebhookEvaluation> {
    if (transaction.id === undefined || transaction.id === null) {
      return { status: "malformed", reason: "transaction without id" }
    }
    if (!transaction.status) {
      return { status: "malformed", reason: "transaction without status" }
    }

    const idempotencyKey = this.idempotencyKeyFor(transaction)

    let isNew: boolean
    try {
      isNew = await this.options.idempotencyStore.checkAndSet(
        idempotencyKey,
        this.ttl
      )
    } catch (err) {
      // FAIL-OPEN. Begründung (unverändert gegenüber der Erstimplementierung):
      //
      // (a) fail-open: verarbeiten ohne Dedup-Garantie.
      // (b) fail-closed als "not_supported": stiller Drop — die Route
      //     antwortet trotzdem 2xx, Payrexx stoppt seine Retries, die
      //     Zahlung ist UNWIDERRUFLICH verloren. Nie richtig.
      // (c) fail-closed via throw: 5xx, Payrexx retried — erhielte
      //     Exactly-Once, aber nur wenn Payrexx lange genug retried, um
      //     einen Redis-Ausfall zu überbrücken. Retry-Fenster unbekannt.
      //
      // Gewählt: (a). capturePayment() wird in diesem Modul NIE vom Webhook
      // ausgelöst, sondern nur vom Admin — ein doppelt verarbeiteter Webhook
      // kann hier also nie doppelt Geld bewegen. Im schlimmsten Fall wird
      // ein bereits gesetzter "authorized"-Status erneut gesetzt, was
      // sichtbar und korrigierbar ist. Ein verlorener Webhook ist dagegen
      // eine bezahlte, nie erfasste Bestellung.
      //
      // Gilt NUR für einen geworfenen Fehler. Ein reguläres `false`
      // (= "schon gesehen") überspringt IMMER.
      this.options.logger.error(
        `Payrexx idempotency store unavailable (${String(err)}); processing ` +
          `webhook ${idempotencyKey} without duplicate-detection guarantee (fail-open).`
      )
      isNew = true
    }

    if (!isNew) {
      this.options.logger.info(`Duplicate webhook ignored: ${idempotencyKey}`)
      return { status: "duplicate", idempotencyKey }
    }

    let expected: PayrexxSessionState | null = null
    if (transaction.referenceId) {
      try {
        expected = await this.options.sessionStore.get(
          this.sessionStateKeyFor(transaction.referenceId)
        )
      } catch (err) {
        this.options.logger.warn(
          `Payrexx: session state lookup failed for ${transaction.referenceId} ` +
            `(${String(err)}) — continuing without the amount cross-check.`
        )
      }
    }

    const decision = decideAction(transaction, expected)

    if (decision.log) {
      this.options.logger[decision.log.level](decision.log.message)
    }

    return {
      status: "evaluated",
      idempotencyKey,
      action: decision.action,
    }
  }

  /**
   * Gibt eine Reservierung zurück, wenn die NACHGELAGERTE Verarbeitung
   * gescheitert ist. Ohne das würde Payrexx' Retry als Duplikat verworfen
   * und die Zahlung stillschweigend verloren gehen.
   */
  async release(idempotencyKey: string): Promise<void> {
    try {
      await this.options.idempotencyStore.release(idempotencyKey)
    } catch (err) {
      this.options.logger.error(
        `Payrexx: could not release idempotency key ${idempotencyKey} ` +
          `(${String(err)}). A Payrexx retry for this event will be treated ` +
          `as a duplicate — this payment may need manual reconciliation.`
      )
    }
  }
}
