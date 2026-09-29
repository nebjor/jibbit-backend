import { buildInviteUrl, renderInviteEmail, validityText } from "../lib/invite-email"
import inviteCreatedHandler, { config } from "../subscribers/invite-created"

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.einladung.signature"
const NOW = Date.parse("2026-09-29T12:00:00Z")
const HOUR = 60 * 60 * 1000

describe("buildInviteUrl", () => {
  it("zeigt auf die Einladungsseite des Dashboards und hängt das Token an", () => {
    const url = new URL(buildInviteUrl("https://api.jibbit.ch", TOKEN))
    expect(url.origin).toBe("https://api.jibbit.ch")
    expect(url.pathname).toBe("/app/invite")
    expect(url.searchParams.get("token")).toBe(TOKEN)
  })

  it("wirft ohne MEDUSA_BACKEND_URL oder Token, statt einen kaputten Link zu verschicken", () => {
    expect(() => buildInviteUrl(undefined, TOKEN)).toThrow(/MEDUSA_BACKEND_URL/)
    expect(() => buildInviteUrl("javascript:alert(1)", TOKEN)).toThrow()
    expect(() => buildInviteUrl("https://api.jibbit.ch", " ")).toThrow(/Token/)
  })

  it("kodiert Tokens mit Sonderzeichen, statt die Query zu zerlegen", () => {
    const url = new URL(buildInviteUrl("https://api.jibbit.ch", "a b&c=d"))
    expect(url.searchParams.get("token")).toBe("a b&c=d")
  })
})

describe("validityText", () => {
  it("rechnet die Gültigkeit aus dem Ablaufdatum", () => {
    expect(validityText(new Date(NOW + 24 * HOUR), NOW)).toBe("Der Link ist 24 Stunden gültig.")
    expect(validityText(new Date(NOW + 24 * HOUR - 2000).toISOString(), NOW)).toBe(
      "Der Link ist 24 Stunden gültig."
    )
    expect(validityText(NOW + HOUR, NOW)).toBe("Der Link ist 1 Stunde gültig.")
    expect(validityText(new Date(NOW + 7 * 24 * HOUR), NOW)).toBe("Der Link ist 7 Tage gültig.")
  })

  it("nennt keine Zahl, wenn das Ablaufdatum fehlt oder vorbei ist", () => {
    for (const value of [undefined, null, "kaputt", new Date(NOW - HOUR)]) {
      expect(validityText(value, NOW)).toBe("Der Link ist nur kurze Zeit gültig.")
    }
  })
})

describe("renderInviteEmail", () => {
  const mail = renderInviteEmail({
    backendUrl: "https://api.jibbit.ch",
    storeName: "jibbit",
    token: TOKEN,
    expiresAt: new Date(NOW + 24 * HOUR),
    now: NOW,
  })
  const link = `https://api.jibbit.ch/app/invite?token=${TOKEN}`

  it("lädt auf Deutsch ins Admin ein und nennt Link und Gültigkeit", () => {
    expect(mail.subject).toBe("jibbit: Einladung ins Admin")
    expect(mail.text).toContain(link)
    expect(mail.html).toContain(`href="${link}"`)
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("eingeladen")
      expect(body).toContain("24 Stunden gültig")
      expect(body).toContain("ignorieren")
    }
  })

  it("schreibt Schweizer Hochdeutsch ohne ß und duzt", () => {
    expect(mail.subject + mail.text + mail.html).not.toContain("ß")
    expect(mail.text).toContain("Du bist eingeladen")
    expect(mail.text).not.toMatch(/\bSie\b|\bIhr/)
  })

  it("escaped den Shopnamen im HTML", () => {
    const odd = renderInviteEmail({
      backendUrl: "https://api.jibbit.ch",
      storeName: "jibbit <b>",
      token: TOKEN,
    })
    expect(odd.html).toContain("jibbit &lt;b&gt;")
    expect(odd.html).not.toContain("<b>")
  })
})

