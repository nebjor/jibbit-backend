/**
 * Abholung im Laden: Erkennung ohne Namensvergleich, Stempel des Providers,
 * Bestell- und Abholbereit-Mail.
 */

import {
  PICKUP_ADDRESS_LINES,
  PICKUP_FULFILLMENT_OPTION_ID,
  PICKUP_HOURS,
  isPickupOrder,
  isPickupShippingOption,
  resolvePickup,
} from "../lib/pickup"
import {
  type OrderView,
  renderOrderConfirmation,
  renderOrderNotification,
  renderOrderPush,
} from "../lib/order-notification"
import {
  type ShipmentOrderView,
  type ShipmentView,
  renderShippingConfirmation,
} from "../lib/shipping-notification"
import SwissShippingProviderService from "../modules/swiss-shipping/service"
import orderPlacedHandler from "../subscribers/order-placed"
import shipmentCreatedHandler from "../subscribers/shipment-created"

const settings = { storeName: "jibbit", backendUrl: "https://api.jibbit.ch" }

// Die Storefront füllt die Lieferadresse einer Abholbestellung mit dem Laden
// (Medusa verlangt eine Adresse in der Service-Zone) — die Mails dürfen
// diese Adresse nie als «Lieferadresse» ausgeben.
const storeAddress = {
  first_name: "Anna",
  last_name: "Muster",
  address_1: "Unterwegli 1",
  postal_code: "8404",
  city: "Winterthur",
  country_code: "ch",
  phone: "+41 76 000 00 00",
}

const pickupOrder: OrderView = {
  id: "order_01PICK",
  display_id: 2001,
  email: "anna@example.ch",
  total: 45.5,
  shipping_total: 0,
  items: [{ product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 1, unit_price: 45.5 }],
  shipping_address: storeAddress,
  shipping_methods: [
    { name: "Abholung im Laden", shipping_option_id: "so_pickup", data: { pickup: true, id: "swiss-pickup" } },
  ],
}

const shippingOrder: OrderView = {
  ...pickupOrder,
  id: "order_01SHIP",
  shipping_total: 4.5,
  shipping_address: { ...storeAddress, address_1: "Bahnhofstrasse 1", postal_code: "8001", city: "Zürich" },
  shipping_methods: [{ name: "Standardversand Schweiz", shipping_option_id: "so_standard", data: {} }],
}

describe("isPickupShippingOption", () => {
  it("erkennt die Option am Typ-Code, an metadata.pickup, an data.pickup und an der Fulfillment-Option", () => {
    expect(isPickupShippingOption({ type: { code: "pickup" } })).toBe(true)
    expect(isPickupShippingOption({ metadata: { pickup: true } })).toBe(true)
    expect(isPickupShippingOption({ data: { pickup: true } })).toBe(true)
    expect(isPickupShippingOption({ data: { id: PICKUP_FULFILLMENT_OPTION_ID } })).toBe(true)
  })

  it("erkennt sie NICHT am Namen", () => {
    expect(isPickupShippingOption({ id: "so_1", type: { code: "standard" }, data: { id: "swiss-standard" } })).toBe(false)
    expect(isPickupShippingOption({ ...({ name: "Abholung im Laden" } as object) })).toBe(false)
    expect(isPickupShippingOption(null)).toBe(false)
  })
})

describe("isPickupOrder", () => {
  it("liest den Marker an der Versandmethode oder an den Bestell-Metadaten", () => {
    expect(isPickupOrder(pickupOrder)).toBe(true)
    expect(isPickupOrder({ metadata: { pickup: true } })).toBe(true)
    expect(isPickupOrder({ metadata: { pickup: "true" } })).toBe(true)
    expect(isPickupOrder(shippingOrder)).toBe(false)
    expect(isPickupOrder({ shipping_methods: [{ data: null }] })).toBe(false)
    expect(isPickupOrder(undefined)).toBe(false)
  })
})

describe("resolvePickup", () => {
  it("fragt die Datenbank nicht, wenn die Bestellung es schon sagt", async () => {
    const graph = jest.fn()
    await expect(resolvePickup({ graph }, pickupOrder)).resolves.toBe(true)
    expect(graph).not.toHaveBeenCalled()
  })

  it("lädt sonst die Shipping Options der Versandmethoden und prüft deren Typ", async () => {
    const graph = jest.fn().mockResolvedValue({ data: [{ id: "so_standard", type: { code: "pickup" } }] })
    await expect(resolvePickup({ graph }, shippingOrder)).resolves.toBe(true)
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "shipping_option", filters: { id: ["so_standard"] } })
    )
  })

  it("gilt als Versand, wenn die Option nichts sagt, keine Methode da ist oder die Abfrage scheitert", async () => {
    await expect(
      resolvePickup({ graph: jest.fn().mockResolvedValue({ data: [{ type: { code: "standard" } }] }) }, shippingOrder)
    ).resolves.toBe(false)
    const graph = jest.fn()
    await expect(resolvePickup({ graph }, { shipping_methods: [] })).resolves.toBe(false)
    expect(graph).not.toHaveBeenCalled()
    const warn = jest.fn()
    await expect(
      resolvePickup({ graph: jest.fn().mockRejectedValue(new Error("db weg")) }, shippingOrder, { warn })
    ).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("so_standard"))
  })
})

