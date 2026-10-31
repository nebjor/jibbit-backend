/**
 * Produktwunsch aus dem Shop: Validierung, Zähler, Mail-Darstellung, Route.
 */

import { PostProduktwunschSchema } from "../api/store/produktwunsch/validators"
import { clientKey } from "../lib/client-key"
import { renderProduktwunsch, renderProduktwunschPush } from "../lib/produktwunsch"
import { createRateLimiter } from "../lib/rate-limit"

describe("PostProduktwunschSchema", () => {
  it("nimmt einen Wunsch mit Kontext an und trimmt", () => {
    const r = PostProduktwunschSchema.safeParse({
      wunsch: "  Blättchen XL  ",
      email: " a@b.ch ",
      kontext: { kategorie: "Papers", suche: "", url: "https://jibbit.ch/?kategorie=papers" },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.wunsch).toBe("Blättchen XL")
      expect(r.data.email).toBe("a@b.ch")
      expect(r.data.kontext.suche).toBeUndefined()
      expect(r.data.kontext.kategorie).toBe("Papers")
    }
  })

  it("braucht keine E-Mail und keinen Kontext", () => {
    const r = PostProduktwunschSchema.safeParse({ wunsch: "Etwas" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.kontext).toEqual({})
  })

  it("lehnt leeren Wunsch ab", () => {
    expect(PostProduktwunschSchema.safeParse({ wunsch: "   " }).success).toBe(false)
    expect(PostProduktwunschSchema.safeParse({}).success).toBe(false)
  })

  it("lehnt zu lange Texte ab", () => {
    expect(PostProduktwunschSchema.safeParse({ wunsch: "x".repeat(500) }).success).toBe(true)
    expect(PostProduktwunschSchema.safeParse({ wunsch: "x".repeat(501) }).success).toBe(false)
    expect(PostProduktwunschSchema.safeParse({ wunsch: "a", kontext: { suche: "s".repeat(201) } }).success).toBe(false)
    expect(PostProduktwunschSchema.safeParse({ wunsch: "a", kontext: { url: "u".repeat(501) } }).success).toBe(false)
  })

  it("lehnt ungültige E-Mail ab, leere gilt als nicht angegeben", () => {
    expect(PostProduktwunschSchema.safeParse({ wunsch: "a", email: "kein-at" }).success).toBe(false)
    const leer = PostProduktwunschSchema.safeParse({ wunsch: "a", email: "" })
    expect(leer.success).toBe(true)
    if (leer.success) expect(leer.data.email).toBeUndefined()
  })
})

describe("createRateLimiter", () => {
  it("lässt max Aufrufe pro Fenster zu und lehnt danach ab", () => {
    const l = createRateLimiter({ max: 2, windowMs: 1000 })
    expect(l.check("ip", 0).allowed).toBe(true)
    expect(l.check("ip", 1).allowed).toBe(true)
    const r = l.check("ip", 2)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSeconds).toBeGreaterThan(0)
    expect(l.check("andere", 3).allowed).toBe(true)
  })

  it("öffnet nach Ablauf des Fensters wieder", () => {
    const l = createRateLimiter({ max: 1, windowMs: 1000 })
    expect(l.check("ip", 0).allowed).toBe(true)
    expect(l.check("ip", 500).allowed).toBe(false)
    expect(l.check("ip", 1000).allowed).toBe(true)
  })

  it("fällt zu: ohne Schlüssel wird abgelehnt", () => {
    const l = createRateLimiter({ max: 5, windowMs: 1000 })
    expect(l.check(undefined).allowed).toBe(false)
    expect(l.check("").allowed).toBe(false)
  })

  it("fällt zu: bei voller Tabelle wird abgelehnt, abgelaufene weichen", () => {
    const l = createRateLimiter({ max: 5, windowMs: 1000, maxKeys: 2 })
    expect(l.check("a", 0).allowed).toBe(true)
    expect(l.check("b", 0).allowed).toBe(true)
    expect(l.check("c", 10).allowed).toBe(false)
    expect(l.check("c", 1001).allowed).toBe(true)
  })
})

