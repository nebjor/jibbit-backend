import type { EmailContent, PushMessage } from "./notify"
import { escapeHtml } from "./email-format"

/**
 * Produktwunsch aus dem Shop («Nicht gefunden, was du suchst?»).
 *
 * Alles, was hier hineinkommt, stammt von Besuchern und wird als Text
 * behandelt: im HTML escaped, im Klartext von Steuerzeichen befreit.
 */

export const PRODUKTWUNSCH_SUBJECT = "Produktwunsch aus dem Shop"
export const PRODUKTWUNSCH_TEMPLATE = "produktwunsch"

export interface ProduktwunschInput {
  wunsch: string
  email?: string
  kontext: { kategorie?: string; suche?: string; url?: string }
}

/** Steuerzeichen raus (Zeilenumbruch bleibt im Wunsch erlaubt). */
export function bereinige(value: string, mehrzeilig = false): string {
  const muster = mehrzeilig ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g
  return value.replace(muster, " ").trim()
}

export function formatZeit(date: Date): string {
  try {
    const teile = new Intl.DateTimeFormat("de-CH", {
      timeZone: "Europe/Zurich",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date)
    const get = (type: string) => teile.find((p) => p.type === type)?.value ?? ""
    return `${get("day")}.${get("month")}.${get("year")}, ${get("hour")}:${get("minute")} Uhr`
  } catch {
    return date.toISOString()
  }
}

function zeilen(input: ProduktwunschInput, zeit: Date): Array<[string, string]> {
  const k = input.kontext
  return [
    ["Wunsch", bereinige(input.wunsch, true)],
    ["E-Mail", input.email ? bereinige(input.email) : "nicht angegeben"],
    ["Kategorie", k.kategorie ? bereinige(k.kategorie) : "–"],
    ["Suche", k.suche ? bereinige(k.suche) : "–"],
    ["Seite", k.url ? bereinige(k.url) : "–"],
    ["Zeit", formatZeit(zeit)],
  ]
}

export function renderProduktwunsch(input: ProduktwunschInput, zeit: Date = new Date()): EmailContent {
  const felder = zeilen(input, zeit)
  const text = [
    "Neuer Produktwunsch aus dem Shop",
    "",
    ...felder.map(([label, wert]) => (label === "Wunsch" ? `${label}:\n${wert}\n` : `${label}: ${wert}`)),
  ].join("\n")

  const rows = felder
    .map(
      ([label, wert]) =>
        `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#555"><strong>${escapeHtml(label)}</strong></td>` +
        `<td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(wert)}</td></tr>`
    )
    .join("")
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111">` +
    `<h2 style="margin:0 0 12px">Neuer Produktwunsch aus dem Shop</h2>` +
    `<table style="border-collapse:collapse">${rows}</table></div>`

  return { subject: PRODUKTWUNSCH_SUBJECT, text, html }
}

/** Push: Titel ASCII (HTTP-Header), Wunsch gekürzt in der Nachricht. */
export function renderProduktwunschPush(input: ProduktwunschInput): PushMessage {
  const kurz = bereinige(input.wunsch).replace(/\s+/g, " ")
  return {
    title: "Neuer Produktwunsch",
    message: kurz.length > 140 ? `${kurz.slice(0, 137)}...` : kurz,
    tags: "speech_balloon",
  }
}
