/**
 * Tests für die IdempotencyStore-Implementierungen selbst
 * (backend/src/modules/payrexx/idempotency-store.ts).
 *
 * RedisIdempotencyStore wird gegen ein gemocktes `ioredis` getestet, nicht
 * gegen einen echten Redis-Server — der Test prüft, dass das RICHTIGE
 * Redis-Kommando aufgerufen wird (`SET key val EX ttl NX`, atomar) und dass
 * ein Verbindungsfehler durchgereicht (nicht verschluckt) wird. Ob ein
 * echtes Redis dieses Kommando korrekt ausführt, ist Vertrauen in Redis
 * selbst, nicht Teil dieses Moduls.
 */

jest.mock("ioredis", () => ({
  Redis: jest.fn(),
}))

import { Redis } from "ioredis"
import {
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
} from "../modules/payrexx/idempotency-store"

const RedisMock = Redis as unknown as jest.Mock

describe("InMemoryIdempotencyStore", () => {
  it("returns true for a key seen for the first time", async () => {
    const store = new InMemoryIdempotencyStore()
    expect(await store.checkAndSet("a", 60)).toBe(true)
  })

  it("returns false for a repeat of the same key", async () => {
    const store = new InMemoryIdempotencyStore()
    await store.checkAndSet("a", 60)
    expect(await store.checkAndSet("a", 60)).toBe(false)
  })

  it("treats different keys independently (no cross-key collision)", async () => {
    const store = new InMemoryIdempotencyStore()
    expect(await store.checkAndSet("payrexx:webhook:tenant-a:1-confirmed", 60)).toBe(true)
    expect(await store.checkAndSet("payrexx:webhook:tenant-b:1-confirmed", 60)).toBe(true)
  })

  it("makes a released key processable again", async () => {
    // Wird gebraucht, wenn die Verarbeitung NACH der Reservierung scheitert:
    // ohne release() würde Payrexx' Retry als Duplikat verworfen und die
    // bezahlte Bestellung wäre still verloren.
    const store = new InMemoryIdempotencyStore()

    expect(await store.checkAndSet("k", 60)).toBe(true)
    expect(await store.checkAndSet("k", 60)).toBe(false)

    await store.release("k")

    expect(await store.checkAndSet("k", 60)).toBe(true)
  })
})

describe("RedisIdempotencyStore", () => {
  let setMock: jest.Mock
  let delMock: jest.Mock
  let onMock: jest.Mock

  beforeEach(() => {
    RedisMock.mockReset()
    setMock = jest.fn()
    delMock = jest.fn().mockResolvedValue(1)
    onMock = jest.fn()
    RedisMock.mockImplementation(() => ({
      set: setMock,
      del: delMock,
      on: onMock,
      disconnect: jest.fn(),
    }))
  })

  it("issues a single atomic SET key val EX ttl NX command", async () => {
    setMock.mockResolvedValue("OK")

    const store = new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })
    await store.checkAndSet("payrexx:webhook:tenant-a:1-confirmed", 172800)

    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith(
      "payrexx:webhook:tenant-a:1-confirmed",
      "1",
      "EX",
      172800,
      "NX"
    )
  })

  it("returns true when SET ... NX reports the key was newly set (\"OK\")", async () => {
    setMock.mockResolvedValue("OK")
    const store = new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })

    expect(await store.checkAndSet("k", 100)).toBe(true)
  })

  it("returns false when SET ... NX reports the key already existed (null)", async () => {
    setMock.mockResolvedValue(null)
    const store = new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })

    expect(await store.checkAndSet("k", 100)).toBe(false)
  })

  it("propagates a connection/command failure instead of swallowing it", async () => {
    setMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const store = new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })

    // Der Store selbst entscheidet NICHT fail-open/fail-closed — das ist
    // Aufgabe des Aufrufers (siehe service.ts). Der Store muss den Fehler
    // deshalb einfach durchreichen.
    await expect(store.checkAndSet("k", 100)).rejects.toThrow("ECONNREFUSED")
  })

  it("releases a reservation with DEL", async () => {
    const store = new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })
    await store.release("payrexx:webhook:tenant-a:1-confirmed")

    expect(delMock).toHaveBeenCalledWith("payrexx:webhook:tenant-a:1-confirmed")
  })

  it("registers an error listener so a flaky connection cannot crash the process", () => {
    // eslint-disable-next-line no-new
    new RedisIdempotencyStore({ redisUrl: "redis://localhost:6379" })

    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function))
  })
})
