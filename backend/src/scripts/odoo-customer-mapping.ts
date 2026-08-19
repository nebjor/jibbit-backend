/**
 * Odoo-Partner → Medusa-Kunden: die Zuordnung.
 *
 * Diese Datei importiert bewusst NICHTS aus @medusajs. Sie ist reine
 * Rechenlogik und deshalb ohne laufende Datenbank testbar
 * (src/__tests__/odoo-customer-mapping.unit.spec.ts). import-customers.ts
 * benutzt sie und kümmert sich nur noch ums Schreiben.
 *
 * ─── Das Problem ────────────────────────────────────────────────────────────
 *
 * Odoo kennt nur ein Modell für alles, was eine Adresse hat: res.partner.
 * Eine Firma, ihr Einkäufer, ihre Rechnungsadresse und ihr Auslieferungslager
 * sind vier Zeilen in derselben Tabelle, verbunden über `parent_id` und
 * unterschieden über `type`:
 *
 *     Muster Kiosk GmbH        is_company=true   parent_id=null  type=contact
 *     ├─ Anna Beispiel         is_company=false  parent_id=1     type=contact
 *     ├─ Buchhaltung           is_company=false  parent_id=1     type=invoice
 *     └─ Filiale Bahnhof       is_company=false  parent_id=1     type=delivery
 *
 * Medusa kennt zwei Dinge: `customer` (E-Mail = Identität) und
 * `customer_address` (n pro Kunde). Aus vier Odoo-Zeilen wird also EIN Kunde
 * mit mehreren Adressen — nicht vier Kunden.
 *
 * ─── Die Regeln ─────────────────────────────────────────────────────────────
 *
 *  1. Ein Partner wird nur dann ein Medusa-Kunde, wenn er eine brauchbare
 *     E-Mail-Adresse hat. Medusa identifiziert Kunden über die E-Mail; ohne
 *     sie liesse sich der Datensatz später nie einem Login zuordnen.
 *
 *  2. Kinder mit `type` ≠ 'contact' (invoice/delivery/other/private/…) sind
 *     Adressen, keine Kunden — auch dann, wenn sie eine eigene E-Mail haben.
 *     Unbekannte type-Werte gelten als Adresse: Odoo 17 hat mehr
 *     Auswahlwerte, als die Dokumentation nennt, und ein neuer Wert soll den
 *     Import nicht abbrechen.
 *
 *  3. Kinder mit `type` = 'contact' sind Ansprechpersonen. Mit E-Mail werden
 *     sie ein eigener Kunde (mit dem Firmennamen des Elternteils);
 *     ohne E-Mail werden sie übersprungen.
 *
 *  4. Hat die Firma selbst keine E-Mail, ihre Ansprechperson aber schon, dann
 *     erbt die Ansprechperson die Adressen der Firma. Sonst wären genau die
 *     Lieferadressen weg, an die man jahrelang geliefert hat.
 *
 *  5. Mehrere Partner mit derselben E-Mail werden zu einem Kunden
 *     zusammengeführt (Firma + Ansprechperson ist der Normalfall, doppelt
 *     erfasste Privatkunden der Ärgerfall). Welcher Datensatz gewinnt, regelt
 *     `pickWinner` — deterministisch, damit zwei Läufe dasselbe Ergebnis
 *     liefern.
 *
 *  6. Adressen ohne Ländercode werden verworfen. Medusa braucht für Versand
 *     und Steuer einen ISO-Code; eine Adresse ohne Land bricht später im
 *     Checkout ab, statt hier aufzufallen. Mit `defaultCountryCode` lässt sich
 *     ein Land unterstellen (für jibbit: "ch").
 *
 * ─── Was NICHT übernommen wird ──────────────────────────────────────────────
 *
 *  • Passwörter. Odoo hasht anders (PBKDF2 via passlib), Medusa nutzt scrypt
 *    im emailpass-Provider. Ein Hash lässt sich nicht umrechnen. Importierte
 *    Kunden haben deshalb kein Konto (`has_account = false`) und müssen sich
 *    beim ersten Login neu anmelden. Details und die Folgen:
 *    docs/odoo-datenmigration.md, Abschnitt „Passwörter".
 *
 *  • Bestellhistorie. Bleibt in Odoo, siehe scripts/odoo-export-orders.mjs.
 *
 *  • UID/MwSt-Nummer und Sprache landen in `metadata`, nicht in eigenen
 *    Feldern — Medusa hat dafür keine.
 */

