import type { OrderView } from "../lib/order-notification"
import {
  REFUND_WINDOW_MS,
  type RefundedPaymentView,
  refundsToNotify,
  renderRefundConfirmation,
} from "../lib/refund-notification"
import paymentRefundedHandler, { config } from "../subscribers/payment-refunded"

const settings = { storeName: "jibbit" }

const order: OrderView = {
  id: "order_01ABC",
  display_id: 1042,
  email: "anna@example.ch",
  shipping_address: { first_name: "Anna" },
}

const NOW = Date.parse("2026-09-29T12:00:00Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const payment: RefundedPaymentView = {
  id: "pay_01",
  refunds: [{ id: "ref_1", amount: 1236.5, created_at: minutesAgo(1) }],
  payment_collection: { order: { id: "order_01ABC" } },
}

describe("refundsToNotify", () => {
  it("nimmt die eben angelegte Rückerstattung", () => {
    expect(refundsToNotify(payment, NOW)).toEqual([{ id: "ref_1", amount: 1236.5 }])
  })

  it("lässt bei einer weiteren Teilrückerstattung die alte weg", () => {
    expect(
      refundsToNotify(
        {
          id: "pay_01",
          refunds: [
            { id: "ref_neu", amount: 5, created_at: minutesAgo(0) },
            { id: "ref_alt", amount: 10, created_at: minutesAgo(3 * 24 * 60) },
          ],
        },
        NOW
      )
    ).toEqual([{ id: "ref_neu", amount: 5 }])
  })

  it("nimmt zwei Rückerstattungen kurz nacheinander beide, älteste zuerst", () => {
    expect(
      refundsToNotify(
        {
          id: "pay_01",
          refunds: [
            { id: "ref_b", amount: 5, created_at: minutesAgo(1) },
            { id: "ref_a", amount: 10, created_at: minutesAgo(2) },
          ],
        },
        NOW
      ).map((refund) => refund.id)
    ).toEqual(["ref_a", "ref_b"])
  })

  it("fällt auf die jüngste zurück, wenn das Event sehr spät kommt", () => {
    const late = NOW + REFUND_WINDOW_MS * 5
    expect(
      refundsToNotify(
        {
          id: "pay_01",
          refunds: [
            { id: "ref_a", amount: 10, created_at: minutesAgo(20) },
            { id: "ref_b", amount: 5, created_at: minutesAgo(1) },
          ],
        },
        late
      )
    ).toEqual([{ id: "ref_b", amount: 5 }])
  })

  it("liest Date und BigNumber und lässt Einträge ohne ID oder Betrag weg", () => {
    expect(
      refundsToNotify(
        {
          id: "pay_01",
          refunds: [
            null,
            { id: "", amount: 5, created_at: minutesAgo(1) },
            { id: "ref_null", amount: 0, created_at: minutesAgo(1) },
            { id: "ref_ok", amount: { numeric: 7.25 }, created_at: new Date(NOW - 1000) },
          ],
        },
        NOW
      )
    ).toEqual([{ id: "ref_ok", amount: 7.25 }])
    expect(refundsToNotify({ id: "pay_01" }, NOW)).toEqual([])
  })
})

describe("renderRefundConfirmation", () => {
  const mail = renderRefundConfirmation({ id: "ref_1", amount: 1236.5 }, order, settings)

  it("nennt Bestellnummer, Betrag in CHF, Zahlungsmittel, Dauer und Kontakt", () => {
    expect(mail.subject).toBe("Rückerstattung zu deiner Bestellung #1042 bei jibbit")
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("#1042")
      expect(body).toContain("CHF 1’236.50")
      expect(body).toContain("Zahlungsmittel zurück, mit dem du bezahlt hast")
      expect(body).toContain("ein paar Werktage")
      expect(body).toContain("info@jibbit.ch")
    }
  })

  it("nennt bei einer Teilrückerstattung den Teilbetrag", () => {
    const partial = renderRefundConfirmation({ id: "ref_2", amount: 4.5 }, order, settings)
    expect(partial.text).toContain("CHF 4.50")
    expect(partial.text).not.toContain("1’236.50")
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
  })

  it("kommt ohne Vornamen und Anzeigenummer aus", () => {
    const bare = renderRefundConfirmation({ id: "ref_1", amount: 5 }, { id: "order_X" }, settings)
    expect(bare.subject).toContain("order_X")
    expect(bare.text).toContain("Hallo\n")
  })
})

