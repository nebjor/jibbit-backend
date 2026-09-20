/**
 * script-args.ts — Probelauf ist der Normalfall, `schreiben` schaltet scharf,
 * und ein unbekanntes Argument bricht ab, statt still das Verhalten zu ändern.
 *
 * Hintergrund: ein beim Einfügen umbrochener Einzeiler verlor das `dry-run`
 * am Zeilenende, und update-catalog.ts schrieb scharf.
 */

import {
  applyHint,
  checkScriptArgs,
  parseScriptArgs,
  resolveRunMode,
} from "../scripts/script-args"

const SPEC = {
  values: ["extra", "round"],
  flags: ["invite"],
  file: ".json",
}

const makeLogger = () => ({ info: jest.fn(), error: jest.fn() })

describe("parseScriptArgs", () => {
  it("trennt key=value von blanken Wörtern und merkt sich die Schlüssel", () => {
    const opts = parseScriptArgs(["a.json", "extra=b.json", "schreiben"])
    expect(opts.rest).toEqual(["a.json", "schreiben"])
    expect(opts.keys).toEqual(["extra"])
    expect(opts.value("extra")).toBe("b.json")
    expect(opts.file(".json")).toBe("a.json")
  })
})

describe("checkScriptArgs", () => {
  const check = (...args: string[]) => checkScriptArgs(parseScriptArgs(args), SPEC)

  it("lässt Bekanntes durch — in jeder Reihenfolge", () => {
    expect(check("a.json", "extra=b.json", "round=0.05")).toEqual([])
    expect(check("schreiben", "a.json", "invite")).toEqual([])
    expect(check("a.json", "dry-run")).toEqual([])
    expect(check()).toEqual([])
  })

  it("meldet Tippfehler bei Wörtern und bei key=value", () => {
    expect(check("a.json", "dryrun")).toEqual(["Unbekanntes Argument «dryrun»"])
    expect(check("a.json", "Schreiben")).toHaveLength(1)
    expect(check("a.json", "extr=b.json")).toEqual([
      "Unbekanntes Argument «extr=…»",
    ])
  })

  it("meldet einen zweiten Pfad ohne name= — er würde nie gelesen", () => {
    expect(check("a.json", "b.json")[0]).toContain("b.json")
  })

  it("meldet leere und doppelte key=value", () => {
    expect(check("a.json", "extra=")[0]).toContain("keinen Wert")
    expect(check("a.json", "extra=b.json", "extra=c.json")[0]).toContain(
      "mehrfach"
    )
  })

  it("meldet den Widerspruch schreiben + dry-run", () => {
    expect(check("schreiben", "a.json", "dry-run")[0]).toContain(
      "widersprechen"
    )
  })

  it("ohne file-Endung in der Liste ist auch ein Pfad unbekannt", () => {
    expect(checkScriptArgs(parseScriptArgs(["a.json"]), {})).toHaveLength(1)
  })
})

describe("resolveRunMode", () => {
  it("ohne Modus-Argument: Probelauf, laut als erste Zeile", () => {
    const logger = makeLogger()
    const mode = resolveRunMode(parseScriptArgs(["a.json"]), SPEC, logger)
    expect(mode).toEqual({ dryRun: true })
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][0]).toBe(
      'MODUS: PROBELAUF — es wird nichts geschrieben (zum Schreiben: Argument "schreiben")'
    )
  })

  it("`dry-run` bleibt ein Probelauf", () => {
    const mode = resolveRunMode(
      parseScriptArgs(["a.json", "dry-run"]),
      SPEC,
      makeLogger()
    )
    expect(mode).toEqual({ dryRun: true })
  })

  it("`schreiben` schaltet scharf — vorn wie hinten, auch mit -- davor", () => {
    for (const args of [
      ["schreiben", "a.json"],
      ["a.json", "schreiben"],
      ["--schreiben", "a.json"],
    ]) {
      const logger = makeLogger()
      expect(resolveRunMode(parseScriptArgs(args), SPEC, logger)).toEqual({
        dryRun: false,
      })
      expect(logger.info.mock.calls[0][0]).toBe("MODUS: SCHREIBEN")
    }
  })

  it("ein unbekanntes Argument liefert null — auch wenn `schreiben` dasteht", () => {
    const logger = makeLogger()
    const mode = resolveRunMode(
      parseScriptArgs(["schreiben", "a.json", "dryrun"]),
      SPEC,
      logger
    )
    expect(mode).toBeNull()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.error.mock.calls[0][0]).toMatch(/^ABBRUCH/)
    expect(logger.error.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "«dryrun»"
    )
  })
})

describe("applyHint", () => {
  it("stellt `schreiben` nach vorn und lässt dry-run weg", () => {
    expect(applyHint(["a.json", "extra=b.json", "dry-run"])).toContain(
      ": schreiben a.json extra=b.json"
    )
    expect(applyHint([])).toMatch(/: schreiben$/)
  })
})
