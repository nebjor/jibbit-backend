/**
 * Argumente für `medusa exec`-Scripte.
 *
 * ACHTUNG — die naheliegende Syntax funktioniert NICHT:
 *
 *     npx medusa exec ./src/scripts/foo.ts datei.json --dry-run
 *     → error: Unknown arguments: dry-run, dryRun
 *
 * Die CLI registriert den Befehl als `exec [file] [args..]`
 * (@medusajs/cli/dist/create-cli.js:497) und ruft danach `.strict()` auf
 * (ebenda:584). yargs lehnt damit jede Option ab, die es nicht selbst kennt —
 * und `--dry-run` kennt es nicht. Nur die variadische Positional-Liste
 * `[args..]` landet in `ExecArgs.args`.
 *
 * Ein `--` als Trenner hilft auch nicht: alles danach schiebt yargs nach
 * `argv._`, nicht nach `args`.
 *
 * Deshalb Argumente ohne Bindestrich-Präfix übergeben:
 *
 *     npx medusa exec ./src/scripts/foo.ts datei.json round=0.05
 *
 * Ein führendes `--` wird hier trotzdem toleriert, falls es die CLI eines
 * Tages durchreicht.
 *
 * ─── PROBELAUF IST DER NORMALFALL ───────────────────────────────────────
 *
 * Jedes Script, das in die Datenbank schreibt, läuft OHNE Modus-Argument als
 * Probelauf. Geschrieben wird nur mit dem ausdrücklichen Wort `schreiben`:
 *
 *     npx medusa exec ./src/scripts/foo.ts schreiben datei.json round=0.05
 *
 * Früher war es umgekehrt (`dry-run` als letztes Wort schaltete das Schreiben
 * ab). Dann hat ein Terminal einen langen Befehl beim Einfügen umbrochen, die
 * Shell führte die erste Zeile allein aus — ohne das `dry-run` am Ende — und
 * update-catalog.ts schrieb scharf. Ein Schutz, der am LETZTEN Wort einer
 * langen Zeile hängt, ist keiner. Deshalb:
 *
 *   - `schreiben` steht in jeder Anleitung ZUERST, gleich nach dem
 *     Script-Pfad; angenommen wird es an jeder Stelle. Ein abgeschnittener
 *     Befehl verliert so höchstens Optionen, nie den Probelauf.
 *   - `dry-run` bleibt als ausdrückliches «nichts schreiben» erlaubt, damit
 *     alte Gewohnheiten und Notizen nicht brechen.
 *   - Unbekannte Argumente brechen ab, bevor irgendetwas gelesen oder
 *     geschrieben wird (resolveRunMode) — ein Tippfehler darf nie still das
 *     Verhalten ändern.
 */

/** Das eine Wort, das Schreiben freischaltet. */
export const ARG_SCHREIBEN = "schreiben"
/** Ausdrücklicher Probelauf — harmlos, weil ohnehin der Normalfall. */
export const ARG_DRY_RUN = "dry-run"

export interface ScriptArgs {
  /** `round=0.05` -> value("round") === "0.05" */
  value(name: string): string | undefined
  /** `dry-run` -> flag("dry-run") === true */
  flag(name: string): boolean
  /** Erster Rest-Wert mit dieser Endung, z.B. der Pfad zur JSON-Datei. */
  file(extension: string): string | undefined
  /** Alle Werte ohne `=`, in der übergebenen Reihenfolge. */
  rest: string[]
  /** Namen aller `key=value`-Argumente, in der übergebenen Reihenfolge. */
  keys: string[]
}

export function parseScriptArgs(args: string[] = []): ScriptArgs {
  const values = new Map<string, string>()
  const rest: string[] = []
  const keys: string[] = []

  for (const raw of args) {
    const token = raw.startsWith("--") ? raw.slice(2) : raw
    const eq = token.indexOf("=")
    if (eq > 0) {
      keys.push(token.slice(0, eq))
      values.set(token.slice(0, eq), token.slice(eq + 1))
      continue
    }
    rest.push(token)
  }

  return {
    value: (name) => values.get(name),
    flag: (name) => rest.includes(name),
    file: (extension) => rest.find((r) => r.endsWith(extension)),
    rest,
    keys,
  }
}

