/**
 * «Bestellung endgültig löschen» (src/lib/bestellung-loeschen.ts).
 *
 * Geprüft wird die Entscheidung — welche Schritte für welchen Bestellzustand
 * gelten — und die Abbildung der Rohdaten. Nicht geprüft: Medusas eigene
 * Workflows (Lieferung stornieren, Rückerstattung); die laufen nur gegen eine
 * echte Datenbank. Alle Daten sind erfunden.
 */

import { asValue } from "@medusajs/framework/awilix"
import { createMedusaContainer, Modules } from "@medusajs/framework/utils"

import { PostBestellungLoeschenSchema } from "../api/admin/orders/[id]/loeschen/validators"
import {
  type BestellLage,
  entscheideBestellungLoeschen,
  type LoeschOptionen,
} from "../lib/bestellung-loeschen"
import {
  bestellLageAusRohdaten,
  loescheBestellungWeich,
  stelleBestellungWiederHer,
} from "../lib/bestellung-loeschen-daten"

const OPT: LoeschOptionen = { bestaetigung: "4", zahlung_erstatten: false, ware_zurueck_ins_lager: false }

const lieferung = (id: string, o: Partial<BestellLage["lieferungen"][number]> = {}) => ({
  id,
  location_id: "sloc_1" as string | null,
  canceled_at: null,
  shipped_at: null,
  items: [{ line_item_id: "li_1", inventory_item_id: "iitem_1" as string | null, quantity: 2 }],
  ...o,
})

const lage = (o: Partial<BestellLage> = {}): BestellLage => ({
  id: "order_4",
  display_id: 4,
  status: "pending",
  line_item_ids: ["li_1"],
  lieferungen: [],
  zahlungen: [],
  ...o,
})

const plan = (l: BestellLage, o: Partial<LoeschOptionen> = {}) => {
  const e = entscheideBestellungLoeschen(l, { ...OPT, ...o })
  if (!e.ok) throw new Error(e.fehler)
  return e.plan
}

describe("Bestätigung", () => {
  it("verweigert, wenn die Nummer nicht stimmt", () => {
    const e = entscheideBestellungLoeschen(lage(), { ...OPT, bestaetigung: "5" })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.fehler).toContain("Bestellnummer 4")
  })
  it("verweigert bei leerer Eingabe", () => {
    expect(entscheideBestellungLoeschen(lage(), { ...OPT, bestaetigung: "" }).ok).toBe(false)
  })
  it("akzeptiert Leerzeichen und führendes #", () => {
    expect(entscheideBestellungLoeschen(lage(), { ...OPT, bestaetigung: " #4 " }).ok).toBe(true)
  })
})

describe("Lieferungen", () => {
  it("storniert nicht versandte Lieferungen, lässt versandte stehen", () => {
    const p = plan(
      lage({
        lieferungen: [
          lieferung("ful_offen"),
          lieferung("ful_versandt", { shipped_at: "2026-10-29T10:00:00Z" }),
          lieferung("ful_alt", { canceled_at: "2026-10-28T10:00:00Z" } as never),
        ],
      })
    )
    expect(p.lieferungen_stornieren).toEqual(["ful_offen"])
    expect(p.lieferungen_versandt).toEqual(["ful_versandt"])
  })
  it("storniert bei bereits stornierter Bestellung keine Lieferung mehr", () => {
    const p = plan(lage({ status: "canceled", lieferungen: [lieferung("ful_offen")] }))
    expect(p.lieferungen_stornieren).toEqual([])
  })
})

describe("Lager", () => {
  const versandt = lage({
    lieferungen: [lieferung("ful_1", { shipped_at: "2026-10-29T10:00:00Z" })],
  })
  it("bucht versandte Ware nur mit Häkchen zurück", () => {
    expect(plan(versandt).lager_zurueckbuchen).toEqual([])
    expect(plan(versandt, { ware_zurueck_ins_lager: true }).lager_zurueckbuchen).toEqual([
      { inventory_item_id: "iitem_1", location_id: "sloc_1", menge: 2 },
    ])
  })
  it("fasst gleiche Artikel im gleichen Lager zusammen", () => {
    const l = lage({
      lieferungen: [
        lieferung("ful_1", { shipped_at: "x" }),
        lieferung("ful_2", { shipped_at: "x" }),
      ],
    })
    expect(plan(l, { ware_zurueck_ins_lager: true }).lager_zurueckbuchen).toEqual([
      { inventory_item_id: "iitem_1", location_id: "sloc_1", menge: 4 },
    ])
  })
  it("überspringt Artikel ohne Bestandsführung und ohne Lagerort", () => {
    const l = lage({
      lieferungen: [
        lieferung("ful_1", {
          shipped_at: "x",
          items: [{ line_item_id: "li_1", inventory_item_id: null, quantity: 1 }],
        }),
        lieferung("ful_2", { shipped_at: "x", location_id: null }),
      ],
    })
    expect(plan(l, { ware_zurueck_ins_lager: true }).lager_zurueckbuchen).toEqual([])
  })
  it("bucht nie Ware aus nicht versandten Lieferungen zurück (das macht Medusa beim Stornieren)", () => {
    const l = lage({ lieferungen: [lieferung("ful_offen")] })
    expect(plan(l, { ware_zurueck_ins_lager: true }).lager_zurueckbuchen).toEqual([])
  })
  it("weist auf nicht zurückgebuchte versandte Ware hin", () => {
    expect(plan(versandt).hinweise.join(" ")).toContain("nicht ins Lager")
  })
})

