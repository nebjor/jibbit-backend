/**
 * Betragsumrechnung des OFFIZIELLEN zahls.ch-Plugins (@zahls/medusa-plugin),
 * ausgeführt gegen die in DIESEM Projekt installierten Medusa-Pakete
 * (2.13.6) — nicht gegen die 2.18.0, gegen die das Plugin gebaut wurde.
 *
 * Warum das hier steht: Medusa v2 rechnet in Dezimalbeträgen (CHF 3.75 ist
 * die Zahl 3.75), die zahls.ch/Payrexx-API in der kleinsten Währungseinheit
 * (CHF 3.75 sind 375 Rappen). Ein Fehler um Faktor 100 ist der Totalschaden:
 * hundertfache Belastung oder 99 % Rabatt. Diese Tests nageln die
 * Umrechnung des Plugins auf 2.13.6 fest.
 *
 * Die Testfälle laufen bewusst gegen den KOMPILIERTEN Plugin-Code aus
 * node_modules (das Paket liefert nur .medusa/server-Build aus, keinen
 * TS-Quelltext) — bricht ein Plugin-Update die Umrechnung, wird es hier rot.
 */

import { dirname, join } from "node:path"

const pluginDir = dirname(require.resolve("@zahls/medusa-plugin/package.json"))

// Absoluter Datei-Require, weil die "exports"-Map des Pakets nur den
// Provider-Index freigibt; utils.js ist darüber nicht adressierbar. Ein
// Require per absolutem Pfad umgeht die exports-Map (die gilt nur für bare
// specifiers) — genau dafür ist dieser Test da: das echte Artefakt prüfen.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require(
  join(pluginDir, ".medusa", "server", "src", "providers", "zahls", "utils.js")
) as {
  toMinorUnits: (amount: unknown, currencyCode: string) => number
  fromMinorUnits: (amount: number, currencyCode: string) => { numeric: number }
}

describe("zahls-Plugin: Dezimalbetrag → Rappen (toMinorUnits)", () => {
  it("CHF 3.75 wird zu 375 — nicht 374", () => {
    // 3.75 * 100 ist in IEEE-754 375.00000000000006; ein naives
    // parseInt/floor ergäbe 374 oder 375.00000000000006.
    expect(utils.toMinorUnits(3.75, "chf")).toBe(375)
  })

  it("CHF 19.99 wird zu 1999 (Fliesskomma-Rest 1998.9999…)", () => {
    expect(utils.toMinorUnits(19.99, "chf")).toBe(1999)
  })

  it("Rappengenaue Beträge: 0.05 → 5, 0.01 → 1", () => {
    expect(utils.toMinorUnits(0.05, "chf")).toBe(5)
    expect(utils.toMinorUnits(0.01, "chf")).toBe(1)
  })

  it("ganze Franken: 27 → 2700, 100 → 10000", () => {
    expect(utils.toMinorUnits(27, "chf")).toBe(2700)
    expect(utils.toMinorUnits(100, "chf")).toBe(10000)
  })

  it("nimmt auch String-Beträge an (Medusa BigNumberInput)", () => {
    expect(utils.toMinorUnits("3.75", "chf")).toBe(375)
    expect(utils.toMinorUnits("19.99", "CHF")).toBe(1999)
  })

  it("nimmt rohe BigNumber-Objekte an ({ value, precision })", () => {
    // Medusa reicht Beträge zur Laufzeit in vier Gestalten durch; die rohe
    // Objektform ist die, an der ein blankes Number(amount) zu NaN würde.
    expect(utils.toMinorUnits({ value: "3.75", precision: 20 }, "chf")).toBe(375)
  })

  it("Gross-/Kleinschreibung der Währung ist egal", () => {
    expect(utils.toMinorUnits(3.75, "CHF")).toBe(375)
    expect(utils.toMinorUnits(3.75, "chf")).toBe(375)
  })

  it("liefert immer eine ganze Zahl", () => {
    for (const amount of [3.75, 19.99, 0.05, 42, 1234.56, 0.1 + 0.2]) {
      const rappen = utils.toMinorUnits(amount, "chf")
      expect(Number.isInteger(rappen)).toBe(true)
    }
  })
})

describe("zahls-Plugin: Rappen → Dezimalbetrag (fromMinorUnits)", () => {
  it("375 Rappen werden zu CHF 3.75", () => {
    expect(utils.fromMinorUnits(375, "chf").numeric).toBe(3.75)
  })

  it("1999 Rappen werden zu CHF 19.99", () => {
    expect(utils.fromMinorUnits(1999, "chf").numeric).toBe(19.99)
  })

  it("Rundreise Dezimal → Rappen → Dezimal ist verlustfrei", () => {
    for (const amount of [3.75, 19.99, 0.05, 27, 100, 1234.56]) {
      const rappen = utils.toMinorUnits(amount, "chf")
      expect(utils.fromMinorUnits(rappen, "chf").numeric).toBe(amount)
    }
  })
})