describe("swiss-shipping Provider", () => {
  const service = new SwissShippingProviderService(
    { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any },
    { price: 4.5, freeShippingThreshold: 69 }
  )

  it("stempelt pickup: true in die Versandmethode, wenn die Option die Abholung ist", async () => {
    await expect(
      service.validateFulfillmentData({ id: "swiss-pickup", pickup: true }, {}, {} as any)
    ).resolves.toEqual({ pickup: true })
    await expect(
      service.validateFulfillmentData({ pickup: true }, { note: "bitte klingeln" }, {} as any)
    ).resolves.toEqual({ note: "bitte klingeln", pickup: true })
  })

  it("lässt die Methode des Versands unverändert", async () => {
    await expect(service.validateFulfillmentData({ id: "swiss-standard" }, { a: 1 }, {} as any)).resolves.toEqual({
      a: 1,
    })
    await expect(service.validateFulfillmentData({}, {}, {} as any)).resolves.toEqual({})
    await expect(service.validateFulfillmentData({}, undefined as any, {} as any)).resolves.toEqual({})
  })

  it("bietet die Abholung als Fulfillment-Option an", async () => {
    const options = await service.getFulfillmentOptions()
    expect(options).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PICKUP_FULFILLMENT_OPTION_ID, pickup: true, price: 0 })])
    )
  })
})

describe("Bestellbestätigung bei Abholung", () => {
  const mail = renderOrderConfirmation(pickupOrder, settings)

  it("sagt, dass die Bestellung abgeholt wird, und nennt Laden und Abholzeiten statt der Lieferadresse", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("wir melden uns, sobald die Bestellung abholbereit ist")
      expect(body).toContain("Abholung im Laden")
      for (const line of PICKUP_ADDRESS_LINES) expect(body).toContain(line)
      expect(body).toContain(`Abholzeiten: ${PICKUP_HOURS}`)
      expect(body).not.toContain("Lieferadresse")
      expect(body).not.toContain("schicken sie so bald wie möglich los")
      expect(body).not.toContain("Versand")
    }
  })

  it("führt die Abholung als Position mit CHF 0.00", () => {
    expect(mail.text).toContain("Abholung im Laden: CHF 0.00")
    expect(mail.html).toContain("Abholung im Laden</td>")
  })

  it("ändert die Versandmail nicht", () => {
    const shipping = renderOrderConfirmation(shippingOrder, settings)
    expect(shipping.text).toContain("schicken sie so bald wie möglich los")
    expect(shipping.text).toContain("Lieferadresse:")
    expect(shipping.text).toContain("Versand (Standardversand Schweiz): CHF 4.50")
    expect(shipping.text).not.toContain("Abholung")
  })
})

describe("Betreiber-Meldung bei Abholung", () => {
  it("steht im Betreff, ersetzt den Ort und sagt dem Team, was zu tun ist", () => {
    const mail = renderOrderNotification(pickupOrder, settings)
    expect(mail.subject).toBe("Neue Bestellung #2001 – CHF 45.50 – Abholung im Laden")
    expect(mail.text).toContain("Kunde: Anna Muster, anna@example.ch – Abholung im Laden")
    expect(mail.text).not.toContain("(8404 Winterthur)")
    expect(mail.text).toContain("nicht versenden")
    expect(mail.html).toContain("als versendet markieren")

    const shipping = renderOrderNotification(shippingOrder, settings)
    expect(shipping.subject).toBe("Neue Bestellung #2001 – CHF 45.50")
    expect(shipping.text).toContain("(8001 Zürich)")
    expect(shipping.text).not.toContain("Abholung")
  })

  it("steht im Push, der Titel bleibt ASCII", () => {
    const push = renderOrderPush(pickupOrder, settings)
    expect(push.title).toBe("Neue Bestellung #2001")
    expect(push.message).toBe("CHF 45.50 · 1 Artikel · Abholung im Laden")
    expect(renderOrderPush(shippingOrder, settings).message).toBe("CHF 45.50 · 1 Artikel")
  })
})

