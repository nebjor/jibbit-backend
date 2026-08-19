/**
 * Tests für die Odoo → Medusa-Kundenzuordnung.
 *
 * Alle Namen, Firmen und Adressen hier sind ERFUNDEN. In diesem Repository
 * darf kein echter Kundendatensatz landen — auch nicht als Testfixture
 * (Schweizer DSG, siehe docs/odoo-datenmigration.md).
 *
 * Getestet wird planCustomerImport() direkt: die Funktion ist rein, braucht
 * keine Datenbank und entscheidet alles, was beim Import schiefgehen kann.
 */

import {
  OdooPartner,
  normalizeEmail,
  pickWinner,
  planCustomerImport,
  splitName,
} from "../scripts/odoo-customer-mapping"

/** Kurzform für eine Partnerzeile; alles Nicht-Gesetzte bleibt leer. */
function partner(p: Partial<OdooPartner> & { id: number }): OdooPartner {
  return {
    name: null,
    is_company: false,
    parent_id: null,
    type: "contact",
    email: null,
    customer_rank: 1,
    active: true,
    ...p,
  }
}

const CH = { country_code: "CH", state_code: "ZH" }

describe("normalizeEmail", () => {
  it("trimmt und schreibt klein", () => {
    expect(normalizeEmail("  Anna@Beispiel.CH ")).toBe("anna@beispiel.ch")
  })

  it("nimmt bei mehreren Adressen die erste", () => {
    expect(normalizeEmail("anna@beispiel.ch, buchhaltung@beispiel.ch")).toBe(
      "anna@beispiel.ch"
    )
    expect(normalizeEmail("anna@beispiel.ch; b@beispiel.ch")).toBe("anna@beispiel.ch")
  })

  it("holt die Adresse aus spitzen Klammern", () => {
    expect(normalizeEmail("Anna Beispiel <anna@beispiel.ch>")).toBe("anna@beispiel.ch")
  })

  it("verwirft, was keine Adresse ist", () => {
    expect(normalizeEmail("-")).toBeNull()
    expect(normalizeEmail("keine")).toBeNull()
    expect(normalizeEmail("anna@localhost")).toBeNull()
    expect(normalizeEmail("")).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })
})

describe("splitName", () => {
  it("trennt Vor- und Nachname am letzten Leerzeichen", () => {
    expect(splitName("Anna Beispiel")).toEqual({
      first_name: "Anna",
      last_name: "Beispiel",
    })
    expect(splitName("Anna Maria Beispiel")).toEqual({
      first_name: "Anna Maria",
      last_name: "Beispiel",
    })
  })

  it("versteht die Listenform Nachname, Vorname", () => {
    expect(splitName("Beispiel, Anna")).toEqual({
      first_name: "Anna",
      last_name: "Beispiel",
    })
  })

  it("lässt den Nachnamen leer, wenn nur ein Wort da ist", () => {
    expect(splitName("Kiosk")).toEqual({ first_name: "Kiosk", last_name: null })
    expect(splitName(null)).toEqual({ first_name: null, last_name: null })
  })
})

