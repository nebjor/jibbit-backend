/**
 * Gemeinsame Laufzeit-Objekte (Payrexx-Client + Webhook-Processor) für die
 * HTTP-Routen unter src/api.
 *
 * Warum nicht einfach den Provider aus dem Container holen? Payment-Provider
 * werden von Medusa in den Container des PAYMENT-MODULS registriert
 * (`pp_payrexx_payrexx`), nicht in den Request-Scope. Eine API-Route kommt
 * an die Instanz also nicht heran. Sie baut sich deshalb ihre eigenen
 * Objekte — aus denselben Umgebungsvariablen, die medusa-config.ts an den
 * Provider durchreicht, und mit denselben Redis-Keys. Beide Wege sehen
 * dadurch dieselben Idempotency- und Session-State-Einträge.
 */

import type { Logger } from "@medusajs/framework/types"
import { PayrexxClient } from "./client"
import { PayrexxWebhookProcessor } from "./webhook"
import {
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
} from "./idempotency-store"
import {
  InMemorySessionStateStore,
  RedisSessionStateStore,
} from "./session-store"

export interface PayrexxRuntime {
  client: PayrexxClient
  processor: PayrexxWebhookProcessor
  /** false, solange keine Payrexx-Zugangsdaten in der Umgebung stehen. */
  configured: boolean
}

let cached: PayrexxRuntime | null = null

export function getPayrexxRuntime(logger: Logger): PayrexxRuntime {
  if (cached) {
    return cached
  }

  const instance = process.env.PAYREXX_INSTANCE ?? ""
  const apiSecret = process.env.PAYREXX_API_SECRET ?? ""
  const webhookSecret = process.env.PAYREXX_WEBHOOK_SECRET ?? ""
  const redisUrl = process.env.REDIS_URL

  cached = {
    configured: Boolean(instance && apiSecret && webhookSecret),
    client: new PayrexxClient({ instance, apiSecret }),
    processor: new PayrexxWebhookProcessor({
      instance,
      webhookSecret,
      logger,
      idempotencyStore: redisUrl
        ? new RedisIdempotencyStore({ redisUrl, logger })
        : new InMemoryIdempotencyStore(),
      sessionStore: redisUrl
        ? new RedisSessionStateStore({ redisUrl, logger })
        : new InMemorySessionStateStore(),
    }),
  }

  return cached
}

/** Nur für Tests. */
export function __setPayrexxRuntime(runtime: PayrexxRuntime | null): void {
  cached = runtime
}