describe("Abholbereit-Mail", () => {
  const order: ShipmentOrderView = {
    ...pickupOrder,
    items: [{ id: "orli_1", product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 1, unit_price: 45.5 }],
    pickup: true,
  }
  const shipment: ShipmentView = {
    id: "ful_01PICK",
    items: [{ title: "50er Box", quantity: 1, line_item_id: "orli_1" }],
    // Im Admin eingetragen, obwohl nichts verschickt wird — darf nicht erscheinen.
    labels: [{ tracking_number: "99.00.123456.12345678", tracking_url: "#" }],
    delivery_address: storeAddress,
  }
  const mail = renderShippingConfirmation(shipment, order, { storeName: "jibbit" })

  it("heisst «abholbereit», nennt Laden und Abholzeiten und keine Sendungsnummer", () => {
    expect(mail.subject).toBe("Deine Bestellung #2001 bei jibbit ist abholbereit")
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Deine Bestellung #2001 ist abholbereit")
      expect(body).toContain("Zur Abholung bereit")
      expect(body).toContain("1 × RAW Black King Size – 50er Box")
      for (const line of PICKUP_ADDRESS_LINES) expect(body).toContain(line)
      expect(body).toContain(`Abholzeiten: ${PICKUP_HOURS}`)
      expect(body).toContain("Fragen zur Abholung?")
      expect(body).not.toContain("99.00.123456.12345678")
      expect(body).not.toContain("Sendungsnummer")
      expect(body).not.toContain("Sendungsverfolgung")
      expect(body).not.toContain("unterwegs")
      expect(body).not.toContain("Post")
      expect(body).not.toContain("Lieferadresse")
    }
  })

  it("sagt bei einer Teilbereitstellung, dass der Rest folgt", () => {
    const partialOrder: ShipmentOrderView = {
      ...order,
      items: [
        ...(order.items ?? []),
        { id: "orli_2", product_title: "Grinder", variant_title: "Standard", quantity: 1, unit_price: 20 },
      ],
    }
    const partial = renderShippingConfirmation(shipment, partialOrder, { storeName: "jibbit" })
    expect(partial.subject).toBe("Ein Teil deiner Bestellung #2001 bei jibbit ist abholbereit")
    expect(partial.text).toContain("legen wir separat bereit")
    expect(partial.text).not.toContain("Grinder")
  })

  it("erkennt die Abholung auch ohne gesetztes pickup-Feld an der Versandmethode", () => {
    const { pickup: _ignored, ...withoutFlag } = order
    expect(renderShippingConfirmation(shipment, withoutFlag, { storeName: "jibbit" }).subject).toContain("abholbereit")
  })
})

describe("Subscriber mit Abholung", () => {
  function container(orderRow: Record<string, unknown>, fulfillment?: Record<string, unknown>) {
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
    const create = jest.fn().mockResolvedValue([])
    const graph = jest.fn(async ({ entity }: { entity: string }) => ({
      data:
        entity === "fulfillment"
          ? [fulfillment]
          : entity === "shipping_option"
            ? [{ id: "so_pickup", type: { code: "pickup" } }]
            : [orderRow],
    }))
    return {
      log,
      create,
      graph,
      container: {
        resolve: (key: string) =>
          key === "logger" ? log : key === "query" ? { graph } : { createNotifications: create },
      },
    }
  }

  it("order.placed: Bestätigung und Meldung sprechen von Abholung, ohne Marker an der Bestellung über die Option", async () => {
    const row = { ...shippingOrder, shipping_methods: [{ name: "x", shipping_option_id: "so_pickup", data: {} }] }
    const { container: c, create, graph } = container(row)
    const saved = { ...process.env }
    process.env.ORDER_NOTIFICATION_TO = "team@jibbit.ch"
    delete process.env.NTFY_URL
    try {
      await orderPlacedHandler({ event: { data: { id: row.id }, name: "order.placed" }, container: c } as any)
    } finally {
      process.env = saved
    }
    expect(graph).toHaveBeenCalledWith(expect.objectContaining({ entity: "shipping_option" }))
    const templates = create.mock.calls.map(([n]) => [n.template, n.content.subject])
    expect(templates).toContainEqual(["order-confirmation", "Deine Bestellung #2001 bei jibbit"])
    expect(templates).toContainEqual(["order-notification", "Neue Bestellung #2001 – CHF 45.50 – Abholung im Laden"])
    const confirmation = create.mock.calls.find(([n]) => n.template === "order-confirmation")?.[0]
    expect(confirmation.content.text).toContain("abholbereit")
  })

  it("shipment.created: schickt die Abholbereit-Mail unter eigener Vorlage, Schlüssel bleibt derselbe", async () => {
    const fulfillment = {
      id: "ful_01PICK",
      canceled_at: null,
      order: { id: pickupOrder.id },
      items: [{ title: "50er Box", quantity: 1, line_item_id: "orli_1" }],
      labels: [],
    }
    const row = {
      ...pickupOrder,
      items: [{ id: "orli_1", product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 1, unit_price: 45.5 }],
    }
    const { container: c, create } = container(row, fulfillment)
    await shipmentCreatedHandler({
      event: { data: { id: "ful_01PICK", no_notification: false }, name: "shipment.created" },
      container: c,
    } as any)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "pickup-ready",
        idempotency_key: "shipping-confirmation:ful_01PICK",
        content: expect.objectContaining({ subject: "Deine Bestellung #2001 bei jibbit ist abholbereit" }),
      })
    )
  })
})
