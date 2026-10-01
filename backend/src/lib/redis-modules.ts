/**
 * Infrastruktur-Module auf Redis: Event-Bus, Workflow-Engine, Locking.
 *
 * WARUM: Ohne diese Einträge lädt Medusa die Standardmodule, und die laufen
 * alle im Arbeitsspeicher des Node-Prozesses. `projectConfig.redisUrl` allein
 * ändert daran nichts — der Wert bedient nur den Session-Store. Im Log steht
 * dann:
 *
 *   Local Event Bus installed. This is not recommended for production.
 *   Locking module: Using "in-memory" as default.
 *
 * Für den Shop heisst das: ein Ereignis, das beim Neustart des Containers
 * (Deploy, OOM, Reboot der VPS) noch nicht verarbeitet ist, ist weg — und mit
 * ihm die Bestellbestätigung, die Versandmail oder die Passwort-Mail, die ein
 * Subscriber daraus gemacht hätte. Mit dem Redis-Event-Bus liegt das Ereignis
 * als Job in Redis und wird nach dem Neustart abgearbeitet.
 *
 * NUR MIT `REDIS_URL`: Ohne die Variable liefert die Funktion eine leere
 * Liste, und es bleibt bei den Standardmodulen. So laufen lokale Entwicklung,
 * Unit-Tests, `medusa build` (im Dockerfile ist REDIS_URL zur Bauzeit nicht
 * gesetzt) und `medusa exec` ausserhalb des Containers weiter ohne Redis.
 *
 * Alle drei Pakete sind bereits Abhängigkeiten von `@medusajs/medusa` — es
 * kommt kein neues Paket dazu, das Image wird nicht grösser.
 *
 * Betrieb und Kontrolle auf dem Server: docs/redis.md
 */

/** Auflösungspfade, wie sie Medusa 2.13.6 kennt (geprüft in node_modules). */
export const REDIS_EVENT_BUS = "@medusajs/medusa/event-bus-redis"
export const REDIS_WORKFLOW_ENGINE = "@medusajs/medusa/workflow-engine-redis"
export const LOCKING_MODULE = "@medusajs/medusa/locking"
export const REDIS_LOCKING_PROVIDER = "@medusajs/medusa/locking-redis"

/**
 * Wie lange ein FEHLGESCHLAGENER Event-Job in Redis liegen bleibt.
 *
 * BullMQ räumt fehlgeschlagene Jobs von sich aus nie weg. Auf einer kleinen
 * VPS und mit `maxmemory-policy noeviction` (docker-compose.yml) wäre das
 * eine Frage der Zeit, bis Redis voll ist und Schreibzugriffe ablehnt.
 * Eine Woche reicht, um nach einem Vorfall nachzusehen.
 */
export const FAILED_EVENT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
export const FAILED_EVENT_MAX_COUNT = 500

type Env = Record<string, string | undefined>

export type RedisModuleEintrag = {
  resolve: string
  options: Record<string, unknown>
}

/** Gesetzt und nicht nur Leerzeichen — `REDIS_URL=` in der .env zählt als «kein Redis». */
export function redisUrlAusEnv(env: Env): string | undefined {
  const url = env.REDIS_URL?.trim()
  return url ? url : undefined
}

export function buildRedisModules(env: Env): RedisModuleEintrag[] {
  const redisUrl = redisUrlAusEnv(env)
  if (!redisUrl) {
    return []
  }

  return [
    {
      resolve: REDIS_EVENT_BUS,
      options: {
        redisUrl,
        jobOptions: {
          // Erledigte Jobs SOFORT löschen (das ist auch der Default des
          // Moduls, hier ausdrücklich, damit es niemand «zum Nachsehen»
          // lockert): die Nutzdaten von `auth.password_reset` enthalten das
          // Reset-Token. Ein aufbewahrter Job wäre ein Zugang zum Konto, der
          // in Redis und in dessen AOF-Datei herumliegt.
          removeOnComplete: true,
          removeOnFail: {
            age: FAILED_EVENT_MAX_AGE_SECONDS,
            count: FAILED_EVENT_MAX_COUNT,
          },
          // Bewusst KEIN `attempts`: die Mail-Subscriber fangen ihre Fehler
          // selbst ab und werfen nie (siehe src/lib/notify.ts) — ein
          // Wiederholungsversuch würde für sie nie ausgelöst. Wer das ändert,
          // muss zuerst jeden Subscriber gegen Doppelversand absichern.
        },
      },
    },
    {
      resolve: REDIS_WORKFLOW_ENGINE,
      options: {
        // `redisUrl`, nicht `url`: `url` ist seit 2.12.2 veraltet und
        // schreibt bei jedem Start eine Warnung ins Log.
        redis: { redisUrl },
      },
    },
    {
      resolve: LOCKING_MODULE,
      options: {
        providers: [
          {
            resolve: REDIS_LOCKING_PROVIDER,
            id: "locking-redis",
            // Ohne `is_default` bleibt "in-memory" der Standard, und der
            // Redis-Provider wäre nur auf ausdrücklichen Wunsch im Einsatz.
            is_default: true,
            options: { redisUrl },
          },
        ],
      },
    },
  ]
}