describe("Adresszuordnung", () => {
  const firma = partner({
    id: 1,
    name: "Beispiel Kiosk GmbH",
    is_company: true,
    email: "info@beispiel-kiosk.example",
    street: "Musterweg 1",
    zip: "8000",
    city: "Zürich",
    customer_rank: 4,
    ...CH,
  })

  const rechnung = partner({
    id: 2,
    name: "Buchhaltung",
    parent_id: 1,
    type: "invoice",
    customer_rank: 0,
    street: "Postfach 42",
    zip: "8001",
    city: "Zürich",
    ...CH,
  })

  const lieferung = partner({
    id: 3,
    name: "Filiale Bahnhof",
    parent_id: 1,
    type: "delivery",
    customer_rank: 0,
    street: "Bahnhofweg 9",
    zip: "8004",
    city: "Zürich",
    ...CH,
  })

  it("macht aus Firma + Unteradressen EINEN Kunden mit mehreren Adressen", () => {
    const plan = planCustomerImport([firma, rechnung, lieferung])

    expect(plan.create).toHaveLength(1)
    const kunde = plan.create[0]
    expect(kunde.email).toBe("info@beispiel-kiosk.example")
    expect(kunde.company_name).toBe("Beispiel Kiosk GmbH")
    expect(kunde.addresses).toHaveLength(3)
    expect(kunde.addresses.map((a) => a.odoo_partner_id)).toEqual([1, 2, 3])
  })

  it("markiert Rechnungs- und Lieferadresse anhand von type", () => {
    const kunde = planCustomerImport([firma, rechnung, lieferung]).create[0]

    const billing = kunde.addresses.filter((a) => a.is_default_billing)
    const shipping = kunde.addresses.filter((a) => a.is_default_shipping)

    expect(billing).toHaveLength(1)
    expect(shipping).toHaveLength(1)
    expect(billing[0].odoo_partner_id).toBe(2)
    expect(shipping[0].odoo_partner_id).toBe(3)
  })

  it("nimmt die eigene Adresse als Rückfall für beide Rollen", () => {
    const kunde = planCustomerImport([firma]).create[0]
    expect(kunde.addresses).toHaveLength(1)
    expect(kunde.addresses[0].is_default_billing).toBe(true)
    expect(kunde.addresses[0].is_default_shipping).toBe(true)
  })

  it("behandelt unbekannte type-Werte als Adresse, nicht als Kunde", () => {
    // Odoo 17 kennt mehr Auswahlwerte, als die Doku nennt.
    const seltsam = partner({
      id: 4,
      name: "Lager Süd",
      parent_id: 1,
      type: "other",
      email: "lager@beispiel-kiosk.example",
      street: "Lagerstrasse 7",
      zip: "8048",
      city: "Zürich",
      customer_rank: 0,
      ...CH,
    })

    const plan = planCustomerImport([firma, seltsam])
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0].addresses.map((a) => a.odoo_partner_id)).toEqual([1, 4])
  })

  it("macht aus einer Ansprechperson mit E-Mail einen eigenen Kunden", () => {
    const person = partner({
      id: 5,
      name: "Anna Beispiel",
      parent_id: 1,
      parent_name: "Beispiel Kiosk GmbH",
      type: "contact",
      email: "anna@beispiel-kiosk.example",
      customer_rank: 0,
    })

    const plan = planCustomerImport([firma, person])
    expect(plan.create).toHaveLength(2)

    const anna = plan.create.find((c) => c.email === "anna@beispiel-kiosk.example")!
    expect(anna.first_name).toBe("Anna")
    expect(anna.last_name).toBe("Beispiel")
    expect(anna.company_name).toBe("Beispiel Kiosk GmbH")
  })

  it("vererbt die Firmenadressen an die Ansprechperson, wenn die Firma keine E-Mail hat", () => {
    const stummeFirma = { ...firma, email: null }
    const person = partner({
      id: 5,
      name: "Anna Beispiel",
      parent_id: 1,
      parent_name: "Beispiel Kiosk GmbH",
      type: "contact",
      email: "anna@beispiel-kiosk.example",
      customer_rank: 0,
    })

    const plan = planCustomerImport([stummeFirma, person, rechnung, lieferung])

    expect(plan.create).toHaveLength(1)
    const anna = plan.create[0]
    expect(anna.email).toBe("anna@beispiel-kiosk.example")
    // Firmenadresse (1) plus beide Unteradressen (2, 3) landen bei ihr.
    expect(anna.addresses.map((a) => a.odoo_partner_id).sort()).toEqual([1, 2, 3])
    expect(plan.stats.addresses_orphaned).toBe(0)

    // Die Firma taucht als übersprungen auf — aber mit dem Hinweis, dass ihre
    // Daten über die Ansprechperson angekommen sind. Ohne diese Unterscheidung
    // würde der Import sie als Verlust melden.
    const firmaSkip = plan.skipped.find((x) => x.odoo_partner_id === 1)!
    expect(firmaSkip.reason).toBe("ohne-email")
    expect(firmaSkip.represented_by).toBe(5)
  })

  it("markiert Partner ohne Vertretung nicht als vertreten", () => {
    const einsam = partner({ id: 8, name: "Nora Frei", email: null })
    const skip = planCustomerImport([einsam]).skipped[0]
    expect(skip.represented_by).toBeUndefined()
  })

  it("meldet Adressen, für die es keinen Kunden gibt", () => {
    const stummeFirma = { ...firma, email: null }
    const plan = planCustomerImport([stummeFirma, rechnung])

    expect(plan.create).toHaveLength(0)
    expect(plan.stats.addresses_orphaned).toBe(2)
    expect(plan.skipped.filter((s) => s.reason === "adresse-ohne-kunde")).toHaveLength(2)
  })

  it("entfernt doppelt erfasste identische Adressen", () => {
    const zwilling = partner({
      id: 6,
      name: "Rechnungsadresse",
      parent_id: 1,
      type: "invoice",
      customer_rank: 0,
      // Gleiche Anschrift wie die Firma, nur anders geschrieben.
      street: "musterweg 1",
      zip: "8000",
      city: "ZÜRICH",
      ...CH,
    })

    const kunde = planCustomerImport([firma, zwilling]).create[0]
    expect(kunde.addresses).toHaveLength(1)
  })

  it("übernimmt keine Adresse ohne Land — es sei denn, eines wird vorgegeben", () => {
    const ohneLand = partner({
      id: 7,
      name: "Bea Muster",
      email: "bea@beispiel.example",
      street: "Seeweg 3",
      zip: "6000",
      city: "Luzern",
      country_code: null,
    })

    const strikt = planCustomerImport([ohneLand])
    expect(strikt.create[0].addresses).toHaveLength(0)
    expect(strikt.stats.addresses_without_country).toBe(1)

    const mitDefault = planCustomerImport([ohneLand], { defaultCountryCode: "ch" })
    expect(mitDefault.create[0].addresses).toHaveLength(1)
    expect(mitDefault.create[0].addresses[0].country_code).toBe("ch")
  })

  it("schreibt Länder- und Kantonscode klein, wie Medusa es erwartet", () => {
    const kunde = planCustomerImport([firma]).create[0]
    expect(kunde.addresses[0].country_code).toBe("ch")
    expect(kunde.addresses[0].province).toBe("zh")
  })
})

