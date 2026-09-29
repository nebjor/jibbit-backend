import {
  type ShipmentOrderView,
  type ShipmentView,
  isPartialShipment,
  renderShippingConfirmation,
  shippedLines,
  swissPostTrackingUrl,
  trackings,
} from "../lib/shipping-notification"
import shipmentCreatedHandler, { config } from "../subscribers/shipment-created"

const settings = { storeName: "jibbit" }

const order: ShipmentOrderView = {
  id: "order_01ABC",
  display_id: 1042,
  email: "anna@example.ch",
  items: [
    { id: "orli_1", product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 2, unit_price: 45.5 },
    { id: "orli_2", title: "Grinder <Alu>", variant_title: "Standard", quantity: 1, unit_price: 36.5 },
  ],
  shipping_address: {
    first_name: "Anna",
    last_name: "Muster",
    address_1: "Bahnhofstrasse 1",
    postal_code: "8001",
    city: "Zürich",
    country_code: "ch",
  },
}

const shipment: ShipmentView = {
  id: "ful_01XYZ",
  items: [
    { title: "50er Box", quantity: 2, line_item_id: "orli_1" },
    { title: "Standard", quantity: 1, line_item_id: "orli_2" },
  ],
  labels: [{ tracking_number: "99.00.123456.12345678", tracking_url: "#" }],
}

describe("trackings", () => {
  it("baut den Link zur Sendungsverfolgung der Post aus der Sendungsnummer", () => {
    expect(swissPostTrackingUrl(" 99.00.123456.12345678 ")).toBe(
      "https://service.post.ch/ekp-web/ui/entry/search/99.00.123456.12345678"
    )
    expect(trackings(shipment)).toEqual([
      {
        number: "99.00.123456.12345678",
        url: "https://service.post.ch/ekp-web/ui/entry/search/99.00.123456.12345678",
      },
    ])
  })

  it("nimmt einen im Admin hinterlegten Link, aber nur http(s)", () => {
    expect(
      trackings({ id: "f", labels: [{ tracking_number: "A1", tracking_url: "https://dhl.example/t/A1" }] })[0].url
    ).toBe("https://dhl.example/t/A1")
    expect(
      trackings({ id: "f", labels: [{ tracking_number: "A1", tracking_url: "javascript:alert(1)" }] })[0].url
    ).toBe("https://service.post.ch/ekp-web/ui/entry/search/A1")
  })

  it("kodiert die Sendungsnummer, statt den Link zu zerlegen", () => {
    expect(swissPostTrackingUrl("99/00?x=1")).toBe(
      "https://service.post.ch/ekp-web/ui/entry/search/99%2F00%3Fx%3D1"
    )
  })

  it("lässt leere und doppelte Nummern weg", () => {
    expect(
      trackings({
        id: "f",
        labels: [
          { tracking_number: "", tracking_url: "#" },
          { tracking_number: "  ", tracking_url: "https://x.example" },
          null,
          { tracking_number: "A1", tracking_url: "#" },
          { tracking_number: " A1 ", tracking_url: "#" },
        ],
      }).map((t) => t.number)
    ).toEqual(["A1"])
    expect(trackings({ id: "f" })).toEqual([])
  })
})

describe("shippedLines", () => {
  it("nimmt Namen aus der Bestellung und Mengen aus der Sendung", () => {
    expect(shippedLines(shipment, order)).toEqual([
      { label: "RAW Black King Size – 50er Box", quantity: 2 },
      { label: "Grinder <Alu>", quantity: 1 },
    ])
  })

  it("fällt auf den Titel der Sendungsposition zurück, wenn die Bestellzeile fehlt", () => {
    expect(
      shippedLines({ id: "f", items: [{ title: "Filter Tips", quantity: 3, line_item_id: "orli_weg" }] }, order)
    ).toEqual([{ label: "Filter Tips", quantity: 3 }])
  })

  it("rechnet bei Sets auf die Stückzahl der Bestellzeile zurück", () => {
    const kitOrder: ShipmentOrderView = {
      id: "order_kit",
      items: [
        {
          id: "orli_kit",
          product_title: "Starter-Set",
          quantity: 2,
          variant: {
            inventory_items: [
              { required_quantity: 3, inventory: { id: "iitem_papers" } },
              { required_quantity: 1, inventory: { id: "iitem_tips" } },
            ],
          },
        },
      ],
    }
    const kitShipment: ShipmentView = {
      id: "ful_kit",
      items: [
        { title: "Papers", quantity: 6, line_item_id: "orli_kit", inventory_item_id: "iitem_papers" },
        { title: "Tips", quantity: 2, line_item_id: "orli_kit", inventory_item_id: "iitem_tips" },
      ],
    }
    expect(shippedLines(kitShipment, kitOrder)).toEqual([{ label: "Starter-Set", quantity: 2 }])
    expect(isPartialShipment(kitShipment, kitOrder)).toBe(false)
  })
})