describe("Subscriber payment.refunded", () => {
  const fresh = (): RefundedPaymentView => ({
    ...payment,
    refunds: [{ id: "ref_1", amount: 1236.5, created_at: new Date().toISOString() }],
  })

  function setup({
    loadedPayment = fresh() as RefundedPaymentView | undefined,
    loadedOrder = order as OrderView | undefined,
    graph,
    create = jest.fn().mockResolvedValue([]),
  }: {
    loadedPayment?: RefundedPaymentView
    loadedOrder?: OrderView
    graph?: jest.Mock
    create?: jest.Mock
  } = {}) {
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    const query = {
      graph:
        graph ??
        jest.fn(async ({ entity }: { entity: string }) => ({
          data: (entity === "payment" ? [loadedPayment] : [loadedOrder]).filter(Boolean),
        })),
    }
    const container = {
      resolve: (key: string) =>
        key === "logger" ? log : key === "query" ? query : { createNotifications: create },
    }
    const run = (data: Record<string, unknown>) =>
      paymentRefundedHandler({ event: { data, name: "payment.refunded" }, container } as any)
    return { run, log, query, create }
  }

  const logged = (log: ReturnType<typeof setup>["log"]) =>
    [...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls].flat().join(" ")

  it("hört auf payment.refunded", () => {
    expect(config.event).toBe("payment.refunded")
  })

  it("geht von der Zahlung über die Payment Collection zur Bestellung und schickt die Mail", async () => {
    const { run, query, create } = setup()
    await run({ id: "pay_01" })

    expect(query.graph).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entity: "payment",
        filters: { id: "pay_01" },
        fields: expect.arrayContaining(["refunds.amount", "payment_collection.order.id"]),
      })
    )
    expect(query.graph).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ entity: "order", filters: { id: "order_01ABC" } })
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "anna@example.ch",
        channel: "email",
        template: "refund-confirmation",
        trigger_type: "payment.refunded",
        resource_id: "ref_1",
        idempotency_key: "refund-confirmation:ref_1",
        data: { order_id: "order_01ABC", payment_id: "pay_01", refund_id: "ref_1" },
        content: expect.objectContaining({
          subject: "Rückerstattung zu deiner Bestellung #1042 bei jibbit",
          text: expect.stringContaining("CHF 1’236.50"),
        }),
      })
    )
  })

  it("schickt bei mehreren frischen Rückerstattungen je eine Mail mit eigenem Schlüssel", async () => {
    const now = Date.now()
    const { run, create } = setup({
      loadedPayment: {
        ...payment,
        refunds: [
          { id: "ref_alt", amount: 100, created_at: new Date(now - 5 * REFUND_WINDOW_MS) },
          { id: "ref_a", amount: 10, created_at: new Date(now - 60_000) },
          { id: "ref_b", amount: 5, created_at: new Date(now - 1_000) },
        ],
      },
    })
    await run({ id: "pay_01" })
    expect(create.mock.calls.map(([n]) => n.idempotency_key)).toEqual([
      "refund-confirmation:ref_a",
      "refund-confirmation:ref_b",
    ])
    expect(create.mock.calls[0][0].content.text).toContain("CHF 10.00")
    expect(create.mock.calls[1][0].content.text).toContain("CHF 5.00")
  })

  it("beachtet no_notification", async () => {
    const { run, query, create } = setup()
    await run({ id: "pay_01", no_notification: true })
    expect(query.graph).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("verschickt nichts ohne E-Mail an der Bestellung und loggt eine Warnung", async () => {
    const { run, log, create } = setup({ loadedOrder: { ...order, email: null } })
    await run({ id: "pay_01" })
    expect(create).not.toHaveBeenCalled()
    expect(log.warn.mock.calls[0][0]).toContain("ohne E-Mail")
  })

  it("verschickt nichts, wenn Zahlung, Bestellung oder Rückerstattung fehlen", async () => {
    const noOrderLink = setup({ loadedPayment: { ...fresh(), payment_collection: null } })
    await noOrderLink.run({ id: "pay_01" })
    expect(noOrderLink.create).not.toHaveBeenCalled()
    expect(noOrderLink.log.error).toHaveBeenCalledTimes(1)

    const missing = setup({ graph: jest.fn().mockResolvedValue({ data: [] }) })
    await missing.run({ id: "pay_weg" })
    expect(missing.create).not.toHaveBeenCalled()
    expect(missing.log.error).toHaveBeenCalledTimes(1)

    const noRefund = setup({ loadedPayment: { ...payment, refunds: [] } })
    await noRefund.run({ id: "pay_01" })
    expect(noRefund.create).not.toHaveBeenCalled()
    expect(noRefund.log.warn).toHaveBeenCalledTimes(1)

    const noId = setup()
    await noId.run({})
    expect(noId.create).not.toHaveBeenCalled()
    expect(noId.query.graph).not.toHaveBeenCalled()
  })

  it("wirft nie: weder wenn das Laden scheitert noch wenn der Mailserver klemmt", async () => {
    const broken = setup({ graph: jest.fn().mockRejectedValue(new Error("db weg")) })
    await expect(broken.run({ id: "pay_01" })).resolves.toBeUndefined()
    expect(broken.create).not.toHaveBeenCalled()
    expect(broken.log.error.mock.calls[0][0]).toContain("db weg")

    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await expect(smtp.run({ id: "pay_01" })).resolves.toBeUndefined()
    expect(smtp.log.error).toHaveBeenCalledTimes(1)
  })

  it("schreibt die E-Mail-Adresse nie ins Log", async () => {
    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await smtp.run({ id: "pay_01" })
    const noMail = setup({ loadedOrder: { ...order, email: "" } })
    await noMail.run({ id: "pay_01" })
    expect(logged(smtp.log) + logged(noMail.log)).not.toContain("anna@example.ch")
  })
})
