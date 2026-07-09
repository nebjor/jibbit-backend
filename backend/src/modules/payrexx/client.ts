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
import qs from "querystring"

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
        amount: number
      }>
    }>
  }>
}

export interface PayrexxTransactionResponse {
  status: string
  data: Array<{
    id: number
    status: string
    amount: number
    referenceId: string
    time: string
    psp: string
  }>
}

export interface PayrexxClientOptions {
  instance: string
  apiSecret: string
}

export class PayrexxClient {
  private httpClient: AxiosInstance
  private apiSecret: string
  private instance: string

  constructor(options: PayrexxClientOptions) {
    this.instance = options.instance
    this.apiSecret = options.apiSecret

    this.httpClient = axios.create({
      baseURL: `https://api.payrexx.com/v1.0/`,
      timeout: 15000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })
  }

  /**
   * HMAC-SHA256 Signatur für Payrexx API Requests
   */
  private buildSignature(queryString: string): string {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(queryString)
      .digest("base64")
  }

  /**
   * Validiert eingehende Webhook-Signaturen (HMAC-SHA256).
   * Schützt gegen Webhook Forgery (OWASP).
   */
  static verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string
  ): boolean {
    const computed = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex")

    // Timing-safe comparison gegen Timing-Attacken
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signature, "hex")
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

    // Build query string for signature
    const queryParts: string[] = []
    for (const [key, val] of Object.entries(params)) {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
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
        queryParts.push(`pm%5B${i}%5D=${encodeURIComponent(pm)}`)
      })
    }

    // Kontaktdaten
    if (request.fields) {
      for (const [fieldKey, fieldVal] of Object.entries(request.fields)) {
        queryParts.push(
          `fields%5B${encodeURIComponent(fieldKey)}%5D%5Bvalue%5D=${encodeURIComponent(fieldVal.value)}`
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