describe("Zahlungen", () => {
  const bezahlt = lage({
    zahlungen: [{ id: "pay_1", erfasst: 12.5, erstattet: 2.5, currency_code: "chf" }],
  })
  it("erstattet ohne Häkchen nichts und meldet den Betrag als beim Shop verbleibend", () => {
    const p = plan(bezahlt)
    expect(p.erstattungen).toEqual([])
    expect(p.erstattung_betrag).toBe(0)
    expect(p.nicht_erstattet_betrag).toBe(10)
    expect(p.hinweise.join(" ")).toContain("nicht zurückerstattet")
  })
  it("erstattet mit Häkchen nur den Rest", () => {
    const p = plan(bezahlt, { zahlung_erstatten: true })
    expect(p.erstattungen).toEqual([{ payment_id: "pay_1", amount: 10 }])
    expect(p.erstattung_betrag).toBe(10)
    expect(p.nicht_erstattet_betrag).toBe(0)
    expect(p.currency_code).toBe("chf")
  })
  it("erstattet nichts bei bereits voll erstatteter Zahlung", () => {
    const l = lage({ zahlungen: [{ id: "p", erfasst: 5, erstattet: 5, currency_code: "chf" }] })
    expect(plan(l, { zahlung_erstatten: true }).erstattungen).toEqual([])
  })
  it("bricht nicht erfasste Zahlungen ab, ohne sie zu erstatten", () => {
    const l = lage({ zahlungen: [{ id: "pay_x", erfasst: 0, erstattet: 0, currency_code: "chf" }] })
    const p = plan(l, { zahlung_erstatten: true })
    expect(p.zahlungen_abbrechen).toEqual(["pay_x"])
    expect(p.erstattungen).toEqual([])
  })
  it("rundet Gleitkomma-Reste auf Rappen", () => {
    const l = lage({ zahlungen: [{ id: "p", erfasst: 0.3, erstattet: 0.1, currency_code: "chf" }] })
    expect(plan(l, { zahlung_erstatten: true }).erstattung_betrag).toBe(0.2)
  })
})

describe("Rohdaten", () => {
  it("bildet BigNumber-Beträge, Texte und Lücken ab", () => {
    const l = bestellLageAusRohdaten({
      id: "order_1",
      display_id: 1,
      status: "pending",
      items: [{ id: "li_1" }],
      fulfillments: [
        {
          id: "ful_1",
          shipped_at: "x",
          items: [{ line_item_id: "li_1", inventory_item_id: "iitem_1", quantity: { value: "3" } }],
        },
      ],
      payment_collections: [
        {
          currency_code: "chf",
          payments: [
            { id: "pay_1", captures: [{ amount: { value: "7.5" } }, { amount: "2.5" }], refunds: null },
          ],
        },
      ],
    })
    expect(l.lieferungen[0].items[0].quantity).toBe(3)
    expect(l.lieferungen[0].location_id).toBeNull()
    expect(l.zahlungen).toEqual([{ id: "pay_1", erfasst: 10, erstattet: 0, currency_code: "chf" }])
  })
  it("verträgt eine Bestellung ohne alles", () => {
    const l = bestellLageAusRohdaten({ id: "o", display_id: 9, status: "pending" })
    expect(l.lieferungen).toEqual([])
    expect(l.zahlungen).toEqual([])
    expect(l.line_item_ids).toEqual([])
  })
})

describe("Validator", () => {
  it("setzt sichere Vorgaben: nichts erstatten, nichts zurückbuchen, keine Vorschau", () => {
    expect(PostBestellungLoeschenSchema.parse({ bestaetigung: "4" })).toEqual({
      bestaetigung: "4",
      zahlung_erstatten: false,
      ware_zurueck_ins_lager: false,
      vorschau: false,
    })
  })
  it("verlangt die Bestätigung als Text", () => {
    expect(PostBestellungLoeschenSchema.safeParse({}).success).toBe(false)
    expect(PostBestellungLoeschenSchema.safeParse({ bestaetigung: 4 }).success).toBe(false)
  })
  it("verlangt echte Booleans", () => {
    expect(
      PostBestellungLoeschenSchema.safeParse({ bestaetigung: "4", zahlung_erstatten: "ja" }).success
    ).toBe(false)
  })
})

describe("Weiches Löschen", () => {
  it("löscht und stellt über das Bestellmodul wieder her", async () => {
    const aufrufe: string[] = []
    const container = createMedusaContainer()
    container.register(
      Modules.ORDER,
      asValue({
        softDeleteOrders: async (ids: string[]) => void aufrufe.push(`weg:${ids}`),
        restoreOrders: async (ids: string[]) => void aufrufe.push(`zurueck:${ids}`),
      })
    )
    await loescheBestellungWeich(container, "order_4")
    await stelleBestellungWiederHer(container, "order_4")
    expect(aufrufe).toEqual(["weg:order_4", "zurueck:order_4"])
  })
})
