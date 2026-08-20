/**
 * Tests für den Inhalt der Passwort-zurücksetzen-E-Mail.
 *
 * Der Kern ist nicht die Formulierung, sondern zwei Eigenschaften, die man
 * einer E-Mail nicht ansieht:
 *
 *   - Der Link wird aus der konfigurierten STORE_URL gebaut und aus nichts
 *     anderem. Ein aus dem Host-Header gebauter Link wäre eine Einladung,
 *     sich das Reset-Token per echter E-Mail von uns zuschicken zu lassen.
 *   - Der Text verrät nicht, ob das Konto aus dem Odoo-Import stammt. Stünde
 *     der Umzugshinweis nur in den E-Mails an migrierte Konten, wäre die
 *     E-Mail selbst das Unterscheidungsmerkmal.
 */

import {
  RESET_TOKEN_TTL_MINUTES,
  buildResetUrl,
  renderPasswordResetEmail,
} from "../lib/password-reset-email"

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.testtoken.signature"

describe("buildResetUrl", () => {
  it("hängt das Token an den Storefront-Pfad", () => {
    const url = new URL(buildResetUrl("https://jibbit.ch", TOKEN))
    expect(url.origin).toBe("https://jibbit.ch")
    expect(url.pathname).toBe("/konto/passwort-neu")
    expect(url.searchParams.get("token")).toBe(TOKEN)
  })

  it("behält einen Unterpfad der Basis-URL nicht — der Pfad ist absolut gemeint", () => {
    const url = new URL(buildResetUrl("https://jibbit.ch/shop", TOKEN))
    expect(url.pathname).toBe("/konto/passwort-neu")
  })

  it("funktioniert mit dem lokalen Entwicklungs-Host", () => {
    const url = new URL(buildResetUrl("http://localhost:8000", TOKEN))
    expect(url.origin).toBe("http://localhost:8000")
    expect(url.searchParams.get("token")).toBe(TOKEN)
  })

  it("wirft ohne STORE_URL, statt einen kaputten Link zu verschicken", () => {
    expect(() => buildResetUrl(undefined, TOKEN)).toThrow(/STORE_URL/)
    expect(() => buildResetUrl("", TOKEN)).toThrow(/STORE_URL/)
    expect(() => buildResetUrl("   ", TOKEN)).toThrow(/STORE_URL/)
  })

  it("lehnt eine STORE_URL ab, die kein http(s) ist", () => {
    expect(() => buildResetUrl("javascript:alert(1)", TOKEN)).toThrow()
    expect(() => buildResetUrl("ftp://jibbit.ch", TOKEN)).toThrow(/http/)
    expect(() => buildResetUrl("nicht-mal-eine-url", TOKEN)).toThrow()
  })

  it("wirft ohne Token", () => {
    expect(() => buildResetUrl("https://jibbit.ch", "")).toThrow(/Token/)
  })

  it("kodiert Tokens mit Sonderzeichen, statt die Query zu zerlegen", () => {
    const url = new URL(buildResetUrl("https://jibbit.ch", "a b&c=d"))
    expect(url.searchParams.get("token")).toBe("a b&c=d")
    expect(url.search).not.toContain("c=d&")
  })
})

describe("renderPasswordResetEmail", () => {
  const base = {
    storeUrl: "https://jibbit.ch",
    storeName: "jibbit",
    token: TOKEN,
  }

  it("nennt dieselbe Frist, die Medusa tatsächlich durchsetzt", () => {
    // Medusa kodiert expiresIn: "15m" fest in
    // generateResetPasswordTokenWorkflow. Ändert sich das, muss der Text mit.
    expect(RESET_TOKEN_TTL_MINUTES).toBe(15)
    const mail = renderPasswordResetEmail(base)
    expect(mail.text).toContain("15 Minuten")
    expect(mail.html).toContain("15 Minuten")
  })

  it("legt den Link in Text und HTML", () => {
    const mail = renderPasswordResetEmail(base)
    const link = buildResetUrl(base.storeUrl, TOKEN)
    expect(mail.text).toContain(link)
    expect(mail.html).toContain("konto/passwort-neu")
  })

  it("ist wortgleich, ob mit oder ohne Odoo-Vorgeschichte", () => {
    // Es gibt hier bewusst keinen Parameter "migriert". Der Umzugshinweis
    // steht in jeder dieser E-Mails.
    const mail = renderPasswordResetEmail(base)
    expect(mail.text).toContain("früheren Shop")
    expect(mail.html).toContain("früheren Shop")
  })

  it("grüsst mit Vornamen, wenn einer bekannt ist — und sonst neutral", () => {
    expect(renderPasswordResetEmail({ ...base, firstName: "Anna" }).text).toContain(
      "Hallo Anna"
    )
    expect(renderPasswordResetEmail({ ...base, firstName: null }).text).toContain("Hallo\n")
    expect(renderPasswordResetEmail({ ...base, firstName: "   " }).text).toContain("Hallo\n")
  })

  it("escaped einen Namen, statt ihn als HTML zu übernehmen", () => {
    const mail = renderPasswordResetEmail({
      ...base,
      firstName: '<img src=x onerror="alert(1)">',
    })
    expect(mail.html).not.toContain("<img")
    expect(mail.html).toContain("&lt;img")
  })

  it("nennt den Shop im Betreff", () => {
    expect(renderPasswordResetEmail(base).subject).toContain("jibbit")
  })
})
