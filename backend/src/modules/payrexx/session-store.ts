/**
 * Session-State-Store für Payrexx.
 *
 * Hält pro Medusa-Payment-Session fest, WELCHER Payrexx-Gateway aktuell für
 * sie zuständig ist und über WELCHEN Betrag er lautet.
 *
 * Warum das nötig ist: Payrexx-Gateways sind unveränderlich. Ändert sich der
 * Warenkorb, muss `updatePayment()` den alten Gateway löschen und einen neuen
 * mit derselben `referenceId` (= session_id) anlegen. Das Löschen ist bei
 * Payrexx nicht garantiert erfolgreich — hängt schon eine Transaktion am
 * Gateway (Kunde hat die TWINT-App geöffnet), verweigert Payrexx es. Damit
 * existieren zwei zahlbare Gateways für dieselbe Session, mit
 * unterschiedlichen Beträgen, und ein völlig legitimer, korrekt signierter
 * Webhook kann für einen Betrag eintreffen, der nicht mehr dem Warenkorb
 * entspricht. Beschrieben in SECURITY-NOTES.md.
 *
 * Ohne einen Ort, an dem "der aktuell gültige Betrag dieser Session" steht,
 * kann `getWebhookActionAndData()` diesen Fall nicht erkennen — es sieht nur
 * den Webhook, nicht die Payment Session. Dieser Store ist genau dieser Ort.
 *
 * Der Store ist BEST EFFORT: fällt er aus, wird der Webhook trotzdem
 * verarbeitet (fail-open, dieselbe Begründung wie beim Idempotency-Store in
 * service.ts). Er verschärft die Prüfung, er ist keine Voraussetzung für
 * eine funktionierende Zahlung.
 */

import { Redis } from "ioredis"
import type { Logger } from "@medusajs/framework/types"

export interface PayrexxSessionState {
  /** Payrexx-Gateway-ID, die aktuell für diese Session gilt. */
  gatewayId: number
  /** Betrag dieses Gateways in Rappen (ganze Zahl). */
  amountInRappen: number
  /** Währung, wie sie an Payrexx ging (z.B. "CHF"). */
  currency: string
}

export interface SessionStateStore {
  put(
    sessionId: string,
    state: PayrexxSessionState,
    ttlSeconds: number
  ): Promise<void>
  get(sessionId: string): Promise<PayrexxSessionState | null>
  remove(sessionId: string): Promise<void>
}

/**
 * In-Memory-Variante für lokale Entwicklung und Tests. Wie beim
 * Idempotency-Store gilt: nicht restart-safe, nicht multi-instanz-safe.
 * In Produktion muss REDIS_URL gesetzt sein.
 */
export class InMemorySessionStateStore implements SessionStateStore {
  private entries = new Map<string, { state: PayrexxSessionState; expiresAt: number }>()

  async put(
    sessionId: string,
    state: PayrexxSessionState,
    ttlSeconds: number
  ): Promise<void> {
    this.entries.set(sessionId, {
      state,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
  }

  async get(sessionId: string): Promise<PayrexxSessionState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry) {
      return null
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sessionId)
      return null
    }
    return entry.state
  }

  async remove(sessionId: string): Promise<void> {
    this.entries.delete(sessionId)
  }
}

export interface RedisSessionStateStoreOptions {
  redisUrl: string
  logger?: Logger
}

/**
 * Redis-backed Variante. Timeouts und `enableOfflineQueue: false` aus
 * demselben Grund wie in idempotency-store.ts: ein Command darf den
 * Webhook-Handler nie unbegrenzt blockieren.
 */
export class RedisSessionStateStore implements SessionStateStore {
  private readonly client: Redis

  constructor(options: RedisSessionStateStoreOptions) {
    this.client = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      lazyConnect: false,
    })

    this.client.on("error", (err: Error) => {
      options.logger?.error(
        `Payrexx Redis session store connection error: ${err.message}`
      )
    })
  }

  async put(
    sessionId: string,
    state: PayrexxSessionState,
    ttlSeconds: number
  ): Promise<void> {
    await this.client.set(sessionId, JSON.stringify(state), "EX", ttlSeconds)
  }

  async get(sessionId: string): Promise<PayrexxSessionState | null> {
    const raw = await this.client.get(sessionId)
    if (!raw) {
      return null
    }
    try {
      return JSON.parse(raw) as PayrexxSessionState
    } catch {
      // Kaputter Eintrag ist wie kein Eintrag — der Aufrufer fällt dann
      // auf "keine Erwartung bekannt" zurück, nicht auf einen Fehler.
      return null
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.client.del(sessionId)
  }

  /** Nur für Tests / sauberen Shutdown. */
  disconnect(): void {
    this.client.disconnect()
  }
}
