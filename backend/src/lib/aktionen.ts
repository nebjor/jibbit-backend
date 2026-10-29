/**
 * Öffentliche Aktionen: Mapping der Medusa-Promotionen auf die schlanke
 * Antwort von GET /store/aktionen. Reine Funktionen, ohne Datenbank.
 *
 * Es werden ausschliesslich AUTOMATISCHE Promotionen ausgegeben — Codes, die
 * man eintippen muss (is_automatic: false), dürfen nie öffentlich auftauchen.
 */

export type RohPromotion = {
  code?: string | null
  is_automatic?: boolean | null
  status?: string | null
  type?: string | null
  campaign?: {
    name?: string | null
    starts_at?: string | Date | null
    ends_at?: string | Date | null
  } | null
  application_method?: {
    type?: string | null
    value?: number | string | null
    currency_code?: string | null
    target_type?: string | null
    allocation?: string | null
    target_rules?: { id?: string | null }[] | null
  } | null
}

export type Aktion = {
  code: string
  titel: string
  prozent?: number
  betrag?: number
  waehrung?: string
  /** ISO-Zeitpunkt; null = ohne Startdatum (Promotion ohne Kampagne). */
  gilt_ab: string | null
  /** ISO-Zeitpunkt; null = unbefristet. */
  gilt_bis: string | null
  /** true, wenn die Aktion nur für ein Teilsortiment gilt (Zielregeln). */
  nur_teilsortiment: boolean
  /** true, wenn der Rabatt auf Artikel wirkt (nicht auf den Versand). */
  auf_artikel: boolean
}

function alsDatum(wert: string | Date | null | undefined): Date | null {
  if (!wert) return null
  const d = wert instanceof Date ? wert : new Date(wert)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Läuft die Promotion zum Zeitpunkt `jetzt`? Ohne Kampagne: immer. */
export function istImZeitfenster(p: RohPromotion, jetzt: Date): boolean {
  const von = alsDatum(p.campaign?.starts_at)
  const bis = alsDatum(p.campaign?.ends_at)
  if (von && von.getTime() > jetzt.getTime()) return false
  if (bis && bis.getTime() <= jetzt.getTime()) return false
  return true
}

function formatZahl(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}

export function bestimmeTitel(p: RohPromotion, wert: number | null): string {
  const name = p.campaign?.name?.trim()
  if (name) return name
  const am = p.application_method
  if (am?.type === "percentage" && wert !== null) {
    return am.target_type === "shipping_methods"
      ? `${formatZahl(wert)} % auf den Versand`
      : `${formatZahl(wert)} % auf alles`
  }
  if (am?.type === "fixed" && wert !== null) {
    return `CHF ${formatZahl(wert)} Rabatt`
  }
  return "Aktion"
}

/** Eine Promotion → Aktion, oder null wenn sie nicht öffentlich laufen darf. */
export function mappeAktion(p: RohPromotion, jetzt: Date): Aktion | null {
  if (p.status !== "active") return null
  if (p.is_automatic !== true) return null
  if (p.type && p.type !== "standard") return null
  if (!p.code || !p.application_method) return null
  if (!istImZeitfenster(p, jetzt)) return null

  const am = p.application_method
  const rohWert =
    am.value === null || am.value === undefined ? NaN : Number(am.value)
  if (!Number.isFinite(rohWert) || rohWert <= 0) return null
  const wert = rohWert

  const aktion: Aktion = {
    code: p.code,
    titel: bestimmeTitel(p, wert),
    gilt_ab: alsDatum(p.campaign?.starts_at)?.toISOString() ?? null,
    gilt_bis: alsDatum(p.campaign?.ends_at)?.toISOString() ?? null,
    nur_teilsortiment: (am.target_rules?.length ?? 0) > 0,
    auf_artikel: am.target_type !== "shipping_methods",
  }
  if (am.type === "percentage") {
    aktion.prozent = wert
  } else if (am.type === "fixed") {
    aktion.betrag = wert
    if (am.currency_code) aktion.waehrung = am.currency_code.toUpperCase()
  } else {
    return null
  }
  return aktion
}

/** Alle aktuell laufenden Aktionen; früh endende zuerst, unbefristete zuletzt. */
export function mappeAktionen(liste: RohPromotion[], jetzt: Date): Aktion[] {
  return liste
    .map((p) => mappeAktion(p, jetzt))
    .filter((a): a is Aktion => a !== null)
    .sort((a, b) => {
      const x = a.gilt_bis ?? "9999"
      const y = b.gilt_bis ?? "9999"
      return x < y ? -1 : x > y ? 1 : 0
    })
}
