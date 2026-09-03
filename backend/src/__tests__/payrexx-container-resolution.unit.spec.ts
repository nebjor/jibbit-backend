/**
 * Der Provider muss sich mit Medusas ECHTEM Container erzeugen lassen.
 *
 * ─── Der Fehler, den diese Datei festhält ──────────────────────────────────
 *
 * Der Constructor las `container.idempotencyStore ?? fallback` und erwartete
 * bei fehlender Registrierung ein `undefined`. Medusa reicht zur Laufzeit aber
 * Awilix' Cradle-Proxy herein, und der WIRFT beim Zugriff auf einen nicht
 * registrierten Namen:
 *
 *   AwilixResolutionError: Could not resolve 'idempotencyStore'.
 *   Resolution path: pp_payrexx_payrexx -> idempotencyStore
 *
 * Folge: der Provider liess sich nicht erzeugen, Medusa meldete «Unable to
 * retrieve the payment provider with id: pp_payrexx_payrexx», und die Kasse
 * antwortete dem Kunden mit 500. Die Meldung zeigt auf eine falsche
 * Konfiguration — obwohl die Konfiguration stimmte.
 *
 * ─── Warum die Testsuite gruen blieb ───────────────────────────────────────
 *
 * Alle bisherigen Tests uebergeben ein schlichtes Objekt als Container. Dort
 * IST ein fehlender Schluessel `undefined`, und der Fallback greift. Der
 * Unterschied zwischen Objekt und Proxy war die ganze Luecke.
 *
 * Deshalb bildet dieser Test den Proxy nach, statt ein Objekt zu benutzen.
 */

import PayrexxPaymentProviderService from "../modules/zahls/service"

const loggerStub = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any

const OPTIONS = {
  instance: "jibbit",
  apiSecret: "test-secret",
  webhookSecret: "test-webhook-secret",
  enabledPsps: [],
}

/**
 * Awilix' Cradle nachgebaut: registrierte Namen kommen zurueck, alles andere
 * wirft — genau wie im laufenden Medusa.
 */
function awilixLikeContainer(registered: Record<string, unknown>) {
  return new Proxy(registered, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      throw new Error(
        `AwilixResolutionError: Could not resolve '${String(prop)}'.`
      )
    },
    has() {
      return true
    },
  })
}

describe("Erzeugung mit Medusas Container", () => {
  const REDIS = process.env.REDIS_URL

  afterEach(() => {
    if (REDIS === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = REDIS
  })

  it("laesst sich erzeugen, wenn NUR der logger registriert ist", () => {
    delete process.env.REDIS_URL
    const container = awilixLikeContainer({ logger: loggerStub })

    expect(
      () => new PayrexxPaymentProviderService(container as any, OPTIONS as any)
    ).not.toThrow()
  })

  it("warnt dabei vor dem Speicher-Rueckfall statt zu sterben", () => {
    delete process.env.REDIS_URL
    loggerStub.warn.mockClear()
    const container = awilixLikeContainer({ logger: loggerStub })

    new PayrexxPaymentProviderService(container as any, OPTIONS as any)

    expect(loggerStub.warn).toHaveBeenCalled()
    expect(String(loggerStub.warn.mock.calls[0][0])).toContain("REDIS_URL")
  })

  // Bewusst KEIN Fall mit gesetztem REDIS_URL: der Constructor baut dann eine
  // echte Redis-Verbindung auf, die im Test niemand annimmt — der Prozess
  // bleibt offen und die Suite haengt. Der Redis-Pfad ist ohnehin nicht das,
  // was hier auf dem Spiel steht.

  it("nimmt injizierte Speicher weiterhin an (Objekt-Container aus den Tests)", () => {
    delete process.env.REDIS_URL
    const idempotencyStore = { seen: jest.fn(), remember: jest.fn(), release: jest.fn() }
    const sessionStateStore = { get: jest.fn(), set: jest.fn(), delete: jest.fn() }

    expect(
      () =>
        new PayrexxPaymentProviderService(
          { logger: loggerStub, idempotencyStore, sessionStateStore } as any,
          OPTIONS as any
        )
    ).not.toThrow()
  })
})
