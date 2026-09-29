import {
  type CanceledOrderView,
  paymentNote,
  paymentSummary,
  renderOrderCanceled,
  renderOrderCanceledNotification,
  toAmount,
} from "../lib/order-canceled-notification"
import orderCanceledHandler, { config } from "../subscribers/order-canceled"

const settings = { storeName: "jibbit" }

const order: CanceledOrderView = {
  id: "order_01ABC",
  display_id: 1042,
  email: "anna@example.ch",
  items: [
    { product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 2, unit_price: 45.5 },
    { title: "Grinder <Alu>", variant_title: "Standard", quantity: 1, unit_price: 36.5 },
  ],
  shipping_address: { first_name: "Anna", last_name: "Muster", postal_code: "8001", city: "Zürich" },
  payment_collections: [
    {
      payments: [
        { id: "pay_1", captures: [{ amount: 1136.5 }], refunds: [{ amount: 1136.5 }] },
      ],
    },
  ],
}

const unpaid: CanceledOrderView = {
  ...order,
  payment_collections: [{ payments: [{ id: "pay_1", captures: [], refunds: [] }] }],
}

describe("paymentSummary", () => {
  it("zählt Abbuchungen und Rückerstattungen über alle Zahlungen zusammen", () => {
    expect(
      paymentSummary({
        id: "o",
        payment_collections: [
          { payments: [{ captures: [{ amount: 10 }, { amount: "5.5" }], refunds: [{ amount: 3 }] }] },
          { payments: [{ captures: [{ amount: { numeric: 4 } }] }, null] },
          null,
        ],
      })
    ).toEqual({ known: true, captured: 19.5, refunded: 3 })
  })

  it("merkt, wenn die Zahlungsdaten fehlen", () => {
    expect(paymentSummary({ id: "o" })).toEqual({ known: false, captured: 0, refunded: 0 })
    expect(paymentSummary({ id: "o", payment_collections: [] })).toEqual({
      known: true,
      captured: 0,
      refunded: 0,
    })
  })

  it("liest Beträge als Zahl, Zeichenkette und BigNumber", () => {
    expect(toAmount(12.5)).toBe(12.5)
    expect(toAmount("12.50")).toBe(12.5)
    expect(toAmount({ numeric: 12.5 })).toBe(12.5)
    expect(toAmount({ value: "12.5" })).toBe(12.5)
    expect(toAmount(undefined)).toBe(0)
    expect(toAmount("kaputt")).toBe(0)
  })
})

describe("paymentNote", () => {
  it("nennt bei bezahlter Bestellung den Betrag und das ursprüngliche Zahlungsmittel", () => {
    const note = paymentNote(order)
    expect(note).toContain("CHF 1’136.50")
    expect(note).toContain("ursprüngliche Zahlungsmittel")
    expect(note).toContain("Werktage")
  })

  it("stimmt auch, wenn die Rückerstattung noch nicht verbucht ist", () => {
    const pending: CanceledOrderView = {
      ...order,
      payment_collections: [{ payments: [{ captures: [{ amount: 50 }], refunds: [] }] }],
    }
    const note = paymentNote(pending)
    expect(note).toContain("CHF 50.00")
    expect(note).toContain("erhältst du")
    expect(note).not.toMatch(/haben wir .*erstattet/)
  })

  it("verspricht keine Rückerstattung, wenn nichts abgebucht wurde", () => {
    const note = paymentNote(unpaid)
    expect(note).toContain("nichts belastet")
    expect(note).not.toContain("CHF")
    expect(note).not.toContain("erhältst")
  })

  it("bleibt bei «falls», wenn die Zahlungsdaten fehlen", () => {
    const note = paymentNote({ id: "o" })
    expect(note).toMatch(/^Falls du bereits bezahlt hast/)
    expect(note).not.toContain("CHF")
  })
})