describe("renderShippingConfirmation", () => {
  const mail = renderShippingConfirmation(shipment, order, settings)

  it("nennt Bestellnummer, Artikel mit Menge, Lieferadresse und Kontakt", () => {
    expect(mail.subject).toBe("Deine Bestellung #1042 bei jibbit ist unterwegs")
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("#1042")
      expect(body).toContain("2 × RAW Black King Size – 50er Box")
      expect(body).toContain("Bahnhofstrasse 1")
      expect(body).toContain("8001 Zürich")
      expect(body).toContain("info@jibbit.ch")
    }
  })

  it("nennt die Sendungsnummer mit Link zur Post", () => {
    expect(mail.text).toContain(
      "99.00.123456.12345678: https://service.post.ch/ekp-web/ui/entry/search/99.00.123456.12345678"
    )
    expect(mail.html).toContain(
      '<a href="https://service.post.ch/ekp-web/ui/entry/search/99.00.123456.12345678">99.00.123456.12345678</a>'
    )
    expect(mail.html).not.toContain('href="#"')
    expect(mail.text).not.toContain("ohne Sendungsverfolgung")
  })

  it("nennt mehrere Sendungsnummern", () => {
    const two = renderShippingConfirmation(
      { ...shipment, labels: [{ tracking_number: "A1" }, { tracking_number: "B2" }] },
      order,
      settings
    )
    for (const body of [two.text, two.html]) {
      expect(body).toContain("Sendungsnummern")
      expect(body).toContain("/search/A1")
      expect(body).toContain("/search/B2")
    }
  })

  it("erklärt ohne Sendungsnummer, dass es keine Sendungsverfolgung gibt", () => {
    for (const labels of [undefined, [], [{ tracking_number: "", tracking_url: "#" }]]) {
      const bare = renderShippingConfirmation({ ...shipment, labels }, order, settings)
      for (const body of [bare.text, bare.html]) {
        expect(body).toContain("ohne Sendungsverfolgung")
        expect(body).toContain("Brief")
        expect(body).not.toContain("post.ch")
        expect(body).not.toContain("Sendungsnummer:")
      }
      expect(bare.html).not.toContain("<a href=\"#\"")
    }
  })

  it("nennt bei einer Teillieferung nur die versendeten Artikel", () => {
    const part: ShipmentView = {
      ...shipment,
      items: [{ title: "50er Box", quantity: 1, line_item_id: "orli_1" }],
    }
    expect(isPartialShipment(part, order)).toBe(true)
    expect(isPartialShipment(shipment, order)).toBe(false)

    const partial = renderShippingConfirmation(part, order, settings)
    expect(partial.subject).toBe("Ein Teil deiner Bestellung #1042 bei jibbit ist unterwegs")
    for (const body of [partial.text, partial.html]) {
      expect(body).toContain("1 × RAW Black King Size – 50er Box")
      expect(body).not.toContain("2 × RAW Black King Size")
      expect(body).not.toContain("Grinder")
      expect(body).toContain("separaten Sendung")
    }
    expect(mail.text).not.toContain("separaten Sendung")
  })

  it("nimmt die Lieferadresse der Sendung vor der der Bestellung", () => {
    const other = renderShippingConfirmation(
      {
        ...shipment,
        delivery_address: { first_name: "Beat", address_1: "Dorfplatz 2", postal_code: "3000", city: "Bern" },
      },
      order,
      settings
    )
    expect(other.text).toContain("Hallo Beat")
    expect(other.text).toContain("Dorfplatz 2")
    expect(other.text).not.toContain("Bahnhofstrasse 1")
  })

  it("nennt weder Preise noch ein Rückgaberecht", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toContain("CHF")
      expect(body).not.toMatch(/Rückgabe|Widerruf|zurückschicken|Retoure/i)
    }
  })

  it("schreibt Schweizer Hochdeutsch ohne ß und grüsst mit Vornamen", () => {
    expect(mail.text).toContain("Hallo Anna")
    expect(mail.text).toContain("Liebe Grüsse")
    expect(mail.subject + mail.text + mail.html).not.toContain("ß")
  })

  it("escaped Artikelnamen im HTML", () => {
    expect(mail.html).toContain("Grinder &lt;Alu&gt;")
    expect(mail.html).not.toContain("<Alu>")
  })

  it("kommt ohne Adresse, Anzeigenummer und Artikel aus", () => {
    const bare = renderShippingConfirmation({ id: "ful_X" }, { id: "order_X" }, settings)
    expect(bare.subject).toContain("order_X")
    expect(bare.text).toContain("Hallo\n")
    expect(bare.text).not.toContain("Lieferadresse")
  })
})

