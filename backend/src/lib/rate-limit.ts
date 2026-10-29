/**
 * Einfacher Zähler pro Schlüssel im Arbeitsspeicher (festes Zeitfenster).
 *
 * Gilt nur für diesen Prozess und endet mit dem Neustart — für «ein paar
 * Wünsche pro Stunde und Adresse» genügt das. Er FÄLLT ZU: ohne Schlüssel
 * oder bei voller Tabelle wird abgelehnt, nie durchgelassen.
 */

export interface RateLimitResult {
  allowed: boolean
  /** Sekunden bis zum nächsten möglichen Versuch (nur bei `allowed: false`). */
  retryAfterSeconds: number
}

export interface RateLimiter {
  check(key: string | undefined, now?: number): RateLimitResult
}

export interface RateLimiterOptions {
  max: number
  windowMs: number
  /** Obergrenze für die Zahl gleichzeitig geführter Schlüssel. */
  maxKeys?: number
}

export function createRateLimiter({ max, windowMs, maxKeys = 10_000 }: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>()

  function prune(now: number) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key)
    }
  }

  const full = () => ({ allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) })

  return {
    check(key, now = Date.now()) {
      if (!key) return full()

      let entry = hits.get(key)
      if (entry && entry.resetAt <= now) {
        hits.delete(key)
        entry = undefined
      }
      if (!entry) {
        if (hits.size >= maxKeys) prune(now)
        // Tabelle voll und nichts abgelaufen: lieber ablehnen als unbegrenzt wachsen.
        if (hits.size >= maxKeys) return full()
        entry = { count: 0, resetAt: now + windowMs }
        hits.set(key, entry)
      }

      if (entry.count >= max) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
      }
      entry.count += 1
      return { allowed: true, retryAfterSeconds: 0 }
    },
  }
}
