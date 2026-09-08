/**
 * Setzt das jibbit-Blatt als Favicon des Medusa-Admins.
 *
 * ─── WARUM ES DIESES SKRIPT BRAUCHT ────────────────────────────────────────
 *
 * Medusa 2.13.6 bietet KEINE Einstellung dafuer. Der Admin-Bundler schreibt
 * die HTML-Datei aus einer fest verdrahteten Vorlage
 * (@medusajs/admin-bundler/dist/index.js, writeHTMLFile) und setzt dort:
 *
 *     <link rel="icon" href="data:," data-placeholder-favicon />
 *
 * `data:,` ist eine leere Datenadresse — der Browser zeigt daraufhin sein
 * Standardsymbol, die Weltkugel. Im gesamten Bundler ist das die einzige
 * Erwaehnung von "favicon"; es gibt nichts zu konfigurieren.
 *
 * Deshalb wird die fertig gebaute Datei hier nachtraeglich angefasst. Das
 * laeuft als Teil von `npm run build` und damit auch im Docker-Bau.
 *
 * ─── WARUM ES LAUT SCHEITERT ───────────────────────────────────────────────
 *
 * Findet das Skript den Platzhalter nicht mehr, BRICHT es ab, statt still
 * weiterzulaufen. Sonst verschwaende das Favicon bei einem Medusa-Upgrade
 * unbemerkt wieder, und niemand wuesste warum. Ein lauter Fehler im Bau ist
 * die guenstigere Variante.
 */

import { copyFile, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HIER = dirname(fileURLToPath(import.meta.url))
const WURZEL = resolve(HIER, "..")
const ICON = join(WURZEL, "assets", "admin-favicon.png")

/** Die Zeile, die Medusas Bundler erzeugt. */
const PLATZHALTER = /<link rel="icon" href="data:," data-placeholder-favicon\s*\/?>/

/** Sucht die gebaute index.html des Admins unterhalb von .medusa. */
async function findeAdminHtml(start) {
  const stapel = [start]
  while (stapel.length) {
    const dir = stapel.pop()
    let eintraege
    try {
      eintraege = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of eintraege) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        // node_modules im Bauverzeichnis ist gross und enthaelt nichts fuer uns.
        if (e.name !== "node_modules") stapel.push(p)
      } else if (e.name === "index.html" && p.includes("admin")) {
        return p
      }
    }
  }
  return null
}

const medusaDir = join(WURZEL, ".medusa")
if (!existsSync(medusaDir)) {
  console.error("[admin-favicon] .medusa fehlt — lief `medusa build` vorher?")
  process.exit(1)
}

const html = await findeAdminHtml(medusaDir)
if (!html) {
  console.error("[admin-favicon] Keine gebaute Admin-index.html unter .medusa gefunden.")
  process.exit(1)
}

const inhalt = await readFile(html, "utf8")
if (!PLATZHALTER.test(inhalt)) {
  if (inhalt.includes("admin-favicon.png")) {
    console.log("[admin-favicon] Bereits gesetzt — nichts zu tun.")
    process.exit(0)
  }
  console.error(
    "[admin-favicon] Der Platzhalter von Medusa steht nicht mehr in " +
      html +
      ". Wahrscheinlich hat ein Medusa-Upgrade die Vorlage geaendert. " +
      "Bitte writeHTMLFile in @medusajs/admin-bundler nachsehen und dieses " +
      "Skript anpassen — sonst faellt das Favicon still weg."
  )
  process.exit(1)
}

await copyFile(ICON, join(dirname(html), "admin-favicon.png"))
await writeFile(
  html,
  inhalt.replace(PLATZHALTER, '<link rel="icon" type="image/png" href="./admin-favicon.png" />'),
  "utf8"
)
console.log("[admin-favicon] Favicon gesetzt in " + html)
