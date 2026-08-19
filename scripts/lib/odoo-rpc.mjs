/**
 * Gemeinsamer Odoo-JSON-RPC-Zugang für die Export-Scripte.
 *
 * Warum hier und nicht in jedem Script neu: odoo-export.mjs (Produkte),
 * odoo-export-customers.mjs (res.partner) und odoo-export-orders.mjs
 * (sale.order) reden mit derselben Instanz, melden sich gleich an und müssen
 * beim Feldabgleich dieselbe Nachsicht walten lassen — Odoo 17 kennt nicht
 * jedes Feld, das eine ältere oder neuere Version kennt.
 *
 * Kein npm. Node 20+ (globales fetch) genügt.
 */

import { writeFile, mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"

/**
 * Zugangsdaten aus der Umgebung lesen.
 *
 * Der API-Key kommt aus Odoo unter: Profil → Konto-Sicherheit →
 * Neuer API-Schlüssel. Bei Odoo Online funktioniert das Passwort nicht.
 */
export function odooConfigFromEnv(env = process.env) {
  const url = (env.ODOO_URL ?? "").replace(/\/+$/, "")
  const db = env.ODOO_DB
  const user = env.ODOO_USER
  const key = env.ODOO_API_KEY ?? env.ODOO_PASSWORD

  if (!url || !db || !user || !key) {
    throw new Error(
      "Fehlende Konfiguration. Benötigt: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY"
    )
  }

  return { url, db, user, key }
}

/**
 * Odoo stellt unter /jsonrpc dieselben Dienste bereit wie über XML-RPC,
 * nur als reines JSON — damit brauchen wir keine XML-Bibliothek.
 */
export function createClient({ url, db, user, key }) {
  let rpcId = 0
  let uid = null

  async function rpc(service, method, args) {
    const res = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: ++rpcId,
      }),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} von ${url}/jsonrpc`)
    }

    const body = await res.json()

    if (body.error) {
      const d = body.error.data ?? {}
      throw new Error(`Odoo: ${d.message ?? body.error.message} (${d.name ?? "?"})`)
    }

    return body.result
  }

  async function login() {
    uid = await rpc("common", "login", [db, user, key])
    if (!uid) {
      throw new Error(
        "Login abgelehnt. Bei Odoo Online muss ein API-Schlüssel statt des Passworts verwendet werden."
      )
    }
    return uid
  }

  function kw(model, method, args = [], kwargs = {}) {
    return rpc("object", "execute_kw", [db, uid, key, model, method, args, kwargs])
  }

  /**
   * Nur Felder anfragen, die es in dieser Odoo-Version wirklich gibt.
   *
   * Ohne diesen Filter bricht ein search_read mit einem einzigen unbekannten
   * Feld komplett ab — und der Betreiber steht ohne Export da, statt mit einem
   * Export, dem eine Spalte fehlt.
   */
  async function existingFields(model, wanted) {
    const all = await kw(model, "fields_get", [[], ["type"]])
    const have = new Set(Object.keys(all))
    const missing = wanted.filter((f) => !have.has(f))
    if (missing.length) {
      console.warn(`  ! ${model}: Felder nicht vorhanden, übersprungen: ${missing.join(", ")}`)
    }
    return wanted.filter((f) => have.has(f))
  }

  return {
    rpc,
    login,
    kw,
    existingFields,
    get uid() {
      return uid
    },
  }
}

/** Odoo liefert many2one als [id, "Anzeigename"] — wir wollen meist nur die id. */
export const idOf = (v) => (Array.isArray(v) ? v[0] : v || null)

/** … und manchmal doch den Anzeigenamen. */
export const nameOf = (v) => (Array.isArray(v) ? v[1] : null)

export const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

export function toCsv(rows, fields, separator = ";") {
  const esc = (v) => {
    if (v === null || v === undefined || v === false) return ""
    const s = Array.isArray(v) ? `${v[0]}: ${v[1]}` : String(v)
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    fields.join(separator),
    ...rows.map((r) => fields.map((f) => esc(r[f])).join(separator)),
  ].join("\n")
}

/**
 * Ausgabedatei schreiben.
 *
 * `personal` markiert Dateien mit Personendaten: die bekommen 0600, damit sie
 * nicht versehentlich für andere Benutzer des Rechners lesbar sind. Das
 * ersetzt keine Verschlüsselung, senkt aber die Fallhöhe, wenn der Export auf
 * einem geteilten Server läuft.
 */
export async function writeOut(outDir, name, data, { personal = false } = {}) {
  await mkdir(outDir, { recursive: true })
  const path = join(outDir, name)
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2))
  if (personal) {
    await chmod(path, 0o600)
  }
  console.log(`  → ${path}${personal ? "  (Personendaten, 0600)" : ""}`)
  return path
}

/**
 * ISO-Ländercodes nachschlagen.
 *
 * `country_id` kommt als [17, "Switzerland"] — Medusa will "ch". Der Name
 * hilft dabei nicht (Odoo liefert ihn in der Sprache des API-Benutzers),
 * deshalb wird res.country einmal gelesen und als id → Code gemappt.
 */
export async function loadCountryCodes(client) {
  const rows = await client.kw("res.country", "search_read", [[], ["id", "code"]])
  return new Map(rows.map((r) => [r.id, (r.code || "").toUpperCase() || null]))
}

/** Dasselbe für Kantone/Bundesländer (res.country.state). */
export async function loadStateCodes(client) {
  const rows = await client.kw("res.country.state", "search_read", [[], ["id", "code"]])
  return new Map(rows.map((r) => [r.id, r.code || null]))
}
