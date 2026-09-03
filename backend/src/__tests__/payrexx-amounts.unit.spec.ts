/**
 * Betragsumrechnung Medusa <-> Payrexx.
 *
 * Der Fehler, den diese Datei verhindern soll, ist der teuerste im ganzen
 * Modul: ein Faktor 100 in die falsche Richtung belastet den Kunden mit dem
 * Hundertfachen oder verschenkt 99 % des Umsatzes — und beides fällt in
 * einem Testshop mit runden Beträgen nicht zwingend auf.
 */

import { BigNumber } from "@medusajs/framework/utils"
import {
  toRappen,
  fromRappen,
  isPlausibleRappenAmount,
  RAPPEN_PER_CHF,
} from "../modules/zahls/amounts"

describe("toRappen — Dezimal-CHF (Medusa) → Rappen (Payrexx)", () => {
  it("uses a factor of 100, not 1 and not 10000", () => {
    expect(RAPPEN_PER_CHF).toBe(100)
    expect(toRappen(1)).toBe(100)
    expect(toRappen(42)).toBe(4200)
  })

  it("converts a realistic jibbit basket (CHF 27.90) to 2790 Rappen", () => {
    expect(toRappen(27.9)).toBe(2790)
  })

  /**
   * CHF 3.75 ist der erste Betrag im System mit einem Rappen-Anteil, der kein
   * ganzer Franken ist — vorher gab es nur den Pauschalversand zu CHF 9.00.
   * Geht hier ein Rappen verloren (374 statt 375), ist jede Kleinsendung
   * falsch belastet, und der Betrags-Abgleich im Webhook wertet die Differenz
   * als Manipulationsverdacht.
   */
  it("converts the letter shipping rate (CHF 3.75) to 375 Rappen", () => {
    expect(toRappen(3.75)).toBe(375)
    expect(toRappen("3.75")).toBe(375)
    expect(fromRappen(375)).toBe(3.75)
  })

  it("keeps a cart with the letter rate exact to the Rappen", () => {
    // Warenkorb CHF 12.50 + Brief CHF 3.75 = CHF 16.25
    expect(toRappen(12.5 + 3.75)).toBe(1625)
    // und ein Betrag knapp unter der Gratis-Schwelle
    expect(toRappen(68.99 + 3.75)).toBe(7274)
  })

  it("survives the classic binary float traps", () => {
    expect(toRappen(0.1 + 0.2)).toBe(30)
    expect(toRappen(19.99)).toBe(1999)
    expect(toRappen(2.675)).toBe(268)
  })

  it("converts the Swiss flat shipping rate (CHF 9.00) to 900 Rappen", () => {
    expect(toRappen(9)).toBe(900)
  })

  it("does not leak binary floating point error (19.99 * 100 === 1998.9999...)", () => {
    expect(19.99 * 100).not.toBe(1999) // die Falle
    expect(toRappen(19.99)).toBe(1999) // das Ergebnis
  })

  it("accepts a BigNumber instance", () => {
    expect(toRappen(new BigNumber(12.35))).toBe(1235)
  })

  it("accepts a raw BigNumber value object — Number() would give NaN here", () => {
    // Genau diese Gestalt reicht Medusa an manchen Stellen durch. Ein
    // blankes Number({ value: "12.35" }) ist NaN, und Math.round(NaN) ist
    // NaN — das wäre als Betrag bei Payrexx gelandet.
    expect(Number({ value: "12.35" } as any)).toBeNaN()
    expect(toRappen({ value: "12.35" } as any)).toBe(1235)
  })

  it("accepts a decimal string", () => {
    expect(toRappen("12.35")).toBe(1235)
  })

  it("always returns an integer, never a fractional Rappen amount", () => {
    expect(Number.isInteger(toRappen(12.345))).toBe(true)
    expect(toRappen(12.345)).toBe(1235) // kaufmännisch gerundet
  })

  it("throws on values that cannot be a money amount", () => {
    expect(() => toRappen(undefined as any)).toThrow()
    expect(() => toRappen(null as any)).toThrow()
    expect(() => toRappen("not a number")).toThrow()
    expect(() => toRappen(Number.NaN)).toThrow()
  })
})

describe("fromRappen — Rappen (Payrexx) → Dezimal-CHF (Medusa)", () => {
  it("divides by 100", () => {
    expect(fromRappen(4200)).toBe(42)
    expect(fromRappen(2790)).toBe(27.9)
    expect(fromRappen(900)).toBe(9)
  })

  it("normalises to two decimals instead of a floating point tail", () => {
    expect(fromRappen(1999)).toBe(19.99)
    expect(String(fromRappen(1999))).toBe("19.99")
  })

  it("round-trips every Rappen amount in a realistic basket range", () => {
    for (let rappen = 1; rappen <= 20000; rappen += 7) {
      expect(toRappen(fromRappen(rappen))).toBe(rappen)
    }
  })

  it("throws on non-finite input", () => {
    expect(() => fromRappen(Number.NaN)).toThrow()
    expect(() => fromRappen(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe("isPlausibleRappenAmount", () => {
  it("accepts a positive integer", () => {
    expect(isPlausibleRappenAmount(4200)).toBe(true)
  })

  it("rejects zero and negative amounts", () => {
    expect(isPlausibleRappenAmount(0)).toBe(false)
    expect(isPlausibleRappenAmount(-500)).toBe(false)
  })

  it("rejects a fractional value — the classic sign of a missing *100", () => {
    // Wer CHF 42.50 versehentlich als Dezimalbetrag durchreicht, landet hier.
    expect(isPlausibleRappenAmount(42.5)).toBe(false)
  })

  it("rejects NaN, strings and undefined", () => {
    expect(isPlausibleRappenAmount(Number.NaN)).toBe(false)
    expect(isPlausibleRappenAmount("4200")).toBe(false)
    expect(isPlausibleRappenAmount(undefined)).toBe(false)
  })
})