describe("Dublettenerkennung", () => {
  it("führt Partner mit derselben E-Mail zusammen, unabhängig von Gross-/Kleinschreibung", () => {
    const a = partner({
      id: 10,
      name: "Cornelia Widmer",
      email: "Cornelia.Widmer@Beispiel.example",
      street: "Ringweg 2",
      zip: "3000",
      city: "Bern",
      country_code: "CH",
    })
    const b = partner({
      id: 11,
      name: "C. Widmer",
      email: " cornelia.widmer@beispiel.example ",
      street: "Ringweg 2a",
      zip: "3000",
      city: "Bern",
      country_code: "CH",
    })

    const plan = planCustomerImport([a, b])

    expect(plan.create).toHaveLength(1)
    expect(plan.create[0].merged_partner_ids.sort()).toEqual([10, 11])
    expect(plan.stats.merged_duplicate_groups).toBe(1)
    expect(plan.stats.merged_partners).toBe(1)
    // Beide Anschriften bleiben erhalten, sie sind nicht identisch.
    expect(plan.create[0].addresses).toHaveLength(2)
  })

  it("lässt bei Firma + Ansprechperson die Firma gewinnen, holt den Namen aber von der Person", () => {
    const firma = partner({
      id: 20,
      name: "Widmer Handel AG",
      is_company: true,
      email: "kontakt@widmer-handel.example",
      customer_rank: 5,
    })
    const person = partner({
      id: 21,
      name: "Dario Widmer",
      parent_id: 20,
      parent_name: "Widmer Handel AG",
      type: "contact",
      email: "kontakt@widmer-handel.example",
      customer_rank: 0,
    })

    const kunde = planCustomerImport([firma, person]).create[0]

    expect(kunde.odoo_partner_id).toBe(20)
    expect(kunde.company_name).toBe("Widmer Handel AG")
    expect(kunde.first_name).toBe("Dario")
    expect(kunde.last_name).toBe("Widmer")
  })

  it("bevorzugt aktive vor archivierten Datensätzen", () => {
    const alt = partner({ id: 30, name: "Elin Roth", email: "elin@beispiel.example", active: false })
    const neu = partner({ id: 31, name: "Elin Roth", email: "elin@beispiel.example" })

    expect(pickWinner([alt, neu]).id).toBe(31)
    expect(pickWinner([neu, alt]).id).toBe(31)
  })

  it("entscheidet unabhängig von der Reihenfolge im Export", () => {
    const rows = [
      partner({ id: 40, name: "Fabio Item", email: "fabio@beispiel.example", customer_rank: 1 }),
      partner({ id: 41, name: "Fabio Item", email: "fabio@beispiel.example", customer_rank: 3 }),
      partner({ id: 42, name: "Fabio Item", email: "FABIO@beispiel.example", customer_rank: 2 }),
    ]

    const vorwaerts = planCustomerImport(rows)
    const rueckwaerts = planCustomerImport([...rows].reverse())

    expect(vorwaerts.create).toEqual(rueckwaerts.create)
    expect(vorwaerts.create[0].odoo_partner_id).toBe(41)
  })
})

describe("Kontakte ohne E-Mail", () => {
  it("legt sie nicht an und nennt den Grund", () => {
    const ohne = partner({ id: 50, name: "Gina Suter", email: null })
    const leer = partner({ id: 51, name: "Hans Frei", email: "   " })

    const plan = planCustomerImport([ohne, leer])

    expect(plan.create).toHaveLength(0)
    expect(plan.stats.skipped_no_email).toBe(2)
    expect(plan.skipped.map((s) => s.odoo_partner_id).sort()).toEqual([50, 51])
  })

  it("unterscheidet fehlende von unbrauchbaren E-Mail-Adressen", () => {
    const kaputt = partner({ id: 52, name: "Iris Lang", email: "-" })
    const plan = planCustomerImport([kaputt])

    expect(plan.stats.skipped_unusable_email).toBe(1)
    expect(plan.stats.skipped_no_email).toBe(0)
    expect(plan.skipped[0].reason).toBe("email-unbrauchbar")
  })

  it("verrät in der Skip-Liste keine Personendaten, nur IDs", () => {
    const ohne = partner({ id: 53, name: "Jonas Meier", email: null, parent_id: null })
    const plan = planCustomerImport([ohne])

    const serialisiert = JSON.stringify(plan.skipped)
    expect(serialisiert).not.toContain("Jonas")
    expect(serialisiert).not.toContain("Meier")
    expect(plan.skipped[0]).toEqual({
      odoo_partner_id: 53,
      reason: "ohne-email",
      parent_id: null,
    })
  })
})