/** Was ein Script an Argumenten kennt — alles andere bricht den Lauf ab. */
export type ScriptArgSpec = {
  /** Namen der erlaubten `key=value`-Argumente, z.B. ["extra", "round"] */
  values?: string[]
  /** Erlaubte blanke Wörter neben `schreiben` und `dry-run` */
  flags?: string[]
  /** Endung des EINEN Positions-Pfads, z.B. ".json". Ohne: kein Pfad erlaubt. */
  file?: string
}

/**
 * Argumente gegen die Liste des Scripts prüfen — reine Funktion, liefert die
 * Fehlertexte. Geprüft wird streng, weil jedes still ignorierte Argument das
 * Verhalten ändert: ein vertipptes `extr=…` liesse den Zusatzkatalog weg, ein
 * zweiter Pfad ohne `extra=` davor würde nie gelesen.
 */
export function checkScriptArgs(opts: ScriptArgs, spec: ScriptArgSpec): string[] {
  const errors: string[] = []
  const knownValues = spec.values ?? []
  const knownFlags = [ARG_SCHREIBEN, ARG_DRY_RUN, ...(spec.flags ?? [])]

  const seen = new Set<string>()
  for (const key of opts.keys) {
    if (!knownValues.includes(key)) {
      errors.push(`Unbekanntes Argument «${key}=…»`)
    } else if (seen.has(key)) {
      errors.push(`Argument «${key}=» steht mehrfach da`)
    } else if (opts.value(key) === "") {
      errors.push(`Argument «${key}=» hat keinen Wert`)
    }
    seen.add(key)
  }

  let files = 0
  for (const word of opts.rest) {
    if (knownFlags.includes(word)) {
      continue
    }
    if (spec.file && word.endsWith(spec.file)) {
      files += 1
      if (files === 2) {
        errors.push(
          `Mehr als ein ${spec.file}-Pfad ohne «name=» davor — ` +
            `der zweite («${word}») würde nie gelesen`
        )
      }
      continue
    }
    errors.push(`Unbekanntes Argument «${word}»`)
  }

  if (opts.flag(ARG_SCHREIBEN) && opts.flag(ARG_DRY_RUN)) {
    errors.push(
      `«${ARG_SCHREIBEN}» und «${ARG_DRY_RUN}» widersprechen sich — eines weglassen`
    )
  }

  return errors
}

type ModeLogger = {
  info: (message: string) => void
  error: (message: string) => void
}

/**
 * Argumente prüfen und den Modus als ERSTE Zeile laut ausgeben. Liefert
 * `null`, wenn der Lauf abbrechen muss — der Aufrufer kehrt dann sofort
 * zurück, bevor er eine Datei liest oder die Datenbank fragt.
 */
export function resolveRunMode(
  opts: ScriptArgs,
  spec: ScriptArgSpec,
  logger: ModeLogger
): { dryRun: boolean } | null {
  const errors = checkScriptArgs(opts, spec)
  if (errors.length) {
    logger.error("ABBRUCH — Argumente nicht verstanden, nichts wurde geändert:")
    errors.forEach((e) => logger.error(`  ${e}`))
    const erlaubt = [
      ARG_SCHREIBEN,
      ARG_DRY_RUN,
      ...(spec.flags ?? []),
      ...(spec.values ?? []).map((v) => `${v}=…`),
      ...(spec.file ? [`<pfad>${spec.file}`] : []),
    ]
    logger.error(`  Erlaubt sind: ${erlaubt.join("  ")}`)
    return null
  }

  const dryRun = !opts.flag(ARG_SCHREIBEN)
  logger.info(
    dryRun
      ? `MODUS: PROBELAUF — es wird nichts geschrieben ` +
          `(zum Schreiben: Argument "${ARG_SCHREIBEN}")`
      : "MODUS: SCHREIBEN"
  )
  return { dryRun }
}

/**
 * Schlusszeile eines Probelaufs: wie man genau diesen Lauf anwendet. Die
 * Argumente werden wiederholt, `schreiben` steht vorn — dort, wo es beim
 * Abschneiden der Zeile nicht verloren geht.
 */
export function applyHint(args: string[] = []): string {
  const others = args
    .map((a) => (a.startsWith("--") ? a.slice(2) : a))
    .filter((a) => a !== ARG_DRY_RUN && a !== ARG_SCHREIBEN)
  return (
    `Zum Anwenden denselben Befehl mit "${ARG_SCHREIBEN}" als erstem ` +
    `Argument nach dem Script-Pfad: ${[ARG_SCHREIBEN, ...others].join(" ")}`
  )
}
