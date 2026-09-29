import { formatChf } from "../lib/email-format"
import {
  DEFAULT_ORDER_NOTIFICATION_TO,
  type OrderView,
  adminOrderUrl,
  orderNotificationRecipients,
  renderOrderConfirmation,
  renderOrderNotification,
  renderOrderPush,
} from "../lib/order-notification"

const settings = {
  storeName: "jibbit",
  backendUrl: "https://api.jibbit.ch",
}

const order: OrderView = {
  id: "order_01ABC",
  display_id: 1042,
  email: "anna@example.ch",
  total: 1236.5,
  shipping_total: 9,
  items: [
    { product_title: "RAW Black King Size", variant_title: "50er Box", quantity: 2, unit_price: 45.5 },
    { title: "Grinder <Alu>", variant_title: "Standard", quantity: 1, unit_price: 1136.5 },
  ],
  shipping_address: {
    first_name: "Anna",
    last_name: "Muster",
    address_1: "Bahnhofstrasse 1",
    postal_code: "8001",
    city: "Zürich",
    country_code: "ch",
  },
  shipping_methods: [{ name: "Paket" }],
}

describe("formatChf", () => {
  it("schreibt Beträge im Schweizer Format", () => {
    expect(formatChf(9)).toBe("CHF 9.00")
    expect(formatChf(1236.5)).toBe("CHF 1’236.50")
    expect(formatChf("3.75")).toBe("CHF 3.75")
    expect(formatChf(undefined)).toBe("CHF 0.00")
  })
})

describe("orderNotificationRecipients", () => {
  it("fällt ohne Wert auf joris@jibbit.ch zurück", () => {
    expect(DEFAULT_ORDER_NOTIFICATION_TO).toBe("joris@jibbit.ch")
    expect(orderNotificationRecipients(undefined)).toEqual(["joris@jibbit.ch"])
    expect(orderNotificationRecipients("  ")).toEqual(["joris@jibbit.ch"])
    expect(orderNotificationRecipients(" , ")).toEqual(["joris@jibbit.ch"])
  })

  it("nimmt eine kommagetrennte Liste", () => {
    expect(orderNotificationRecipients("a@jibbit.ch, b@jibbit.ch")).toEqual([
      "a@jibbit.ch",
      "b@jibbit.ch",
    ])
  })
})

describe("adminOrderUrl", () => {
  it("zeigt auf die Bestellung im Dashboard", () => {
    expect(adminOrderUrl("https://api.jibbit.ch/", "order_01ABC")).toBe(
      "https://api.jibbit.ch/app/orders/order_01ABC"
    )
  })
})

describe("renderOrderConfirmation", () => {
  const mail = renderOrderConfirmation(order, settings)

  it("nennt Bestellnummer, Artikel mit Menge und Stückpreis, Versand und Total", () => {
    expect(mail.subject).toContain("#1042")
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("#1042")
      expect(body).toContain("2 × RAW Black King Size – 50er Box")
      expect(body).toContain("à CHF 45.50")
      expect(body).toContain("CHF 91.00")
      expect(body).toContain("Versand (Paket)")
      expect(body).toContain("CHF 9.00")
      expect(body).toContain("CHF 1’236.50")
    }
  })

  it("enthält MWST-Hinweis, Lieferadresse, Kontakt", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("keine MWST ausgewiesen (nicht mehrwertsteuerpflichtig)")
      expect(body).toContain("Bahnhofstrasse 1")
      expect(body).toContain("8001 Zürich")
      expect(body).toContain("info@jibbit.ch")
    }
    expect(mail.text).not.toMatch(/MwSt\.?:/)
  })

  it("verlinkt keine Rückgabe und nennt kein Widerrufsrecht", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/Rückgabe|Widerruf|rueckgabe|Retoure/i)
    }
  })

  it("schreibt Schweizer Hochdeutsch ohne ß und grüsst mit Vornamen", () => {
    expect(mail.text).toContain("Hallo Anna")
    expect(mail.text + mail.html).not.toContain("ß")
  })

  it("escaped Artikelnamen im HTML", () => {
    expect(mail.html).toContain("Grinder &lt;Alu&gt;")
    expect(mail.html).not.toContain("<Alu>")
  })

  it("lässt Platzhalter-Varianten wie «Standard» weg", () => {
    expect(mail.text).not.toContain("– Standard")
  })

  it("kommt ohne Adresse und Anzeigenummer aus", () => {
    const bare = renderOrderConfirmation({ id: "order_X", total: 5, items: [] }, settings)
    expect(bare.subject).toContain("order_X")
    expect(bare.text).toContain("Hallo\n")
    expect(bare.text).not.toContain("Lieferadresse")
  })
})

describe("renderOrderNotification", () => {
  const mail = renderOrderNotification(order, settings)

  it("ist kurz: Nummer, Total, Artikel, Kunde, Admin-Link", () => {
    expect(mail.subject).toBe("Neue Bestellung #1042 – CHF 1’236.50")
    expect(mail.text).toContain("Kunde: Anna Muster, anna@example.ch (8001 Zürich)")
    expect(mail.text).toContain("1 × Grinder <Alu>")
    expect(mail.text).toContain("https://api.jibbit.ch/app/orders/order_01ABC")
    expect(mail.html).toContain('href="https://api.jibbit.ch/app/orders/order_01ABC"')
    expect(mail.html).toContain("Grinder &lt;Alu&gt;")
  })
})

describe("renderOrderPush", () => {
  it("setzt Titel, Total mit Artikelzahl und Klick-Link", () => {
    expect(renderOrderPush(order, settings)).toEqual({
      title: "Neue Bestellung #1042",
      message: "CHF 1’236.50 · 3 Artikel",
      click: "https://api.jibbit.ch/app/orders/order_01ABC",
      tags: "package",
    })
  })

  it("hält den Titel ASCII, weil er als HTTP-Header geht", () => {
    expect(renderOrderPush(order, settings).title).toMatch(/^[\x20-\x7e]+$/)
  })
})
