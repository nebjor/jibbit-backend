/**
 * Shop-Konfiguration — alles, was einen Shop vom anderen unterscheidet,
 * aus der Umgebung. Reine Logik ohne @medusajs-Importe.
 *
 * Zwei Betriebsarten:
 *
 *   - Standard (SHOP_STRICT leer): fehlende Werte fallen auf die bisherigen
 *     jibbit-Werte zurück. So verhält sich der bestehende jibbit-Server ohne
 *     Änderung an seiner .env gleich wie vorher. Die Defaults sind Übergang:
 *     sobald jibbit alle Werte in der .env setzt (siehe .env.example), kann
 *     SHOP_STRICT=true gesetzt und der Rückfall abgebaut werden.
 *   - SHOP_STRICT=true (neue Shops): keine jibbit-Defaults. Pflichtwerte
 *     fehlen -> Fehler mit Liste aller fehlenden Variablen.
 *
 * Gelesen wird bei jedem Aufruf (kein Cache), damit Tests die Umgebung
 * setzen können; die Kosten sind ein paar String-Operationen.
 */

export type ShopEnv = Record<string, string | undefined>

export interface ShopConfig {
  storeName: string
  /** Basis-URL der Storefront, ohne abschliessenden Slash. */
  storeUrl: string
  /** Adresse, die in Kundenmails als Kontakt steht. */
  contactEmail: string
  /** Empfänger der Betreiber-Mail bei neuen Bestellungen. */
  orderNotificationTo: string[]
  /** Zeilen der Abholadresse; leer = der Shop bietet keine Abholung an. */
  pickupAddressLines: string[]
  pickupHours: string
  /** Hinweis zur MWST in der Bestätigung; leer = keine Zeile. */
  vatNote: string
  /** Titel der Preisliste mit den Mengenstaffeln (wird per Titel gesucht!). */
  priceListTitle: string
  /** Header, in dem die Storefront die Besucher-IP mitgibt. */
  clientIpHeader: string
}

/** Bisheriger Header von jibbit; wird immer zusätzlich akzeptiert. */
export const LEGACY_CLIENT_IP_HEADER = "x-jibbit-client-ip"
export const DEFAULT_CLIENT_IP_HEADER = "x-client-ip"

/** Die Werte, auf die sich der laufende jibbit-Server heute verlässt. */
export const JIBBIT_DEFAULTS = {
  storeName: "jibbit",
  contactEmail: "info@jibbit.ch",
  orderNotificationTo: "joris@jibbit.ch",
  pickupAddress: "jibbit (Neber Import)|Unterwegli 1|8404 Winterthur",
  pickupHours: "Mo–Fr 09:00–17:00",
  vatNote: "keine MWST ausgewiesen (nicht mehrwertsteuerpflichtig)",
  priceListTitle: "Aktionspreise jibbit.ch",
} as const

export class ShopConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Shop-Konfiguration unvollständig (SHOP_STRICT=true): ${missing.join(", ")} fehlt. ` +
        `Siehe docs/shop-config.md.`
    )
    this.name = "ShopConfigError"
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function list(value: string | undefined, separator: string): string[] {
  return (value ?? "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
}

function isTrue(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase())
}

export function isStrict(env: ShopEnv = process.env): boolean {
  return isTrue(env.SHOP_STRICT)
}

export function loadShopConfig(env: ShopEnv = process.env): ShopConfig {
  const strict = isStrict(env)
  const fallback = <K extends keyof typeof JIBBIT_DEFAULTS>(key: K): string | undefined =>
    strict ? undefined : JIBBIT_DEFAULTS[key]

  const storeName = clean(env.STORE_NAME) ?? fallback("storeName")
  const storeUrl = clean(env.STORE_URL)
  const contactEmail = clean(env.SHOP_CONTACT_EMAIL) ?? fallback("contactEmail")
  const recipients = list(env.ORDER_NOTIFICATION_TO, ",")
  const pickupRaw = clean(env.SHOP_PICKUP_ADDRESS) ?? fallback("pickupAddress")
  const pickupHours = clean(env.SHOP_PICKUP_HOURS) ?? fallback("pickupHours") ?? ""
  // Leerer String ist ein gültiger Wert: «kein MWST-Hinweis».
  const vatNote = env.SHOP_VAT_NOTE !== undefined ? env.SHOP_VAT_NOTE.trim() : (fallback("vatNote") ?? "")

  if (strict) {
    const missing: string[] = []
    if (!storeName) missing.push("STORE_NAME")
    if (!storeUrl) missing.push("STORE_URL")
    if (!contactEmail) missing.push("SHOP_CONTACT_EMAIL")
    if (!recipients.length) missing.push("ORDER_NOTIFICATION_TO")
    if (missing.length) throw new ShopConfigError(missing)
  }

  const name = storeName as string
  return {
    storeName: name,
    storeUrl: (storeUrl ?? "http://localhost:8000").replace(/\/+$/, ""),
    contactEmail: contactEmail as string,
    orderNotificationTo: recipients.length ? recipients : [JIBBIT_DEFAULTS.orderNotificationTo],
    pickupAddressLines: list(pickupRaw, "|"),
    pickupHours,
    vatNote,
    priceListTitle: clean(env.SHOP_PRICE_LIST_TITLE) ?? (strict ? `Aktionspreise ${name}` : JIBBIT_DEFAULTS.priceListTitle),
    clientIpHeader: (clean(env.CLIENT_IP_HEADER) ?? DEFAULT_CLIENT_IP_HEADER).toLowerCase(),
  }
}

export function getShopConfig(): ShopConfig {
  return loadShopConfig(process.env)
}
