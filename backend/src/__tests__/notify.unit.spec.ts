import { describeError, sendEmail, sendPush } from "../lib/notify"

const logger = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }) as any

function containerWith(createNotifications: jest.Mock, log = logger()) {
  return {
    log,
    container: {
      resolve: (key: string) => (key === "logger" ? log : { createNotifications }),
    } as any,
  }
}

const message = {
  to: "anna@example.ch",
  template: "order-confirmation",
  trigger: "order.placed",
  content: { subject: "s", text: "t", html: "<p>t</p>" },
}

describe("sendEmail", () => {
  it("übergibt Inhalt und Metadaten an das Notification-Modul", async () => {
    const create = jest.fn().mockResolvedValue([])
    const { container } = containerWith(create)
    await expect(sendEmail(container, { ...message, resourceId: "order_1" })).resolves.toBe(true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "anna@example.ch",
        channel: "email",
        template: "order-confirmation",
        trigger_type: "order.placed",
        resource_id: "order_1",
        content: message.content,
      })
    )
  })

  it("wirft nie und loggt ohne Empfängeradresse", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(new Error("Failed to send: 550 anna@example.ch rejected"))
    const { container, log } = containerWith(create)
    await expect(sendEmail(container, message)).resolves.toBe(false)
    const logged = log.error.mock.calls[0][0] as string
    expect(logged).toContain("order-confirmation")
    expect(logged).toContain("550")
    expect(logged).not.toContain("anna@example.ch")
  })
})

describe("sendPush", () => {
  const push = { title: "Neue Bestellung #1", message: "CHF 9.00 · 1 Artikel", click: "https://x.ch/app/orders/o" }
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  it("macht nichts ohne NTFY_URL", async () => {
    global.fetch = jest.fn() as any
    await expect(sendPush(logger(), undefined, push)).resolves.toBe(false)
    await expect(sendPush(logger(), " ", push)).resolves.toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("postet Text mit Title- und Click-Header an die Topic-URL", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as any
    await expect(sendPush(logger(), "https://ntfy.sh/geheim", push)).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://ntfy.sh/geheim")
    expect(init.method).toBe("POST")
    expect(init.body).toBe("CHF 9.00 · 1 Artikel")
    expect(init.headers).toMatchObject({ Title: "Neue Bestellung #1", Click: push.click })
    expect(init.signal).toBeDefined()
  })

  it("wirft nie, weder bei Netzfehler noch bei HTTP-Fehler", async () => {
    const log = logger()
    global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed")) as any
    await expect(sendPush(log, "https://ntfy.sh/geheim", push)).resolves.toBe(false)
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 }) as any
    await expect(sendPush(log, "https://ntfy.sh/geheim", push)).resolves.toBe(false)
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(log.error.mock.calls[1][0]).toContain("429")
    expect(log.error.mock.calls.flat().join(" ")).not.toContain("geheim")
  })
})

describe("describeError", () => {
  it("ersetzt Adressen und kommt mit Nicht-Errors klar", () => {
    expect(describeError(new Error("to <a.b@c.ch> failed"))).toBe("Error: to <<adresse>> failed")
    expect(describeError("x")).toBe("unbekannter Fehler")
  })
})