describe("Auswahl der Partner", () => {
  it("überspringt Partner ohne customer_rank (Lieferanten, Mitarbeiter)", () => {
    const lieferant = partner({
      id: 60,
      name: "Grosshandel Nord AG",
      is_company: true,
      email: "bestellung@grosshandel-nord.example",
      customer_rank: 0,
      supplier_rank: 8,
    })

    expect(planCustomerImport([lieferant]).create).toHaveLength(0)
    expect(planCustomerImport([lieferant]).stats.skipped_not_a_customer).toBe(1)

    const mitAllen = planCustomerImport([lieferant], { includeNonCustomers: true })
    expect(mitAllen.create).toHaveLength(1)
  })

  it("überspringt archivierte Partner, nimmt sie auf Wunsch aber mit", () => {
    const alt = partner({
      id: 61,
      name: "Karin Beck",
      email: "karin@beispiel.example",
      active: false,
    })

    expect(planCustomerImport([alt]).create).toHaveLength(0)
    expect(planCustomerImport([alt]).stats.skipped_archived).toBe(1)
    expect(planCustomerImport([alt], { includeInactive: true }).create).toHaveLength(1)
  })
})

describe("Idempotenz", () => {
  const rows: OdooPartner[] = [
    partner({
      id: 70,
      name: "Lorenz Studer",
      email: "lorenz@beispiel.example",
      street: "Feldweg 8",
      zip: "4000",
      city: "Basel",
      country_code: "CH",
    }),
    partner({
      id: 71,
      name: "Beispiel Kiosk GmbH",
      is_company: true,
      email: "info@kiosk.example",
      street: "Marktgasse 3",
      zip: "9000",
      city: "St. Gallen",
      country_code: "CH",
    }),
    partner({
      id: 72,
      name: "Lieferadresse",
      parent_id: 71,
      type: "delivery",
      customer_rank: 0,
      street: "Rampe 1",
      zip: "9000",
      city: "St. Gallen",
      country_code: "CH",
    }),
  ]

  it("plant beim zweiten Lauf nichts mehr an", () => {
    const ersterLauf = planCustomerImport(rows)
    expect(ersterLauf.create).toHaveLength(2)

    const zweiterLauf = planCustomerImport(rows, {
      existingEmails: ersterLauf.create.map((c) => c.email),
    })

    expect(zweiterLauf.create).toHaveLength(0)
    expect(zweiterLauf.existing).toHaveLength(2)
    expect(zweiterLauf.stats.to_create).toBe(0)
    expect(zweiterLauf.stats.already_in_medusa).toBe(2)
  })

  it("erkennt bestehende Kunden auch bei abweichender Schreibweise", () => {
    const zweiterLauf = planCustomerImport(rows, {
      existingEmails: ["  LORENZ@Beispiel.example ", "INFO@KIOSK.example"],
    })

    expect(zweiterLauf.create).toHaveLength(0)
  })

  it("liefert bei gleichem Input zweimal dasselbe Ergebnis", () => {
    expect(planCustomerImport(rows)).toEqual(planCustomerImport(rows))
  })
})

describe("Metadaten", () => {
  it("hinterlegt die Odoo-Herkunft und den Merkposten fürs fehlende Passwort", () => {
    const p = partner({
      id: 80,
      name: "Mira Bosshard",
      email: "mira@beispiel.example",
      vat: "CHE-123.456.789",
      lang: "de_CH",
      pricelist: "B2B Schweiz",
      pricelist_id: 3,
      commercial_partner_id: 80,
      ref: "K-0080",
    })

    const kunde = planCustomerImport([p]).create[0]

    expect(kunde.metadata).toEqual({
      source: "odoo",
      odoo_partner_id: 80,
      odoo_partner_ids: "80",
      odoo_commercial_partner_id: 80,
      odoo_pricelist: "B2B Schweiz",
      odoo_vat: "CHE-123.456.789",
      odoo_lang: "de-CH",
      odoo_ref: "K-0080",
      imported_without_account: true,
    })
  })
})