describe("renderOrderCanceled", () => {
  const mail = renderOrderCanceled(order, settings)

  it("nennt Bestellnummer, Stornierung, Artikel, Zahlung und Kontakt", () => {
    expect(mail.subject).toBe("Deine Bestellung #1042 bei jibbit wurde storniert")
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("#1042")
      expect(body).toContain("wurde storniert")
      expect(body).toContain("2 × RAW Black King Size – 50er Box")
      expect(body).toContain("CHF 1’136.50")
      expect(body).toContain("ursprüngliche Zahlungsmittel")
      expect(body).toContain("info@jibbit.ch")
    }
  })

  it("sagt bei unbezahlter Bestellung, dass nichts belastet wurde", () => {
    const mailUnpaid = renderOrderCanceled(unpaid, settings)
    for (const body of [mailUnpaid.text, mailUnpaid.html]) {
      expect(body).toContain("nichts belastet")
      expect(body).not.toContain("CHF")
    }
  })

  it("nennt kein Rückgabe- oder Widerrufsrecht", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/Rückgabe|Widerruf|zurückschicken|Retoure/i)
    }
  })

  it("schreibt Schweizer Hochdeutsch ohne ß und grüsst mit Vornamen", () => {
    expect(mail.text).toContain("Hallo Anna")
    expect(mail.text).toContain("Liebe Grüsse")
    expect(mail.subject + mail.text + mail.html).not.toContain("ß")
    expect(renderOrderCanceled(unpaid, settings).text + paymentNote({ id: "o" })).not.toContain("ß")
  })

  it("escaped Artikelnamen im HTML", () => {
    expect(mail.html).toContain("Grinder &lt;Alu&gt;")
    expect(mail.html).not.toContain("<Alu>")
  })

  it("kommt ohne Adresse, Anzeigenummer und Artikel aus", () => {
    const bare = renderOrderCanceled({ id: "order_X" }, settings)
    expect(bare.subject).toContain("order_X")
    expect(bare.text).toContain("Hallo\n")
    expect(bare.text).not.toContain("Stornierte Artikel")
    expect(bare.html).not.toContain("<table")
  })
})

describe("renderOrderCanceledNotification", () => {
  const backend = { backendUrl: "https://api.jibbit.ch" }

  it("ist kurz: Nummer, Zahlungsstand, Artikel, Admin-Link", () => {
    const mail = renderOrderCanceledNotification(order, backend)
    expect(mail.subject).toBe("Bestellung #1042 storniert")
    expect(mail.text).toContain("CHF 1’136.50 abgebucht und vollständig erstattet")
    expect(mail.text).toContain("1 × Grinder <Alu>")
    expect(mail.text).toContain("https://api.jibbit.ch/app/orders/order_01ABC")
    expect(mail.html).toContain('href="https://api.jibbit.ch/app/orders/order_01ABC"')
    expect(mail.html).toContain("Grinder &lt;Alu&gt;")
  })

  it("weist auf einen offenen Betrag hin", () => {
    const open = renderOrderCanceledNotification(
      {
        ...order,
        payment_collections: [{ payments: [{ captures: [{ amount: 50 }], refunds: [{ amount: 20 }] }] }],
      },
      backend
    )
    expect(open.text).toContain("Offen: CHF 30.00")
    expect(renderOrderCanceledNotification(unpaid, backend).text).toContain("nichts abgebucht")
    expect(renderOrderCanceledNotification({ id: "o" }, backend).text).toContain("Stand unbekannt")
  })
})

