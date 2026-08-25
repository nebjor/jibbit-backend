/**
 * Payrexx API Client für jibbit.ch
 * Kapselt alle HTTP-Kommunikation mit der Payrexx REST API (v1.0).
 *
 * Flow:
 * 1. Gateway erstellen → Redirect-URL erhalten (TWINT/Powerpay)
 * 2. Webhook empfangen → HMAC validieren → Status aktualisieren
 * 3. Capture/Refund über Transaction-Endpoints
 */

import axios, { AxiosInstance } from "axios"
import crypto from "crypto"

export interface PayrexxGatewayRequest {
  amount: number // in Rappen (cents)
  currency: string // CHF
  purpose: string
  successRedirectUrl: string
  failedRedirectUrl: string
  cancelRedirectUrl?: string
  referenceId: string // Medusa session_id
  psp?: number[] // PSP IDs (TWINT, Powerpay)
  pm?: string[] // Payment method names
  fields?: Record<string, { value: string }>
  basket?: Array<{
    name: string
    description?: string
    quantity: number
    amount: number
    vatRate?: number
  }>
}

export interface PayrexxGatewayResponse {
  status: string
  data: Array<{
    id: number
    hash: string
    link: string
    status: string
    referenceId: string
    invoices?: Array<{
      transactions?: Array<{
        id: number
        status: string
        /** In Rappen — siehe amounts.ts. */
        amount: number
        /** = Medusa payment session id (wir setzen sie beim Erstellen). */
        referenceId?: string
        psp?: string
      }>
    }>
  }>
}

export interface PayrexxTransactionResponse {
  status: string
  data: Array<{
    id: number
    status: string
    /** In Rappen — siehe amounts.ts. */
    amount: number
    referenceId?: string
    time?: string
    psp?: string
  }>
}

/**
 * Zieht die (einzige) Transaktion aus einer Gateway-Antwort.
 *
 * Payrexx hängt Transaktionen unter `invoices[].transactions[]`. Ein Gateway
 * ohne Transaktion ist der Normalfall, solange der Kunde noch nicht bezahlt
 * hat — deshalb `undefined` statt eines Fehlers.
 *
 * Bewusst die LETZTE statt der ersten Transaktion: Payrexx hängt bei einem
 * Fehlversuch mit anschliessend erfolgreichem zweitem Anlauf beide an
 * dasselbe Gateway, und massgeblich ist der jüngste Stand.
 */
export function extractGatewayTransaction(
  gateway: PayrexxGatewayResponse["data"][number] | undefined
):
  | { id: number; status: string; amount: number; referenceId?: string; psp?: string }
  | undefined {
  const transactions = (gateway?.invoices ?? []).flatMap(
    (invoice) => invoice.transactions ?? []
  )
  return transactions.length ? transactions[transactions.length - 1] : undefined
}

export interface PayrexxClientOptions {
  instance: string
  apiSecret: string
  /**
   * Basis-Adresse der REST API, inklusive Versionspfad.
   *
   * Default ist Payrexx selbst. White-Label-Betreiber derselben Plattform
   * sprechen dieselbe API unter eigenem Host — zahls.ch (siebenberge gmbh)
   * z.B. unter `https://api.zahls.ch/v1.0/`. Beleg: das offizielle
   * zahls.ch-WooCommerce-Plugin bündelt den Payrexx-PHP-Client mit
   * `API_URL_BASE_DOMAIN = 'zahls.ch'` und URL-Schema `https://api.%s/…`.
   * Der Wert kommt aus `PAYREXX_API_BASE_URL`; ohne ihn ändert sich nichts.
   */
  baseUrl?: string
}

/** Payrexx' eigener API-Host — der Default, wenn nichts konfiguriert ist. */
export const DEFAULT_PAYREXX_API_BASE_URL = "https://api.payrexx.com/v1.0/"

/**
 * Normalisiert und validiert die konfigurierte API-Basis-Adresse.
 *
 * - leer/undefined → Payrexx-Default (bestehende Installationen unverändert)
 * - fehlender Slash am Ende wird ergänzt (axios hängt relative Pfade sonst an
 *   das letzte Segment: aus `…/v1.0` + `Gateway/` würde `…/Gateway/`)
 * - alles ausser `https:` wird abgelehnt, denn über diese Verbindung wandert
 *   das API-Secret. Einzige Ausnahme: `http://localhost|127.0.0.1` für Tests
 *   gegen einen lokal nachgebauten Server.
 *
 * Wirft bei einem unbrauchbaren Wert sofort — ein Tippfehler in der .env soll
 * beim Start knallen, nicht erst beim ersten Bezahlversuch eines Kunden.
 */
