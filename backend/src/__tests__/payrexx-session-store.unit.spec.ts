/**
 * Session-State-Store: hält fest, welcher Payrexx-Gateway (und welcher
 * Betrag) für eine Payment Session gerade gilt. Ohne diesen Zustand kann
 * der Webhook-Handler den gemeldeten Betrag gegen nichts abgleichen — er
 * sieht die Payment Session nicht.
 *
 * Redis wird gemockt: der Test prüft, dass die richtigen Kommandos abgesetzt
 * werden, nicht dass Redis funktioniert.
 */

jest.mock("ioredis", () => ({
  Redis: jest.fn(),
}))

import { Redis } from "ioredis"
import {
  InMemorySessionStateStore,
  RedisSessionStateStore,
  type PayrexxSessionState,
} from "../modules/payrexx/session-store"

const RedisMock = Redis as unknown as jest.Mock

const STATE: PayrexxSessionState = {
  gatewayId: 900,
  amountInRappen: 4200,
  currency: "CHF",
}

describe("InMemorySessionStateStore", () => {
  it("returns null for an unknown session", async () => {
    const store = new InMemorySessionStateStore()
    expect(await store.get("payses_unknown")).toBeNull()
  })

  it("returns what was stored", async () => {
    const store = new InMemorySessionStateStore()
    await store.put("payses_1", STATE, 60)
    expect(await store.get("payses_1")).toEqual(STATE)
  })

  it("overwrites the previous gateway when the amount changes", async () => {
    // Genau der Fall, den updatePayment() auslöst: neuer Gateway, neuer
    // Betrag, dieselbe Session. Danach ist NUR der neue Betrag gültig.
    const store = new InMemorySessionStateStore()
    await store.put("payses_1", STATE, 60)
    await store.put("payses_1", { ...STATE, gatewayId: 901, amountInRappen: 8900 }, 60)

    expect(await store.get("payses_1")).toMatchObject({
      gatewayId: 901,
      amountInRappen: 8900,
    })
  })

  it("forgets an expired entry", async () => {
    const store = new InMemorySessionStateStore()
    await store.put("payses_1", STATE, -1)
    expect(await store.get("payses_1")).toBeNull()
  })

  it("removes on demand (payment method changed / session deleted)", async () => {
    const store = new InMemorySessionStateStore()
    await store.put("payses_1", STATE, 60)
    await store.remove("payses_1")
    expect(await store.get("payses_1")).toBeNull()
  })
})

describe("RedisSessionStateStore", () => {
  let setMock: jest.Mock
  let getMock: jest.Mock
  let delMock: jest.Mock
  let onMock: jest.Mock

  beforeEach(() => {
    RedisMock.mockReset()
    setMock = jest.fn().mockResolvedValue("OK")
    getMock = jest.fn()
    delMock = jest.fn().mockResolvedValue(1)
    onMock = jest.fn()
    RedisMock.mockImplementation(() => ({
      set: setMock,
      get: getMock,
      del: delMock,
      on: onMock,
      disconnect: jest.fn(),
    }))
  })

  it("stores the state as JSON with an expiry", async () => {
    const store = new RedisSessionStateStore({ redisUrl: "redis://localhost:6379" })
    await store.put("payrexx:session:tenant-a:payses_1", STATE, 86400)

    expect(setMock).toHaveBeenCalledWith(
      "payrexx:session:tenant-a:payses_1",
      JSON.stringify(STATE),
      "EX",
      86400
    )
  })

  it("reads the state back", async () => {
    getMock.mockResolvedValue(JSON.stringify(STATE))
    const store = new RedisSessionStateStore({ redisUrl: "redis://localhost:6379" })

    expect(await store.get("k")).toEqual(STATE)
  })

  it("treats a missing key as 'no expectation known'", async () => {
    getMock.mockResolvedValue(null)
    const store = new RedisSessionStateStore({ redisUrl: "redis://localhost:6379" })

    expect(await store.get("k")).toBeNull()
  })

  it("treats a corrupt entry as 'no expectation known' rather than throwing", async () => {
    // Ein kaputter Eintrag darf keine bezahlte Bestellung blockieren.
    getMock.mockResolvedValue("{not json")
    const store = new RedisSessionStateStore({ redisUrl: "redis://localhost:6379" })

    expect(await store.get("k")).toBeNull()
  })

  it("registers an error listener so a flaky connection cannot crash the process", () => {
    // eslint-disable-next-line no-new
    new RedisSessionStateStore({ redisUrl: "redis://localhost:6379" })
    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function))
  })
})