describe("Subscriber order.canceled", () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.ORDER_NOTIFICATION_TO = "betrieb@jibbit.ch"
    process.env.MEDUSA_BACKEND_URL = "https://api.jibbit.ch"
  })
  afterAll(() => {
    process.env = env
  })

  function setup({
    loadedOrder = order as CanceledOrderView | undefined,
    graph,
    create = jest.fn().mockResolvedValue([]),
  }: {
    loadedOrder?: CanceledOrderView
    graph?: jest.Mock
    create?: jest.Mock
  } = {}) {
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    const query = {
      graph: graph ?? jest.fn(async () => ({ data: [loadedOrder].filter(Boolean) })),
    }
    const container = {
      resolve: (key: string) =>
        key === "logger" ? log : key === "query" ? query : { createNotifications: create },
    }
    const run = (data: Record<string, unknown>) =>
      orderCanceledHandler({ event: { data, name: "order.canceled" }, container } as any)
    return { run, log, query, create }
  }

  const logged = (log: ReturnType<typeof setup>["log"]) =>
    [...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls].flat().join(" ")
  const templates = (create: jest.Mock) => create.mock.calls.map(([n]) => n.template).sort()

  it("hört auf order.canceled", () => {
    expect(config.event).toBe("order.canceled")
  })

  it("lädt die Bestellung samt Zahlungen und schickt Kundin und Betreiber je eine Mail", async () => {
    const { run, query, create } = setup()
    await run({ id: "order_01ABC" })

    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        filters: { id: "order_01ABC" },
        fields: expect.arrayContaining([
          "payment_collections.payments.captures.amount",
          "payment_collections.payments.refunds.amount",
        ]),
      })
    )
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "anna@example.ch",
        channel: "email",
        template: "order-canceled",
        trigger_type: "order.canceled",
        resource_id: "order_01ABC",
        idempotency_key: "order-canceled:order_01ABC",
        data: { order_id: "order_01ABC" },
        content: expect.objectContaining({
          subject: "Deine Bestellung #1042 bei jibbit wurde storniert",
        }),
      })
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "betrieb@jibbit.ch",
        template: "order-canceled-notification",
        idempotency_key: "order-canceled-notification:order_01ABC:0",
      })
    )
  })

  it("beachtet no_notification: keine Mail an die Kundin, der Betreiber erfährt es trotzdem", async () => {
    const { run, create } = setup()
    await run({ id: "order_01ABC", no_notification: true })
    expect(templates(create)).toEqual(["order-canceled-notification"])
  })

  it("verschickt ohne E-Mail an der Bestellung nichts an die Kundin und loggt eine Warnung", async () => {
    const { run, log, create } = setup({ loadedOrder: { ...order, email: null } })
    await run({ id: "order_01ABC" })
    expect(templates(create)).toEqual(["order-canceled-notification"])
    expect(log.warn.mock.calls[0][0]).toContain("ohne E-Mail")
  })

  it("verschickt nichts, wenn Bestellung oder ID fehlen", async () => {
    const missing = setup({ graph: jest.fn().mockResolvedValue({ data: [] }) })
    await missing.run({ id: "order_weg" })
    expect(missing.create).not.toHaveBeenCalled()
    expect(missing.log.error).toHaveBeenCalledTimes(1)

    const noId = setup()
    await noId.run({})
    expect(noId.create).not.toHaveBeenCalled()
    expect(noId.query.graph).not.toHaveBeenCalled()
  })

  it("wirft nie: weder wenn das Laden scheitert noch wenn der Mailserver klemmt", async () => {
    const broken = setup({ graph: jest.fn().mockRejectedValue(new Error("db weg")) })
    await expect(broken.run({ id: "order_01ABC" })).resolves.toBeUndefined()
    expect(broken.create).not.toHaveBeenCalled()
    expect(broken.log.error.mock.calls[0][0]).toContain("db weg")

    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await expect(smtp.run({ id: "order_01ABC" })).resolves.toBeUndefined()
    expect(smtp.log.error).toHaveBeenCalledTimes(2)

    process.env.MEDUSA_BACKEND_URL = "keine-url"
    const badUrl = setup()
    await expect(badUrl.run({ id: "order_01ABC" })).resolves.toBeUndefined()
    expect(templates(badUrl.create)).toEqual(["order-canceled"])
    expect(badUrl.log.error).toHaveBeenCalledTimes(1)
  })

  it("schreibt die E-Mail-Adresse nie ins Log", async () => {
    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await smtp.run({ id: "order_01ABC" })
    const noMail = setup({ loadedOrder: { ...order, email: "" } })
    await noMail.run({ id: "order_01ABC" })
    const skipped = setup()
    await skipped.run({ id: "order_01ABC", no_notification: true })
    const all = logged(smtp.log) + logged(noMail.log) + logged(skipped.log)
    expect(all).not.toContain("anna@example.ch")
    expect(all).not.toContain("betrieb@jibbit.ch")
  })
})