export function normalizePayrexxApiBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim()
  if (!value) {
    return DEFAULT_PAYREXX_API_BASE_URL
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      `PAYREXX_API_BASE_URL is not a valid URL: '${value}'. ` +
        `Expected e.g. 'https://api.payrexx.com/v1.0/' or 'https://api.zahls.ch/v1.0/'.`
    )
  }

  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1"

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error(
      `PAYREXX_API_BASE_URL must use https (got '${value}'). ` +
        `The API secret travels over this connection.`
    )
  }

  return value.endsWith("/") ? value : `${value}/`
}

export class PayrexxClient {
  private httpClient: AxiosInstance
  private apiSecret: string
  private instance: string
  /** Nur für Diagnose/Tests lesbar — nie zusammen mit Secrets loggen. */
  readonly baseUrl: string

  constructor(options: PayrexxClientOptions) {
    this.instance = options.instance
    this.apiSecret = options.apiSecret
    this.baseUrl = normalizePayrexxApiBaseUrl(options.baseUrl)

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })

    // ─── Warum dieser Interceptor ──────────────────────────────────────────
    //
    // Axios wirft bei einem Fehlerstatus mit der Meldung «Request failed with
    // status code 403» — und sonst nichts. Payrexx legt den GRUND aber in den
    // Antwortkoerper (`{"status":"error","message":"…"}`). Ohne diesen
    // Interceptor landet im Log nur die Statuszahl, und ein 403 kann dann
    // ebenso gut ein falscher Schluessel, eine falsche Instanz oder der
    // falsche Host sein. Das hat hier bereits eine Fehlersuche gekostet.
    //
    // Bewusst NICHT protokolliert wird der Query-String: dort steht die
    // `ApiSignature`. Sie ist zwar nicht der Schluessel selbst, aber ein aus
    // ihm abgeleiteter Wert — der gehoert nicht in Containerlogs, die
    // weitergereicht und archiviert werden. Deshalb wird die Adresse am `?`
    // abgeschnitten.
    this.httpClient.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error?.response?.status
        if (!status) {
          return Promise.reject(error)
        }

        const data = error?.response?.data
        let detail: string
        try {
          detail = typeof data === "string" ? data : JSON.stringify(data)
        } catch {
          detail = String(data)
        }

        const method = String(error?.config?.method ?? "").toUpperCase()
        const path = String(error?.config?.url ?? "").split("?")[0]

        error.message =
          `Payrexx API ${status} on ${method} ${path} — ` +
          `${(detail ?? "").slice(0, 400)}`

        return Promise.reject(error)
      }
    )
  }

  /**
   * HMAC-SHA256 Signatur für ausgehende Payrexx API Requests (`ApiSignature`).
   *
   * Payrexx spezifiziert für die REST API eine BASE64-kodierte HMAC-SHA256
   * über den Query-String (ohne den Parameter `instance`) — bewusst ein
   * anderes Encoding als bei den eingehenden Webhooks (dort HEX).
   * Die Asymmetrie ist kein Bug.
   *
   * Quelle: https://developers.payrexx.com/reference/rest-api
   * "Build url encoded query string, calculate binary hmac hash using your
   *  instance's API Secret as key, encode it with base64."
   */
  private buildSignature(queryString: string): string {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(queryString)
      .digest("base64")
  }

  /**
   * RFC-1738-Encoding, wie es Payrexx für den signierten Query-String
   * verlangt: "The query string has to be RFC 1738 encoded, that means you
   * have to replace spaces by '+'."
   *
   * encodeURIComponent() kodiert Leerzeichen als %20. Da `purpose` immer ein
   * Leerzeichen enthält ("jibbit.ch Bestellung"), hätte JEDE Gateway-Anfrage
   * eine nicht verifizierbare Signatur produziert. Signatur und Body werden
   * aus demselben String gebaut, die Umstellung ist also konsistent.
   */
  private static rfc1738(value: string | number | boolean): string {
    return encodeURIComponent(String(value)).replace(/%20/g, "+")
  }

  /**
   * Header, in dem Payrexx die Webhook-Signatur ausliefert.
   * https://docs.payrexx.com/developer/guides/webhook
   */
  static readonly WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature"

  /**
   * Validiert eingehende Webhook-Signaturen (HMAC-SHA256, lowercase HEX).
   * Schützt gegen Webhook Forgery (OWASP).
   *
   * Payrexx: "The signature is provided in the X-Webhook-Signature HTTP header
   * and is generated as a lowercase hex-encoded SHA-256 HMAC."
   *
   * Gibt IMMER einen Boolean zurück — auch bei leerer, zu kurzer oder
   * nicht-hexadezimaler Signatur. (crypto.timingSafeEqual wirft bei
   * ungleicher Buffer-Länge eine RangeError; ein Angreifer könnte damit
   * eine leere Signatur schicken und einen 500er statt eines 401 erzeugen.)
   */
  static verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string
  ): boolean {
    if (!signature || !secret) {
      return false
    }

    const computed = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex")

    const normalized = signature.trim().toLowerCase()

    // Buffer.from(x, "hex") verschluckt ungültige Zeichen still —
    // deshalb Format und Länge vorab prüfen.
    if (normalized.length !== computed.length) {
      return false
    }
    if (!/^[0-9a-f]+$/.test(normalized)) {
      return false
    }

    // Timing-safe comparison gegen Timing-Attacken
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(normalized, "hex")
    )
  }

  /**
   * Gateway erstellen (= Payment Session bei Payrexx).
   * Gibt eine Redirect-URL zurück, wohin der Kunde weitergeleitet wird.
   */
  async createGateway(
    request: PayrexxGatewayRequest
  ): Promise<PayrexxGatewayResponse> {
    const params: Record<string, string | number | boolean> = {
      amount: request.amount,
      currency: request.currency,
      purpose: request.purpose,
      successRedirectUrl: request.successRedirectUrl,
      failedRedirectUrl: request.failedRedirectUrl,
      referenceId: request.referenceId,
    }

    if (request.cancelRedirectUrl) {
      params.cancelRedirectUrl = request.cancelRedirectUrl
    }

    // Build query string for signature (RFC 1738 — Leerzeichen als "+")
    const enc = PayrexxClient.rfc1738
    const queryParts: string[] = []
    for (const [key, val] of Object.entries(params)) {
      queryParts.push(`${enc(key)}=${enc(val)}`)
    }

    // PSP IDs hinzufügen (TWINT, Powerpay)
    if (request.psp?.length) {
      request.psp.forEach((pspId, i) => {
        queryParts.push(`psp%5B${i}%5D=${pspId}`)
      })
    }

    // Payment method names
    if (request.pm?.length) {
      request.pm.forEach((pm, i) => {
        queryParts.push(`pm%5B${i}%5D=${enc(pm)}`)
      })
    }

    // Kontaktdaten
    if (request.fields) {
      for (const [fieldKey, fieldVal] of Object.entries(request.fields)) {
        queryParts.push(
          `fields%5B${enc(fieldKey)}%5D%5Bvalue%5D=${enc(fieldVal.value)}`
        )
      }
    }

    const queryString = queryParts.join("&")
    const apiSignature = this.buildSignature(queryString)

    const body = `${queryString}&ApiSignature=${encodeURIComponent(apiSignature)}`

    const response = await this.httpClient.post<PayrexxGatewayResponse>(
      `Gateway/?instance=${this.instance}`,
      body
    )

    return response.data
  }

  /**
   * Gateway-Status abrufen
   */
  async retrieveGateway(gatewayId: number): Promise<PayrexxGatewayResponse> {
    const queryString = ""
    const apiSignature = this.buildSignature(queryString)

    const response = await this.httpClient.get<PayrexxGatewayResponse>(
      `Gateway/${gatewayId}/?instance=${this.instance}&ApiSignature=${encodeURIComponent(apiSignature)}`
    )

    return response.data
  }

  /**
   * Gateway löschen (Payment Session canceln)
   */
  async deleteGateway(gatewayId: number): Promise<void> {
    const queryString = ""
    const apiSignature = this.buildSignature(queryString)

    await this.httpClient.delete(
      `Gateway/${gatewayId}/?instance=${this.instance}&ApiSignature=${encodeURIComponent(apiSignature)}`
    )
  }

  /**
   * Transaktion capturen
   */
  async captureTransaction(transactionId: number): Promise<PayrexxTransactionResponse> {
    const queryString = `id=${transactionId}`
    const apiSignature = this.buildSignature(queryString)

    const response = await this.httpClient.post<PayrexxTransactionResponse>(
      `Transaction/${transactionId}/capture/?instance=${this.instance}`,
      `${queryString}&ApiSignature=${encodeURIComponent(apiSignature)}`
    )

    return response.data
  }

  /**
   * Transaktion refunden
   */
  async refundTransaction(
    transactionId: number,
    amount: number
  ): Promise<PayrexxTransactionResponse> {
    const queryString = `amount=${amount}`
    const apiSignature = this.buildSignature(queryString)

    const response = await this.httpClient.post<PayrexxTransactionResponse>(
      `Transaction/${transactionId}/refund/?instance=${this.instance}`,
      `${queryString}&ApiSignature=${encodeURIComponent(apiSignature)}`
    )

    return response.data
  }

  /**
   * Transaktion abrufen
   */
  async retrieveTransaction(transactionId: number): Promise<PayrexxTransactionResponse> {
    const queryString = ""
    const apiSignature = this.buildSignature(queryString)

    const response = await this.httpClient.get<PayrexxTransactionResponse>(
      `Transaction/${transactionId}/?instance=${this.instance}&ApiSignature=${encodeURIComponent(apiSignature)}`
    )

    return response.data
  }
}
