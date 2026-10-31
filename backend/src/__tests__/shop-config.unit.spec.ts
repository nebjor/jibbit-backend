import {
  JIBBIT_DEFAULTS,
  ShopConfigError,
  loadShopConfig,
} from "../lib/shop-config"
import { aktionspreisliste } from "../lib/preistabelle"

const STRICT_MIN = {
  SHOP_STRICT: "true",
  STORE_NAME: "Stecklingspost",
  STORE_URL: "https://stecklingspost.ch/",
  SHOP_CONTACT_EMAIL: "info@stecklingspost.ch",
  ORDER_NOTIFICATION_TO: "a@stecklingspost.ch, b@stecklingspost.ch",
}

describe("loadShopConfig: jibbit-Rückfall (Standard)", () => {
  it("liefert ohne Env exakt die bisherigen jibbit-Werte", () => {
    expect(loadShopConfig({})).toEqual({
      storeName: "jibbit",
      storeUrl: "http://localhost:8000",
      contactEmail: "info@jibbit.ch",
      orderNotificationTo: ["joris@jibbit.ch"],
      pickupAddressLines: ["jibbit (Neber Import)", "Unterwegli 1", "8404 Winterthur"],
      pickupHours: "Mo–Sa 09:00–17:00",
      vatNote: "keine MWST ausgewiesen (nicht mehrwertsteuerpflichtig)",
      priceListTitle: "Aktionspreise jibbit.ch",
      clientIpHeader: "x-client-ip",
    })
  })

  it("Env überschreibt, leere/Leerzeichen-Werte zählen als nicht gesetzt", () => {
    const cfg = loadShopConfig({
      STORE_NAME: " Foo ",
      SHOP_CONTACT_EMAIL: "  ",
      ORDER_NOTIFICATION_TO: " , x@y.ch ,z@y.ch",
      SHOP_PICKUP_ADDRESS: "Laden|Weg 1| 8000 Zürich ",
      SHOP_PICKUP_HOURS: "Di 10-12",
      STORE_URL: "https://foo.ch///",
      CLIENT_IP_HEADER: " X-Foo-IP ",
    })
    expect(cfg.storeName).toBe("Foo")
    expect(cfg.contactEmail).toBe(JIBBIT_DEFAULTS.contactEmail)
    expect(cfg.orderNotificationTo).toEqual(["x@y.ch", "z@y.ch"])
    expect(cfg.pickupAddressLines).toEqual(["Laden", "Weg 1", "8000 Zürich"])
    expect(cfg.pickupHours).toBe("Di 10-12")
    expect(cfg.storeUrl).toBe("https://foo.ch")
    expect(cfg.clientIpHeader).toBe("x-foo-ip")
  })

  it("SHOP_VAT_NOTE leer schaltet den MWST-Hinweis ab", () => {
    expect(loadShopConfig({ SHOP_VAT_NOTE: "" }).vatNote).toBe("")
    expect(loadShopConfig({ SHOP_VAT_NOTE: "inkl. 8.1% MWST" }).vatNote).toBe("inkl. 8.1% MWST")
  })

  it("Preislisten-Titel: jibbit-Default bleibt (Suche per Titel in der DB)", () => {
    expect(loadShopConfig({ STORE_NAME: "Anders" }).priceListTitle).toBe("Aktionspreise jibbit.ch")
    expect(loadShopConfig({ SHOP_PRICE_LIST_TITLE: "Staffeln" }).priceListTitle).toBe("Staffeln")
  })
})

describe("loadShopConfig: SHOP_STRICT", () => {
  it("nimmt die Werte des Shops und kennt keine jibbit-Defaults", () => {
    const cfg = loadShopConfig(STRICT_MIN)
    expect(cfg).toEqual({
      storeName: "Stecklingspost",
      storeUrl: "https://stecklingspost.ch",
      contactEmail: "info@stecklingspost.ch",
      orderNotificationTo: ["a@stecklingspost.ch", "b@stecklingspost.ch"],
      pickupAddressLines: [],
      pickupHours: "",
      vatNote: "",
      priceListTitle: "Aktionspreise Stecklingspost",
      clientIpHeader: "x-client-ip",
    })
    expect(JSON.stringify(cfg)).not.toMatch(/jibbit/i)
  })

  it("nennt alle fehlenden Pflichtwerte auf einmal", () => {
    let error: unknown
    try {
      loadShopConfig({ SHOP_STRICT: "true", STORE_NAME: "X" })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ShopConfigError)
    expect((error as ShopConfigError).missing).toEqual(["STORE_URL", "SHOP_CONTACT_EMAIL", "ORDER_NOTIFICATION_TO"])
    expect((error as Error).message).toContain("SHOP_CONTACT_EMAIL")
  })

  it.each(["1", "true", "TRUE", "yes"])("erkennt SHOP_STRICT=%s", (value) => {
    expect(() => loadShopConfig({ SHOP_STRICT: value })).toThrow(ShopConfigError)
  })

  it.each(["", "false", "0"])("SHOP_STRICT=%j ist nicht strikt", (value) => {
    expect(() => loadShopConfig({ SHOP_STRICT: value })).not.toThrow()
  })
})

describe("aktionspreisliste", () => {
  const prev = process.env.SHOP_PRICE_LIST_TITLE
  afterEach(() => {
    if (prev === undefined) delete process.env.SHOP_PRICE_LIST_TITLE
    else process.env.SHOP_PRICE_LIST_TITLE = prev
  })

  it("heisst bei jibbit unverändert «Aktionspreise jibbit.ch»", () => {
    delete process.env.SHOP_PRICE_LIST_TITLE
    expect(aktionspreisliste().title).toBe("Aktionspreise jibbit.ch")
  })

  it("folgt SHOP_PRICE_LIST_TITLE", () => {
    process.env.SHOP_PRICE_LIST_TITLE = "Aktionspreise stecklingspost.ch"
    expect(aktionspreisliste().title).toBe("Aktionspreise stecklingspost.ch")
  })
})