describe("Subscriber shipment.created", () => {
  const loaded = { ...shipment, canceled_at: null, order: { id: order.id } }

  function setup({
    fulfillment = loaded as Record<string, unknown> | undefined,
    loadedOrder = order as ShipmentOrderView | undefined,
    graph,
    create = jest.fn().mockResolvedValue([]),
  }: {
    fulfillment?: Record<string, unknown>
    loadedOrder?: ShipmentOrderView
    graph?: jest.Mock
    create?: jest.Mock
  } = {}) {
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    const query = {
      graph:
        graph ??
        jest.fn(async ({ entity }: { entity: string }) => ({
          data: (entity === "fulfillment" ? [fulfillment] : [loadedOrder]).filter(Boolean),
        })),
    }
    const container = {
      resolve: (key: string) =>
        key === "logger" ? log : key === "query" ? query : { createNotifications: create },
    }
    const run = (data: Record<string, unknown>) =>
      shipmentCreatedHandler({ event: { data, name: "shipment.created" }, container } as any)
    return { run, log, query, create }
  }

  const logged = (log: ReturnType<typeof setup>["log"]) =>
    [...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls].flat().join(" ")

  it("hört auf shipment.created", () => {
    expect(config.event).toBe("shipment.created")
  })

  it("lädt die Sendung über die Fulfillment-ID und schickt die Mail an die Bestell-Adresse", async () => {
    const { run, query, create } = setup()
    await run({ id: "ful_01XYZ", no_notification: false })

    expect(query.graph).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entity: "fulfillment", filters: { id: "ful_01XYZ" } })
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
        template: "shipping-confirmation",
        trigger_type: "shipment.created",
        resource_id: "ful_01XYZ",
        idempotency_key: "shipping-confirmation:ful_01XYZ",
        data: { order_id: "order_01ABC", fulfillment_id: "ful_01XYZ" },
        content: expect.objectContaining({ subject: "Deine Bestellung #1042 bei jibbit ist unterwegs" }),
      })
    )
  })

  it("verschickt nichts, wenn die Benachrichtigung im Admin abgewählt ist", async () => {
    const { run, query, create } = setup()
    await run({ id: "ful_01XYZ", no_notification: true })
    expect(query.graph).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("verschickt auch ohne no_notification im Event", async () => {
    const { run, create } = setup()
    await run({ id: "ful_01XYZ" })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("verschickt nichts ohne E-Mail an der Bestellung und loggt eine Warnung", async () => {
    const { run, log, create } = setup({ loadedOrder: { ...order, email: null } })
    await run({ id: "ful_01XYZ" })
    expect(create).not.toHaveBeenCalled()
    expect(log.warn.mock.calls[0][0]).toContain("ohne E-Mail")
  })

  it("verschickt nichts für eine stornierte Sendung", async () => {
    const { run, create } = setup({ fulfillment: { ...loaded, canceled_at: "2026-09-29T10:00:00Z" } })
    await run({ id: "ful_01XYZ" })
    expect(create).not.toHaveBeenCalled()
  })

  it("verschickt nichts, wenn Sendung oder Bestellung fehlen", async () => {
    const missingOrderLink = setup({ fulfillment: { ...loaded, order: null } })
    await missingOrderLink.run({ id: "ful_01XYZ" })
    expect(missingOrderLink.create).not.toHaveBeenCalled()
    expect(missingOrderLink.log.error).toHaveBeenCalledTimes(1)

    const missingShipment = setup({ graph: jest.fn().mockResolvedValue({ data: [] }) })
    await missingShipment.run({ id: "ful_weg" })
    expect(missingShipment.create).not.toHaveBeenCalled()
    expect(missingShipment.log.error).toHaveBeenCalledTimes(1)

    const noId = setup()
    await noId.run({})
    expect(noId.create).not.toHaveBeenCalled()
    expect(noId.query.graph).not.toHaveBeenCalled()
  })

  it("wirft nie: weder wenn das Laden scheitert noch wenn der Mailserver klemmt", async () => {
    const broken = setup({ graph: jest.fn().mockRejectedValue(new Error("db weg")) })
    await expect(broken.run({ id: "ful_01XYZ" })).resolves.toBeUndefined()
    expect(broken.create).not.toHaveBeenCalled()
    expect(broken.log.error.mock.calls[0][0]).toContain("db weg")

    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await expect(smtp.run({ id: "ful_01XYZ" })).resolves.toBeUndefined()
    expect(smtp.log.error).toHaveBeenCalledTimes(1)
  })

  it("schreibt die E-Mail-Adresse nie ins Log", async () => {
    const smtp = setup({
      create: jest.fn().mockRejectedValue(new Error("550 anna@example.ch rejected")),
    })
    await smtp.run({ id: "ful_01XYZ" })
    const noMail = setup({ loadedOrder: { ...order, email: "" } })
    await noMail.run({ id: "ful_01XYZ" })
    const skipped = setup()
    await skipped.run({ id: "ful_01XYZ", no_notification: true })
    expect(logged(smtp.log) + logged(noMail.log) + logged(skipped.log)).not.toContain("anna@example.ch")
  })
})