/** Eine Zeile aus partners.json (scripts/odoo-export-customers.mjs). */
export type OdooPartner = {
  id: number
  name?: string | null
  display_name?: string | null
  is_company?: boolean
  company_type?: string | null
  parent_id?: number | null
  parent_name?: string | null
  type?: string | null
  email?: string | null
  phone?: string | null
  mobile?: string | null
  street?: string | null
  street2?: string | null
  city?: string | null
  zip?: string | null
  state_code?: string | null
  state_name?: string | null
  country_code?: string | null
  country_name?: string | null
  vat?: string | null
  lang?: string | null
  ref?: string | null
  function?: string | null
  title?: string | null
  customer_rank?: number | null
  supplier_rank?: number | null
  active?: boolean
  commercial_partner_id?: number | null
  commercial_partner_name?: string | null
  pricelist_id?: number | null
  pricelist?: string | null
  create_date?: string | null
  write_date?: string | null
}

export type PlannedAddress = {
  odoo_partner_id: number
  address_name: string | null
  company: string | null
  first_name: string | null
  last_name: string | null
  address_1: string | null
  address_2: string | null
  city: string | null
  postal_code: string | null
  province: string | null
  country_code: string
  phone: string | null
  is_default_billing: boolean
  is_default_shipping: boolean
}

export type PlannedCustomer = {
  /** Normalisiert: getrimmt und kleingeschrieben. Der Abgleichschlüssel. */
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  phone: string | null
  /** Der Partner, der den Datensatz anführt. */
  odoo_partner_id: number
  /** Alle Partner, die in diesen Kunden geflossen sind (inkl. odoo_partner_id). */
  merged_partner_ids: number[]
  metadata: Record<string, string | number | boolean | null>
  addresses: PlannedAddress[]
}

export type SkipReason =
  | "ohne-email"
  | "email-unbrauchbar"
  | "kein-kunde"
  | "archiviert"
  | "adresse-ohne-land"
  | "adresse-leer"
  | "adresse-ohne-kunde"

export type SkippedPartner = {
  odoo_partner_id: number
  reason: SkipReason
  /** Nur IDs, nie Namen oder E-Mail-Adressen — DSG. */
  parent_id?: number | null
  /**
   * Gesetzt, wenn der Partner zwar selbst kein Kunde wird, seine Adressen aber
   * an eine Ansprechperson übergegangen sind. Ohne diese Unterscheidung meldet
   * der Import eine Firma als „nicht anlegbar", obwohl ihre Daten sehr wohl
   * angekommen sind — und der Betreiber sucht in Odoo nach einem Problem, das
   * keines ist.
   */
  represented_by?: number
}

export type PlanOptions = {
  /** E-Mail-Adressen, die es in Medusa schon gibt. */
  existingEmails?: Iterable<string>
  /** Archivierte Partner (active = false) trotzdem übernehmen. */
  includeInactive?: boolean
  /** Auch Partner ohne customer_rank übernehmen (Lieferanten, Mitarbeiter). */
  includeNonCustomers?: boolean
  /** Ländercode für Adressen, bei denen Odoo keines hat, z.B. "ch". */
  defaultCountryCode?: string
}

export type ImportPlan = {
  /** Kunden, die angelegt werden müssen. */
  create: PlannedCustomer[]
  /** Kunden, deren E-Mail es in Medusa schon gibt — nichts zu tun. */
  existing: PlannedCustomer[]
  skipped: SkippedPartner[]
  stats: {
    partners_in: number
    customers_planned: number
    to_create: number
    already_in_medusa: number
    merged_duplicate_groups: number
    merged_partners: number
    addresses_planned: number
    skipped_no_email: number
    skipped_unusable_email: number
    skipped_not_a_customer: number
    skipped_archived: number
    addresses_without_country: number
    addresses_orphaned: number
  }
}

/**
 * `type`-Werte, die eine Ansprechperson bezeichnen. Alles andere gilt als
 * Adresse — auch unbekannte Werte, siehe Regel 2.
 */
const CONTACT_TYPES = new Set(["contact"])

// ─── kleine Helfer ───────────────────────────────────────────────────────────

const clean = (v?: string | null): string | null => {
  const s = (v ?? "").trim()
  return s.length ? s : null
}

