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
 *     npx medusa exec ./src/scripts/foo.ts datei.json dry-run round=0.05
 *
 * Ein führendes `--` wird hier trotzdem toleriert, falls es die CLI eines
 * Tages durchreicht.
 */

export interface ScriptArgs {
  /** `round=0.05` -> value("round") === "0.05" */
  value(name: string): string | undefined
  /** `dry-run` -> flag("dry-run") === true */
  flag(name: string): boolean
  /** Erster Rest-Wert mit dieser Endung, z.B. der Pfad zur JSON-Datei. */
  file(extension: string): string | undefined
  /** Alle Werte ohne `=`, in der übergebenen Reihenfolge. */
  rest: string[]
}

export function parseScriptArgs(args: string[] = []): ScriptArgs {
  const values = new Map<string, string>()
  const rest: string[] = []

  for (const raw of args) {
    const token = raw.startsWith("--") ? raw.slice(2) : raw
    const eq = token.indexOf("=")
    if (eq > 0) {
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
  }
}