describe("Subscriber invite.created / invite.resent", () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.MEDUSA_BACKEND_URL = "https://api.jibbit.ch"
  })
  afterAll(() => {
    process.env = env
  })

  const expires = new Date(Date.now() + 24 * HOUR)
  const invite = {
    id: "invite_01",
    email: "neu@example.ch",
    token: TOKEN,
    accepted: false,
    expires_at: expires,
  }

  function setup({
    loaded = invite as Record<string, unknown> | undefined,
    graph,
    create = jest.fn().mockResolvedValue([]),
  }: {
    loaded?: Record<string, unknown>
    graph?: jest.Mock
    create?: jest.Mock
  } = {}) {
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    const query = { graph: graph ?? jest.fn(async () => ({ data: [loaded].filter(Boolean) })) }
    const container = {
      resolve: (key: string) =>
        key === "logger" ? log : key === "query" ? query : { createNotifications: create },
    }
    const run = (data: Record<string, unknown>, name = "invite.created") =>
      inviteCreatedHandler({ event: { data, name }, container } as any)
    return { run, log, query, create }
  }

  const logged = (log: ReturnType<typeof setup>["log"]) =>
    [...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls].flat().join(" ")

  it("hört auf invite.created und invite.resent", () => {
    expect(config.event).toEqual(["invite.created", "invite.resent"])
  })

  it("lädt die Einladung und schickt den Link an die eingeladene Adresse", async () => {
    const { run, query, create } = setup()
    await run({ id: "invite_01" })

    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "invite", filters: { id: "invite_01" } })
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "neu@example.ch",
        channel: "email",
        template: "admin-invite",
        trigger_type: "invite.created",
        resource_id: "invite_01",
        idempotency_key: `admin-invite:invite_01:${expires.getTime()}`,
        data: { invite_id: "invite_01" },
        content: expect.objectContaining({
          subject: "jibbit: Einladung ins Admin",
          text: expect.stringContaining(`https://api.jibbit.ch/app/invite?token=${TOKEN}`),
        }),
      })
    )
  })

  it("schickt beim erneuten Senden eine neue Mail mit neuem Schlüssel", async () => {
    const later = new Date(expires.getTime() + HOUR)
    const { run, create } = setup({ loaded: { ...invite, token: "neues.token", expires_at: later } })
    await run({ id: "invite_01" }, "invite.resent")
    const sent = create.mock.calls[0][0]
    expect(sent.trigger_type).toBe("invite.resent")
    expect(sent.idempotency_key).toBe(`admin-invite:invite_01:${later.getTime()}`)
    expect(sent.content.text).toContain("token=neues.token")
  })

  it("speichert das Token weder in data noch im Schlüssel", async () => {
    const { run, create } = setup()
    await run({ id: "invite_01" })
    const { content, ...stored } = create.mock.calls[0][0]
    expect(content.text).toContain(TOKEN)
    expect(JSON.stringify(stored)).not.toContain(TOKEN)
  })

  it("verschickt nichts ohne Empfänger, ohne Token oder für angenommene Einladungen", async () => {
    for (const loaded of [
      { ...invite, email: "" },
      { ...invite, token: null },
      { ...invite, accepted: true },
    ]) {
      const { run, create } = setup({ loaded })
      await run({ id: "invite_01" })
      expect(create).not.toHaveBeenCalled()
    }

    const missing = setup({ graph: jest.fn().mockResolvedValue({ data: [] }) })
    await missing.run({ id: "invite_weg" })
    expect(missing.create).not.toHaveBeenCalled()
    expect(missing.log.error).toHaveBeenCalledTimes(1)

    const noId = setup()
    await noId.run({})
    expect(noId.create).not.toHaveBeenCalled()
    expect(noId.query.graph).not.toHaveBeenCalled()
  })

  it("wirft nie: weder beim Laden, beim Rendern noch wenn der Mailserver klemmt", async () => {
    const broken = setup({ graph: jest.fn().mockRejectedValue(new Error("db weg")) })
    await expect(broken.run({ id: "invite_01" })).resolves.toBeUndefined()
    expect(broken.log.error.mock.calls[0][0]).toContain("db weg")

    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 neu@example.ch rejected")),
    })
    await expect(smtp.run({ id: "invite_01" })).resolves.toBeUndefined()
    expect(smtp.log.error).toHaveBeenCalledTimes(1)

    delete process.env.MEDUSA_BACKEND_URL
    const noUrl = setup()
    await expect(noUrl.run({ id: "invite_01" })).resolves.toBeUndefined()
    expect(noUrl.create).not.toHaveBeenCalled()
    expect(noUrl.log.error.mock.calls[0][0]).toContain("MEDUSA_BACKEND_URL")
  })

  it("schreibt weder Adresse noch Token ins Log", async () => {
    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 neu@example.ch rejected")),
    })
    await smtp.run({ id: "invite_01" })
    const accepted = setup({ loaded: { ...invite, accepted: true } })
    await accepted.run({ id: "invite_01" })
    delete process.env.MEDUSA_BACKEND_URL
    const noUrl = setup()
    await noUrl.run({ id: "invite_01" })
    const all = logged(smtp.log) + logged(accepted.log) + logged(noUrl.log)
    expect(all).not.toContain("neu@example.ch")
    expect(all).not.toContain(TOKEN)
  })
})