/**
 * E-Mail auf den Abgleichschlüssel bringen.
 *
 * Odoo lässt in `email` alles zu. Häufig anzutreffen:
 *   "  Anna@Example.CH "        → anna@example.ch
 *   "anna@example.ch, buchhaltung@example.ch"  → anna@example.ch (erste)
 *   "Anna Muster <anna@example.ch>"            → anna@example.ch
 *   "-", "keine", "n/a"                        → null
 */
export function normalizeEmail(raw?: string | null): string | null {
  let s = (raw ?? "").trim()
  if (!s) {
    return null
  }

  // "Name <adresse>" — die spitzen Klammern gewinnen.
  const angled = s.match(/<([^>]+)>/)
  if (angled) {
    s = angled[1]
  }

  // Mehrere Adressen in einem Feld: die erste zählt, der Rest ist in Medusa
  // nicht abbildbar (ein Kunde, eine E-Mail).
  s = s.split(/[,;\s]+/).filter(Boolean)[0] ?? ""
  s = s.toLowerCase()

  // Bewusst konservativ: ein @, danach mindestens ein Punkt.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) {
    return null
  }

  return s
}

/**
 * "Anna Muster" → { first: "Anna", last: "Muster" }
 * "Anna Maria von Muster" → { first: "Anna Maria", last: "von Muster" } wäre
 * schöner, ist aber nicht entscheidbar — der letzte Token gewinnt.
 * "Muster, Anna" → { first: "Anna", last: "Muster" } (Odoo-Listenimporte)
 * "Kiosk" → { first: "Kiosk", last: null }
 */
export function splitName(raw?: string | null): {
  first_name: string | null
  last_name: string | null
} {
  const s = clean(raw)
  if (!s) {
    return { first_name: null, last_name: null }
  }

  if (s.includes(",")) {
    const [last, ...rest] = s.split(",")
    const first = clean(rest.join(" "))
    if (clean(last) && first) {
      return { first_name: first, last_name: clean(last) }
    }
  }

  const parts = s.split(/\s+/)
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: null }
  }

  return {
    first_name: parts.slice(0, -1).join(" "),
    last_name: parts[parts.length - 1],
  }
}

/** Odoo speichert die Sprache als "de_CH" — Medusa-Metadaten mögen "de-CH". */
const normalizeLang = (v?: string | null): string | null => {
  const s = clean(v)
  return s ? s.replace("_", "-") : null
}

const isAddressChild = (p: OdooPartner): boolean =>
  p.parent_id != null && !CONTACT_TYPES.has(p.type ?? "contact")

/** Wie vollständig ist ein Datensatz? Entscheidet Dubletten (Kriterium 4). */
function completeness(p: OdooPartner): number {
  return [p.name, p.phone ?? p.mobile, p.street, p.city, p.zip, p.country_code].filter(
    (v) => clean(v as string | null | undefined) !== null
  ).length
}

/**
 * Welcher von mehreren Partnern mit derselben E-Mail führt den Kunden an?
 *
 * Reihenfolge der Kriterien — bewusst festgelegt, damit derselbe Export
 * zweimal dasselbe Ergebnis liefert und ein zweiter Lauf keine Dublette anlegt:
 *
 *   1. aktiv vor archiviert
 *   2. höherer customer_rank
 *   3. eigenständig (kein parent_id) vor Unterkontakt
 *      — bei „Firma + Ansprechperson mit gleicher Mail" gewinnt die Firma;
 *        Vor- und Nachname holt sich der Kunde danach von der Person.
 *   4. vollständigerer Datensatz
 *   5. jüngeres write_date
 *   6. kleinere Odoo-ID (letzte Instanz, immer entscheidbar)
 */
export function byPrecedence(a: OdooPartner, b: OdooPartner): number {
  const active = Number(b.active !== false) - Number(a.active !== false)
  if (active) return active

  const rank = (b.customer_rank ?? 0) - (a.customer_rank ?? 0)
  if (rank) return rank

  const top = Number(a.parent_id == null) - Number(b.parent_id == null)
  if (top) return -top

  const complete = completeness(b) - completeness(a)
  if (complete) return complete

  const written = (b.write_date ?? "").localeCompare(a.write_date ?? "")
  if (written) return written

  return a.id - b.id
}

