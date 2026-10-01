/**
 * Weiche für die Redis-Infrastrukturmodule (src/lib/redis-modules.ts).
 *
 * Zwei Dinge dürfen nie still kaputtgehen:
 *
 * 1. OHNE REDIS_URL bleibt es bei Medusas In-Memory-Modulen. Sonst brauchen
 *    lokale Entwicklung, Unit-Tests und `medusa build` plötzlich ein Redis —
 *    die Redis-Module werfen beim Laden, wenn die URL fehlt.
 * 2. MIT REDIS_URL ersetzen die Einträge wirklich die Standardmodule. Ein
 *    Tippfehler im Auflösungspfad liesse den Shop weiter in-memory laufen,
 *    und die einzige Spur wäre eine Logzeile, die niemand liest.
 */

import { defineConfig } from "@medusajs/framework/utils"

import {
  buildRedisModules,
  FAILED_EVENT_MAX_AGE_SECONDS,
  FAILED_EVENT_MAX_COUNT,
  LOCKING_MODULE,
  REDIS_EVENT_BUS,
  REDIS_LOCKING_PROVIDER,
  REDIS_WORKFLOW_ENGINE,
  redisUrlAusEnv,
} from "../lib/redis-modules"

const URL = "redis://redis:6379"

describe("redisUrlAusEnv", () => {
  it("liefert die URL, wenn sie gesetzt ist", () => {
    expect(redisUrlAusEnv({ REDIS_URL: URL })).toBe(URL)
  })

  it.each([[undefined], [""], ["   "]])("%p zählt als «kein Redis»", (wert) => {
    expect(redisUrlAusEnv({ REDIS_URL: wert })).toBeUndefined()
  })
})

describe("buildRedisModules", () => {
  it("ohne REDIS_URL: leere Liste, Medusa nimmt seine Standardmodule", () => {
    expect(buildRedisModules({})).toEqual([])
    expect(buildRedisModules({ REDIS_URL: "" })).toEqual([])
  })

  it("mit REDIS_URL: Event-Bus, Workflow-Engine und Locking", () => {
    const module = buildRedisModules({ REDIS_URL: URL })
    expect(module.map((m) => m.resolve)).toEqual([
      REDIS_EVENT_BUS,
      REDIS_WORKFLOW_ENGINE,
      LOCKING_MODULE,
    ])
  })

  it("Event-Bus: erledigte Jobs sofort weg, fehlgeschlagene begrenzt", () => {
    const [eventBus] = buildRedisModules({ REDIS_URL: URL })
    expect(eventBus.options).toEqual({
      redisUrl: URL,
      jobOptions: {
        // Reset-Token in den Nutzdaten: nichts aufbewahren.
        removeOnComplete: true,
        removeOnFail: {
          age: FAILED_EVENT_MAX_AGE_SECONDS,
          count: FAILED_EVENT_MAX_COUNT,
        },
      },
    })
  })

  it("Event-Bus: keine Wiederholungsversuche (Doppelversand)", () => {
    const [eventBus] = buildRedisModules({ REDIS_URL: URL })
    expect(eventBus.options.jobOptions).not.toHaveProperty("attempts")
  })

  it("Workflow-Engine: `redisUrl`, nicht das veraltete `url`", () => {
    const [, workflows] = buildRedisModules({ REDIS_URL: URL })
    expect(workflows.options).toEqual({ redis: { redisUrl: URL } })
  })

  it("Locking: Redis-Provider als Standard", () => {
    const [, , locking] = buildRedisModules({ REDIS_URL: URL })
    expect(locking.options).toEqual({
      providers: [
        {
          resolve: REDIS_LOCKING_PROVIDER,
          id: "locking-redis",
          is_default: true,
          options: { redisUrl: URL },
        },
      ],
    })
  })

  it("die Auflösungspfade existieren im installierten Medusa", () => {
    for (const pfad of [
      REDIS_EVENT_BUS,
      REDIS_WORKFLOW_ENGINE,
      LOCKING_MODULE,
      REDIS_LOCKING_PROVIDER,
    ]) {
      expect(() => require.resolve(pfad)).not.toThrow()
    }
  })
})

describe("Zusammenspiel mit defineConfig", () => {
  it("mit REDIS_URL ersetzen die Einträge die In-Memory-Standardmodule", () => {
    const config = defineConfig({
      modules: buildRedisModules({ REDIS_URL: URL }),
    })
    const modules = config.modules as Record<string, { resolve: string }>
    expect(modules.event_bus.resolve).toBe(REDIS_EVENT_BUS)
    expect(modules.workflows.resolve).toBe(REDIS_WORKFLOW_ENGINE)
    expect(modules.locking).toMatchObject({
      resolve: LOCKING_MODULE,
      options: { providers: [{ id: "locking-redis", is_default: true }] },
    })
  })

  it("ohne REDIS_URL bleiben die In-Memory-Standardmodule", () => {
    const config = defineConfig({ modules: buildRedisModules({}) })
    const modules = config.modules as Record<
      string,
      { resolve: string; options?: unknown }
    >
    expect(modules.event_bus.resolve).toBe("@medusajs/medusa/event-bus-local")
    expect(modules.workflows.resolve).toBe(
      "@medusajs/medusa/workflow-engine-inmemory"
    )
    expect(modules.locking.resolve).toBe(LOCKING_MODULE)
    expect(modules.locking.options).toBeUndefined()
  })
})
