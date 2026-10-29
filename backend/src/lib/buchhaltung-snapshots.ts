/**
 * Stichtags-Schnappschüsse des Lagerbestands (JSON-Dateien).
 *
 * Warum Dateien und keine Datenbanktabelle: das Repo hat kein eigenes
 * Datenmodul mit Migrationen (nur Provider unter src/modules/). Ein neues
 * Modul samt Migration wäre für ein paar Dateien pro Jahr unverhältnismässig.
 *
 * Ablage: BUCHHALTUNG_DIR (docker-compose: /app/buchhaltung, eigenes Volume
 * «medusa_buchhaltung»), sonst <cwd>/buchhaltung. NICHT unter /app/static:
 * dieses Verzeichnis liefert Medusa öffentlich aus (Produktbilder) — die
 * Schnappschüsse enthalten Einstandspreise.
 * Dateien werden nie überschrieben oder gelöscht (Name enthält Zeitstempel,
 * Schreiben mit Flag «wx»).
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { LagerPosition, LagerSumme } from "./buchhaltung"

export const SNAPSHOT_VERSION = 1
const UNTERORDNER = "lagerbestand"
/** Erlaubte Snapshot-IDs (= Dateiname ohne .json); verhindert Pfadtricks. */
export const SNAPSHOT_ID = /^bestand-\d{4}-\d{2}-\d{2}-\d{6}$/

export type SnapshotPosition = Pick<
  LagerPosition,
  "variant_id" | "sku" | "gtin" | "produkt" | "variante" | "menge" | "einstandspreis" | "wert"
>

export type Snapshot = {
  version: number
  id: string
  /** Stichtag (Datum des Speicherns, Zürcher Zeit). */
  stichtag: string
  erstellt_am: string
  erstellt_von: string | null
  summe: LagerSumme
  positionen: SnapshotPosition[]
}

export type SnapshotMeta = Pick<Snapshot, "id" | "stichtag" | "erstellt_am" | "erstellt_von"> & {
  stueck: number
  wert: number
  ohne_einstandspreis: number
}

export function snapshotVerzeichnis(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.BUCHHALTUNG_DIR || join(process.cwd(), "buchhaltung"), UNTERORDNER)
}

/** ID aus Zeitpunkt (UTC) und Stichtag: bestand-2026-12-31-235959. */
export function snapshotId(stichtag: string, jetzt: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const zeit = `${p(jetzt.getUTCHours())}${p(jetzt.getUTCMinutes())}${p(jetzt.getUTCSeconds())}`
  return `bestand-${stichtag}-${zeit}`
}

export function baueSnapshot(
  stichtag: string,
  positionen: LagerPosition[],
  summe: LagerSumme,
  erstelltVon: string | null,
  jetzt: Date = new Date()
): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    id: snapshotId(stichtag, jetzt),
    stichtag,
    erstellt_am: jetzt.toISOString(),
    erstellt_von: erstelltVon,
    summe,
    positionen: positionen.map((p) => ({
      variant_id: p.variant_id,
      sku: p.sku,
      gtin: p.gtin,
      produkt: p.produkt,
      variante: p.variante,
      menge: p.menge,
      einstandspreis: p.einstandspreis,
      wert: p.wert,
    })),
  }
}

/** Schreibt den Schnappschuss (atomar über temporäre Datei, nie überschreibend). */
export async function speichereSnapshot(dir: string, snapshot: Snapshot): Promise<void> {
  if (!SNAPSHOT_ID.test(snapshot.id)) throw new Error("Ungültige Snapshot-ID")
  await mkdir(dir, { recursive: true })
  const ziel = join(dir, `${snapshot.id}.json`)
  const temp = join(dir, `.${snapshot.id}.tmp`)
  await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", flag: "wx" })
  try {
    // rename kennt kein «wx»; deshalb vorher prüfen, ob das Ziel schon existiert.
    let existiert = true
    try {
      await readFile(ziel)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      existiert = false
    }
    if (existiert) throw new Error("Schnappschuss existiert bereits")
    await rename(temp, ziel)
  } catch (e) {
    await rm(temp, { force: true }) // nur die eigene temporäre Datei
    throw e
  }
}

function meta(s: Snapshot): SnapshotMeta {
  return {
    id: s.id,
    stichtag: s.stichtag,
    erstellt_am: s.erstellt_am,
    erstellt_von: s.erstellt_von,
    stueck: s.summe?.stueck ?? 0,
    wert: s.summe?.wert ?? 0,
    ohne_einstandspreis: s.summe?.ohne_einstandspreis ?? 0,
  }
}

/** Liest einen Schnappschuss; null, wenn ID ungültig oder Datei fehlt/defekt. */
export async function ladeSnapshot(dir: string, id: string): Promise<Snapshot | null> {
  if (!SNAPSHOT_ID.test(id)) return null
  try {
    const s = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Snapshot
    return Array.isArray(s?.positionen) && s.id === id ? s : null
  } catch {
    return null
  }
}

/** Alle Schnappschüsse, neueste zuerst. Defekte Dateien werden übersprungen. */
export async function listeSnapshots(dir: string): Promise<SnapshotMeta[]> {
  let namen: string[]
  try {
    namen = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  const aus: SnapshotMeta[] = []
  for (const n of namen) {
    if (!n.endsWith(".json")) continue
    const s = await ladeSnapshot(dir, n.slice(0, -5))
    if (s) aus.push(meta(s))
  }
  return aus.sort((a, b) => b.erstellt_am.localeCompare(a.erstellt_am))
}