/**
 * Die ganze Gruppe in diese Reihenfolge bringen — nicht nur den Sieger picken.
 *
 * Die Rangfolge der Verlierer ist keine Kosmetik: aus ihr werden fehlende
 * Felder nachgefüllt (`firstOf`). Bliebe sie bei der Reihenfolge im Export,
 * lieferte derselbe Export je nach Sortierung andere Kundendaten — und der
 * Import wäre nicht mehr wiederholbar.
 */
export function rankGroup(group: OdooPartner[]): OdooPartner[] {
  return [...group].sort(byPrecedence)
}

export function pickWinner(group: OdooPartner[]): OdooPartner {
  return rankGroup(group)[0]
}

// ─── Adressen ────────────────────────────────────────────────────────────────

type AddressDraft = {
  address: PlannedAddress | null
  skip: SkippedPartner | null
}

function toAddress(
  p: OdooPartner,
  opts: PlanOptions
): AddressDraft {
  const street = clean(p.street)
  const city = clean(p.city)
  const zip = clean(p.zip)

  // Leere Adresszeilen sind in Odoo die Regel, nicht die Ausnahme: jeder
  // Partner hat die Felder, die wenigsten füllen sie.
  if (!street && !city && !zip) {
    return { address: null, skip: null }
  }

  const country = (clean(p.country_code) ?? opts.defaultCountryCode ?? "").toLowerCase()
  if (!country) {
    return {
      address: null,
      skip: { odoo_partner_id: p.id, reason: "adresse-ohne-land", parent_id: p.parent_id ?? null },
    }
  }

  const isCompanyRow = p.is_company === true
  const names = isCompanyRow ? { first_name: null, last_name: null } : splitName(p.name)

  return {
    address: {
      odoo_partner_id: p.id,
      // Bei Unteradressen ist `name` das Label ("Buchhaltung", "Filiale Bahnhof").
      address_name: p.parent_id != null ? clean(p.name) : null,
      company: isCompanyRow ? clean(p.name) : clean(p.parent_name),
      first_name: names.first_name,
      last_name: names.last_name,
      address_1: street,
      address_2: clean(p.street2),
      city,
      postal_code: zip,
      // Medusa erwartet ISO 3166-2 kleingeschrieben, Odoo liefert "ZH".
      province: clean(p.state_code)?.toLowerCase() ?? null,
      country_code: country,
      phone: clean(p.phone) ?? clean(p.mobile),
      is_default_billing: false,
      is_default_shipping: false,
    },
    skip: null,
  }
}

/** Zwei Adressen gelten als dieselbe, wenn Strasse, PLZ, Ort und Land gleich sind. */
const addressKey = (a: PlannedAddress): string =>
  [a.address_1, a.postal_code, a.city, a.country_code]
    .map((v) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim())
    .join("|")

/**
 * Genau eine Rechnungs- und eine Lieferadresse markieren.
 *
 * Medusa erlaubt pro Kunde je ein Default. Odoos `type` liefert die Absicht:
 * 'invoice' → Rechnung, 'delivery' → Lieferung. Gibt es keine solche
 * Unteradresse, übernimmt die erste (= die des Kunden selbst) beide Rollen.
 */
function markDefaults(
  addresses: PlannedAddress[],
  typeOf: Map<number, string | null>
): void {
  if (!addresses.length) {
    return
  }

  const invoice = addresses.find((a) => typeOf.get(a.odoo_partner_id) === "invoice")
  const delivery = addresses.find((a) => typeOf.get(a.odoo_partner_id) === "delivery")

  ;(invoice ?? addresses[0]).is_default_billing = true
  ;(delivery ?? addresses[0]).is_default_shipping = true
}

// ─── Der Plan ────────────────────────────────────────────────────────────────

/**
 * Aus den exportierten Odoo-Partnern einen Importplan rechnen.
 *
 * Rein — keine Seiteneffekte, keine Datenbank. Zweimal aufrufen liefert
 * zweimal dasselbe. Genau das macht den Import idempotent: das Ergebnis des
 * ersten Laufs (die angelegten E-Mail-Adressen) wandert als `existingEmails`
 * in den zweiten, und `create` ist dann leer.
 */
