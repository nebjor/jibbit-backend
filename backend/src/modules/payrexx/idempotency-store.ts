/**
 * Idempotency-Store für Payrexx-Webhooks.
 *
 * Der Store beantwortet eine einzige Frage ATOMAR: "Habe ich `key` schon
 * gesehen?" Prüfen und Setzen müssen EINE Operation sein (`SET key val NX
 * EX ttl`), sonst entsteht ein Read-Then-Write-Race: zwei praktisch
 * gleichzeitige Requests (z.B. Payrexx-Retry und Original, die sich um
 * Millisekunden überholen) lesen beide "noch nicht gesehen" und verarbeiten
 * beide — genau der Bug, den Idempotency verhindern soll. Ein separates
 * `has()` + `add()` (wie das alte in-memory Set es erlaubte) ist deshalb
 * kein gültiger Store mehr, sobald mehr als ein Prozess/Request gleichzeitig
 * läuft — und genau das ist in Produktion (mehrere Instanzen, Webhook-Retries)
 * der Normalfall, nicht die Ausnahme.
 */

import { Redis } from "ioredis"
import type { Logger } from "@medusajs/framework/types"

export interface IdempotencyStore {
  /**
   * Atomic check-and-set.
   *
   * Gibt `true` zurück, wenn `key` NEU ist (Aufrufer soll verarbeiten),
   * `false`, wenn `key` bereits existiert (Aufrufer soll überspringen).
   *
   * Wirft, wenn der Store nicht erreichbar ist — gibt NIEMALS bei einem
   * Fehler synthetisch `true`/`false` zurück. Die Entscheidung, was bei
   * einem Store-Ausfall passiert (fail-open vs. fail-closed), gehört dem
   * AUFRUFER, nicht dem Store. Siehe service.ts, getWebhookActionAndData().
   */
  checkAndSet(key: string, ttlSeconds: number): Promise<boolean>
}

/**
 * In-Memory-Fallback für lokale Entwicklung und für Tests, die keinen
 * Redis-Server hochfahren wollen. Hat exakt die Schwächen des ursprünglichen
 * `processedWebhooks`-Sets (nicht restart-safe, nicht multi-instanz-safe) —
 * das ist hier bewusst akzeptiert, weil dieser Store nur greift, wenn kein
 * REDIS_URL konfiguriert ist. In Produktion MUSS REDIS_URL gesetzt sein;
 * service.ts loggt eine Warnung, falls es das nicht ist.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private seen = new Map<string, number>() // key -> Ablaufzeit (ms epoch)

  async checkAndSet(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const expiresAt = this.seen.get(key)

    if (expiresAt !== undefined && expiresAt > now) {
      return false
    }

    this.seen.set(key, now + ttlSeconds * 1000)
    return true
  }
}

export interface RedisIdempotencyStoreOptions {
  redisUrl: string
  logger?: Logger
}

/**
 * Redis-backed Idempotency-Store. Produktiv-Implementierung.
 *
 * - `SET key value NX EX ttl` ist EINE Redis-Operation → atomar, kein
 *   Read-Then-Write-Race (siehe Interface-Doku oben).
 * - `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` +
 *   `connectTimeout`/`commandTimeout`: Ein Command darf NIE unbegrenzt
 *   hängen bleiben. Ohne diese Limits würde eine halb-offene TCP-Verbindung
 *   den Webhook-Handler auf unbestimmte Zeit blockieren — das ist schlimmer
 *   als jede fail-open/fail-closed-Entscheidung, weil daraus dann weder ein
 *   Duplikat noch ein sauberer Drop entsteht, sondern ein hängender Request
 *   und ein Payrexx-Timeout.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly client: Redis

  constructor(options: RedisIdempotencyStoreOptions) {
    this.client = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      lazyConnect: false,
    })

    // Ohne diesen Listener wirft ein Connection-Error ein unhandled "error"
    // Event auf dem EventEmitter — Node-Default dafür ist, den Prozess
    // abzuschiessen. Das darf ein flackerndes Redis nicht auslösen können.
    this.client.on("error", (err: Error) => {
      options.logger?.error(
        `Payrexx Redis idempotency store connection error: ${err.message}`
      )
    })
  }

  async checkAndSet(key: string, ttlSeconds: number): Promise<boolean> {
    // "OK" = Key wurde neu gesetzt (NX griff). null = Key existierte schon.
    const result = await this.client.set(key, "1", "EX", ttlSeconds, "NX")
    return result === "OK"
  }

  /** Nur für Tests / sauberen Shutdown — kein Teil des IdempotencyStore-Interface. */
  disconnect(): void {
    this.client.disconnect()
  }
}