describe("clientKey", () => {
  const req = (headers: Record<string, string>, ip?: string) => ({ headers, ip }) as any

  it("bevorzugt den Hinweis der Storefront", () => {
    expect(clientKey(req({ "x-jibbit-client-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.5")
  })
  it("liest den konfigurierbaren Header und kennt den alten weiterhin", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.7" }))).toBe("203.0.113.7")
    const prev = process.env.CLIENT_IP_HEADER
    process.env.CLIENT_IP_HEADER = "X-Shop-Ip"
    try {
      expect(clientKey(req({ "x-shop-ip": "198.51.100.1" }))).toBe("198.51.100.1")
      expect(clientKey(req({ "x-jibbit-client-ip": "203.0.113.5" }))).toBe("203.0.113.5")
    } finally {
      if (prev === undefined) delete process.env.CLIENT_IP_HEADER
      else process.env.CLIENT_IP_HEADER = prev
    }
  })
  it("nimmt sonst den letzten Eintrag von x-forwarded-for", () => {
    expect(clientKey(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.2" }))).toBe("10.0.0.2")
  })
  it("fällt auf die Socket-Adresse zurück und liefert sonst undefined", () => {
    expect(clientKey(req({}, "::1"))).toBe("::1")
    expect(clientKey(req({ "x-jibbit-client-ip": "<script>" }))).toBeUndefined()
  })
})

describe("renderProduktwunsch", () => {
  const zeit = new Date("2026-10-29T10:15:00Z")

  it("listet Wunsch, Adresse, Kontext und Zeit", () => {
    const m = renderProduktwunsch(
      { wunsch: "Zwei\nZeilen", email: "k@x.ch", kontext: { kategorie: "Papers", suche: "rolli", url: "https://jibbit.ch/suche?q=rolli" } },
      zeit
    )
    expect(m.subject).toBe("Produktwunsch aus dem Shop")
    expect(m.text).toContain("Zwei\nZeilen")
    expect(m.text).toContain("E-Mail: k@x.ch")
    expect(m.text).toContain("Kategorie: Papers")
    expect(m.text).toContain("Suche: rolli")
    expect(m.text).toContain("Seite: https://jibbit.ch/suche?q=rolli")
    expect(m.text).toContain("29.10.2026, 11:15 Uhr")
    expect(m.html).toContain("29.10.2026, 11:15 Uhr")
  })

  it("sagt, wenn keine E-Mail angegeben ist", () => {
    expect(renderProduktwunsch({ wunsch: "a", kontext: {} }, zeit).text).toContain("E-Mail: nicht angegeben")
  })

  it("escaped HTML in allen Feldern", () => {
    const m = renderProduktwunsch(
      {
        wunsch: '<img src=x onerror="alert(1)">',
        email: "a@b.ch<b>",
        kontext: { kategorie: "<i>", suche: "&", url: "javascript:alert('x')" },
      },
      zeit
    )
    expect(m.html).not.toContain("<img")
    expect(m.html).not.toContain("<b>")
    expect(m.html).not.toContain("<i>")
    expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(m.html).toContain("&amp;")
  })

  it("entfernt Steuerzeichen im Klartext", () => {
    const m = renderProduktwunsch({ wunsch: "a\u0000b", email: "x@y.ch\r\nBcc: z@z.ch", kontext: {} }, zeit)
    expect(m.text).not.toContain("\u0000")
    expect(m.text).not.toContain("\r")
  })

  it("kürzt den Push", () => {
    const p = renderProduktwunschPush({ wunsch: "w".repeat(300), kontext: {} })
    expect(p.message.length).toBeLessThanOrEqual(140)
    expect(p.title).toBe("Neuer Produktwunsch")
  })
})

describe("POST /store/produktwunsch", () => {
  function makeRes() {
    const res: any = {}
    res.status = jest.fn().mockReturnValue(res)
    res.json = jest.fn().mockReturnValue(res)
    res.end = jest.fn().mockReturnValue(res)
    res.setHeader = jest.fn().mockReturnValue(res)
    return res
  }

  function setup(opts: { sendOk?: boolean } = {}) {
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() }
    const createNotifications = opts.sendOk === false ? jest.fn().mockRejectedValue(new Error("smtp")) : jest.fn().mockResolvedValue({})
    const scope = {
      resolve: (key: string) => (key === "logger" ? logger : { createNotifications }),
    }
    const mkReq = (ip: string, wunsch = "Geheimer Wunsch", email = "kunde@example.ch") =>
      ({
        scope,
        headers: { "x-jibbit-client-ip": ip },
        validatedBody: { wunsch, email, kontext: { kategorie: "Papers" } },
      }) as any
    return { logger, createNotifications, mkReq }
  }

  let POST: (req: any, res: any) => Promise<void>
  beforeEach(() => {
    jest.isolateModules(() => {
      POST = require("../api/store/produktwunsch/route").POST
    })
    delete process.env.NTFY_URL
    process.env.ORDER_NOTIFICATION_TO = "shop@jibbit.ch"
  })

  it("sendet die Mail an den Betreiber, antwortet 204 und loggt keine Personendaten", async () => {
    const { logger, createNotifications, mkReq } = setup()
    const res = makeRes()
    await POST(mkReq("1.2.3.4"), res)
    expect(res.status).toHaveBeenCalledWith(204)
    expect(createNotifications).toHaveBeenCalledTimes(1)
    const call = createNotifications.mock.calls[0][0]
    expect(call.to).toBe("shop@jibbit.ch")
    expect(call.template).toBe("produktwunsch")
    expect(call.content.subject).toBe("Produktwunsch aus dem Shop")
    const logs = JSON.stringify([...logger.info.mock.calls, ...logger.error.mock.calls])
    expect(logs).toContain("[produktwunsch] gesendet")
    expect(logs).not.toContain("Geheimer Wunsch")
    expect(logs).not.toContain("kunde@example.ch")
  })

  it("antwortet nach 5 Wünschen derselben Adresse mit 429 und Retry-After", async () => {
    const { mkReq } = setup()
    for (let i = 0; i < 5; i++) {
      const res = makeRes()
      await POST(mkReq("5.5.5.5"), res)
      expect(res.status).toHaveBeenCalledWith(204)
    }
    const res = makeRes()
    await POST(mkReq("5.5.5.5"), res)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String))
    // Andere Adresse ist unberührt.
    const other = makeRes()
    await POST(mkReq("6.6.6.6"), other)
    expect(other.status).toHaveBeenCalledWith(204)
  })

  it("lehnt ohne erkennbare Adresse ab (fail closed)", async () => {
    const { mkReq } = setup()
    const req = mkReq("x")
    req.headers = {}
    const res = makeRes()
    await POST(req, res)
    expect(res.status).toHaveBeenCalledWith(429)
  })

  it("antwortet 502, wenn keine Mail rausging", async () => {
    const { mkReq, logger } = setup({ sendOk: false })
    const res = makeRes()
    await POST(mkReq("7.7.7.7"), res)
    expect(res.status).toHaveBeenCalledWith(502)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("Geheimer Wunsch")
  })
})