export function planCustomerImport(
  partners: OdooPartner[],
  opts: PlanOptions = {}
): ImportPlan {
  const skipped: SkippedPartner[] = []
  const byId = new Map<number, OdooPartner>(partners.map((p) => [p.id, p]))
  const typeOf = new Map<number, string | null>(partners.map((p) => [p.id, p.type ?? null]))

  const childrenOf = new Map<number, OdooPartner[]>()
  for (const p of partners) {
    if (p.parent_id == null) {
      continue
    }
    const list = childrenOf.get(p.parent_id) ?? []
    list.push(p)
    childrenOf.set(p.parent_id, list)
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.id - b.id)
  }

  // ─── 1) Wer kommt als Kunde in Frage? ─────────────────────────────────────
  const candidates: { partner: OdooPartner; email: string }[] = []

  for (const p of partners) {
    if (isAddressChild(p)) {
      continue // Adresse, wird unter 2) eingesammelt
    }

    if (p.active === false && !opts.includeInactive) {
      skipped.push({ odoo_partner_id: p.id, reason: "archiviert" })
      continue
    }

    // customer_rank = 0 heisst „nie als Kunde in Erscheinung getreten".
    // Unterkontakte einer Kundenfirma haben selbst Rang 0 und zählen trotzdem.
    const rank = p.customer_rank ?? 0
    const inheritsRank = p.parent_id != null
    if (rank <= 0 && !inheritsRank && !opts.includeNonCustomers) {
      skipped.push({ odoo_partner_id: p.id, reason: "kein-kunde" })
      continue
    }

    const rawEmail = clean(p.email)
    if (!rawEmail) {
      skipped.push({ odoo_partner_id: p.id, reason: "ohne-email", parent_id: p.parent_id ?? null })
      continue
    }

    const email = normalizeEmail(rawEmail)
    if (!email) {
      skipped.push({
        odoo_partner_id: p.id,
        reason: "email-unbrauchbar",
        parent_id: p.parent_id ?? null,
      })
      continue
    }

    candidates.push({ partner: p, email })
  }

  const candidateIds = new Set(candidates.map((c) => c.partner.id))

  // ─── 2) Adressen den Kunden zuordnen ──────────────────────────────────────
  // Jeder Partner steuert seine eigene Adresszeile bei. Adress-Kinder gehen an
  // den Elternteil — und wenn der selbst kein Kunde ist (keine E-Mail), an
  // dessen erste Ansprechperson mit E-Mail (Regel 4).
  const representativeOf = new Map<number, number>()
  for (const p of partners) {
    if (candidateIds.has(p.id)) {
      continue
    }
    const rep = (childrenOf.get(p.id) ?? []).find((c) => candidateIds.has(c.id))
    if (rep) {
      representativeOf.set(p.id, rep.id)
    }
  }

  for (const entry of skipped) {
    const rep = representativeOf.get(entry.odoo_partner_id)
    if (rep !== undefined) {
      entry.represented_by = rep
    }
  }

  const ownerOf = (p: OdooPartner): number | null => {
    if (candidateIds.has(p.id)) {
      return p.id
    }
    const parent = p.parent_id != null ? byId.get(p.parent_id) : undefined
    if (!parent) {
      return representativeOf.get(p.id) ?? null
    }
    if (candidateIds.has(parent.id)) {
      return parent.id
    }
    return representativeOf.get(parent.id) ?? null
  }

  const addressesFor = new Map<number, PlannedAddress[]>()
  let addressesWithoutCountry = 0
  let addressesOrphaned = 0

  // Reihenfolge: erst die eigene Zeile des Kunden, dann die Unteradressen.
  // Dadurch ist addresses[0] die Adresse des Kunden selbst — die Rückfallebene
  // für beide Defaults.
  const inAddressOrder = [
    ...partners.filter((p) => candidateIds.has(p.id)),
    ...partners.filter((p) => !candidateIds.has(p.id)),
  ]

  for (const p of inAddressOrder) {
    if (p.active === false && !opts.includeInactive && !candidateIds.has(p.id)) {
      // Archivierte Unteradressen gehören zu einer Adresse, die es nicht mehr
      // gibt — sie stillschweigend zu übernehmen wäre falsch.
      continue
    }

    const { address, skip } = toAddress(p, opts)

    if (skip) {
      addressesWithoutCountry++
      skipped.push(skip)
      continue
    }
    if (!address) {
      continue
    }

    const owner = ownerOf(p)
    if (owner == null) {
      addressesOrphaned++
      skipped.push({
        odoo_partner_id: p.id,
        reason: "adresse-ohne-kunde",
        parent_id: p.parent_id ?? null,
      })
      continue
    }

    const list = addressesFor.get(owner) ?? []
    if (!list.some((a) => addressKey(a) === addressKey(address))) {
      list.push(address)
    }
    addressesFor.set(owner, list)
  }

  // ─── 3) Dubletten über die E-Mail zusammenführen ──────────────────────────
  const groups = new Map<string, OdooPartner[]>()
  for (const c of candidates) {
    const list = groups.get(c.email) ?? []
    list.push(c.partner)
    groups.set(c.email, list)
  }

  const existing = new Set(
    [...(opts.existingEmails ?? [])]
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => e !== null)
  )

  const planned: PlannedCustomer[] = []
  let mergedGroups = 0
  let mergedPartners = 0

  for (const [email, group] of groups) {
    if (group.length > 1) {
      mergedGroups++
      mergedPartners += group.length - 1
    }

    const ordered = rankGroup(group)
    const winner = ordered[0]

    // Fehlende Felder von den unterlegenen Datensätzen nachfüllen.
    const firstOf = <T>(pick: (p: OdooPartner) => T | null | undefined): T | null => {
      for (const p of ordered) {
        const v = pick(p)
        if (v !== null && v !== undefined && v !== "") {
          return v
        }
      }
      return null
    }

    // Firmenname: die Firmenzeile selbst, sonst der Elternteil der Person.
    const companyRow = ordered.find((p) => p.is_company === true)
    const company_name =
      clean(companyRow?.name) ?? firstOf((p) => clean(p.parent_name))

    // Vor-/Nachname: nur Personenzeilen liefern die. Eine Firma heisst
    // "Muster Kiosk GmbH" — daraus first_name "Muster Kiosk" zu machen wäre
    // Unsinn, deshalb bleibt das Feld dann leer.
    const personRow = ordered.find((p) => p.is_company !== true && clean(p.name))
    const names = personRow
      ? splitName(personRow.name)
      : { first_name: null, last_name: null }

    const merged_partner_ids = ordered.map((p) => p.id)

    const addresses: PlannedAddress[] = []
    for (const id of merged_partner_ids) {
      for (const a of addressesFor.get(id) ?? []) {
        if (!addresses.some((x) => addressKey(x) === addressKey(a))) {
          addresses.push(a)
        }
      }
    }
    markDefaults(addresses, typeOf)

    planned.push({
      email,
      first_name: names.first_name,
      last_name: names.last_name,
      company_name,
      phone: firstOf((p) => clean(p.phone) ?? clean(p.mobile)),
      odoo_partner_id: winner.id,
      merged_partner_ids,
      metadata: {
        source: "odoo",
        odoo_partner_id: winner.id,
        // Als String, damit die Liste auch in Admin-Filtern lesbar bleibt.
        odoo_partner_ids: merged_partner_ids.join(","),
        odoo_commercial_partner_id: winner.commercial_partner_id ?? null,
        odoo_pricelist: clean(winner.pricelist),
        odoo_vat: firstOf((p) => clean(p.vat)),
        odoo_lang: firstOf((p) => normalizeLang(p.lang)),
        odoo_ref: firstOf((p) => clean(p.ref)),
        // Merkposten für den „Passwort vergessen"-Ablauf: dieser Kunde hat
        // (noch) kein Konto, weil das Odoo-Passwort nicht migrierbar ist.
        imported_without_account: true,
      },
      addresses,
    })
  }

  // Stabile Reihenfolge — erleichtert das Vergleichen zweier Probeläufe.
  planned.sort((a, b) => a.odoo_partner_id - b.odoo_partner_id)

  const create = planned.filter((p) => !existing.has(p.email))
  const alreadyThere = planned.filter((p) => existing.has(p.email))

  const count = (r: SkipReason) => skipped.filter((s) => s.reason === r).length

  return {
    create,
    existing: alreadyThere,
    skipped,
    stats: {
      partners_in: partners.length,
      customers_planned: planned.length,
      to_create: create.length,
      already_in_medusa: alreadyThere.length,
      merged_duplicate_groups: mergedGroups,
      merged_partners: mergedPartners,
      addresses_planned: create.reduce((n, c) => n + c.addresses.length, 0),
      skipped_no_email: count("ohne-email"),
      skipped_unusable_email: count("email-unbrauchbar"),
      skipped_not_a_customer: count("kein-kunde"),
      skipped_archived: count("archiviert"),
      addresses_without_country: addressesWithoutCountry,
      addresses_orphaned: addressesOrphaned,
    },
  }
}
