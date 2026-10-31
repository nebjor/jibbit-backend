/**
 * E-Mail-Adresse eines Kunden korrigieren — die Regeln, als reine Funktionen.
 *
 * ─── WARUM ES DAS BRAUCHT ─────────────────────────────────────────────────
 *
 * Das Admin-Dashboard sperrt das Feld «E-Mail» für Kunden mit Konto
 * (`@medusajs/dashboard`, edit-customer-form.tsx: `disabled={customer.has_account}`
 * und `email: customer.has_account ? undefined : data.email`). Die Sperre sitzt
 * nur im Formular; die Admin-API nähme die Adresse an. Sie ist trotzdem
 * berechtigt, denn die Adresse steht an DREI Orten:
 *
 *   1. `customer.email` — Anzeige, Suche, Vorgabe für neue Bestellungen.
 *   2. `provider_identity.entity_id` (Provider `emailpass`) — damit meldet sich
 *      die Kundin an, und dorthin geht «Passwort vergessen». Das Passwort
 *      (`provider_metadata.password`) und die Verknüpfung zum Kunden
 *      (`auth_identity.app_metadata.customer_id`) hängen an derselben Zeile
 *      bzw. an deren `auth_identity`; die Adresse selbst steht dort nicht.
 *   3. `order.email` — Kopie zum Zeitpunkt der Bestellung. Versand-, Storno-
 *      und Rückerstattungs-Mails gehen an DIESE Adresse, nicht an die des
 *      Kunden.
 *
 * Wer nur (1) ändert, hat ein Konto, das die neue Adresse anzeigt und sich nur
 * mit der alten anmelden lässt. Deshalb ändert der Workflow
 * `aendereKundenEmailWorkflow` alle drei zusammen oder keine.
 *
 * Getestet in `src/__tests__/kunden-email.unit.spec.ts`.
 */

import type { EmailContent } from "./notify"
import { getShopConfig } from "./shop-config"
import { escapeHtml } from "./email-format"
import { htmlDocument } from "./order-notification"

export const EMAILPASS = "emailpass"

/** RFC 5321: höchstens 254 Zeichen. */
export const EMAIL_MAX_LAENGE = 254

/**
 * Bestellungen, die älter sind, werden nie angefasst — auch wenn sie formal
 * noch offen sind. Eine unversendete Bestellung in diesem Alter ist ein
 * Sonderfall, den man im Admin von Hand ansieht.
 */
export const BESTELLUNG_MAX_ALTER_TAGE = 90

/** Status, in denen eine Bestellung abgeschlossen ist oder keine echte Bestellung. */
const GESCHLOSSENE_STATUS = new Set(["completed", "canceled", "archived", "draft"])

/** Trimmen und klein schreiben. Alles andere bleibt, wie es eingegeben wurde. */
export function normalisiereEmail(eingabe: unknown): string {
  return typeof eingabe === "string" ? eingabe.trim().toLowerCase() : ""
}

/**
 * Prüft eine bereits normalisierte Adresse. Bewusst streng und einfach: ein
 * `@`, davor und danach etwas, eine Domain mit Punkt, keine Leer- oder
 * Steuerzeichen. Ob es das Postfach gibt, weiss nur der Mailserver.
 */
export function pruefeEmail(email: string): string[] {
  if (!email) return ["Bitte eine E-Mail-Adresse eingeben."]
  if (email.length > EMAIL_MAX_LAENGE) {
    return [`Die E-Mail-Adresse ist länger als ${EMAIL_MAX_LAENGE} Zeichen.`]
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f<>()[\]\\,;:"]/.test(email)) {
    return ["Die E-Mail-Adresse enthält Leerzeichen oder unzulässige Zeichen."]
  }
  const teile = email.split("@")
  if (teile.length !== 2 || !teile[0] || !teile[1]) {
    return ["Die E-Mail-Adresse braucht genau ein @ mit Text davor und danach."]
  }
  const [lokal, domain] = teile
  if (lokal.length > 64 || lokal.startsWith(".") || lokal.endsWith(".") || lokal.includes("..")) {
    return ["Der Teil vor dem @ ist ungültig."]
  }
  const labels = domain.split(".")
  if (
    labels.length < 2 ||
    labels.some((l) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) ||
    !/^[a-z]{2,}$/.test(labels[labels.length - 1])
  ) {
    return ["Die Domain nach dem @ ist ungültig (Beispiel: name@beispiel.ch)."]
  }
  return []
}

/** Muster für `$ilike`, das die Adresse wörtlich trifft (`_` und `%` sind dort Platzhalter). */
export function ilikeMuster(email: string): string {
  return email.replace(/[\\%_]/g, (z) => `\\${z}`)
}

// ─── Bestellungen ─────────────────────────────────────────────────────────

export interface BestellungSicht {
  id: string
  status?: string | null
  email?: string | null
  canceled_at?: unknown
  created_at?: unknown
  items?: Array<{
    quantity?: unknown
    detail?: { quantity?: unknown; shipped_quantity?: unknown } | null
  } | null> | null
}

function zahl(wert: unknown): number {
  const roh =
    wert && typeof wert === "object" && "value" in wert ? (wert as { value: unknown }).value : wert
  const n = Number(roh ?? 0)
  return Number.isFinite(n) ? n : 0
}

function zeit(wert: unknown): number | null {
  if (wert == null) return null
  const t = wert instanceof Date ? wert.getTime() : new Date(wert as string | number).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Offen heisst: es kommt noch eine Sendung, also noch eine Versandbestätigung.
 *
 *   - nicht abgeschlossen, storniert, archiviert oder Entwurf
 *   - mindestens ein Artikel, von dem noch nicht alles versendet ist
 *   - nicht älter als `BESTELLUNG_MAX_ALTER_TAGE`
 *
 * Im Zweifel (kein Datum, keine Artikel geladen) gilt eine Bestellung als
 * NICHT offen: eine Buchhaltungszeile unverändert zu lassen ist der kleinere
 * Fehler.
 */
export function istOffeneBestellung(b: BestellungSicht, jetzt: number = Date.now()): boolean {
  if (!b?.id) return false
  if (GESCHLOSSENE_STATUS.has(String(b.status ?? ""))) return false
  if (b.canceled_at != null) return false

  const erstellt = zeit(b.created_at)
  if (erstellt == null) return false
  if (jetzt - erstellt > BESTELLUNG_MAX_ALTER_TAGE * 24 * 60 * 60 * 1000) return false

  return (b.items ?? []).some((item) => {
    if (!item) return false
    const menge = zahl(item.detail?.quantity ?? item.quantity)
    return menge > 0 && zahl(item.detail?.shipped_quantity) < menge
  })
}

/** IDs der offenen Bestellungen, deren Adresse von der neuen abweicht. */
export function waehleBestellungen(
  bestellungen: BestellungSicht[],
  neu: string,
  jetzt: number = Date.now()
): string[] {
  return bestellungen
    .filter((b) => istOffeneBestellung(b, jetzt) && normalisiereEmail(b.email) !== neu)
    .map((b) => b.id)
}

// ─── Entscheidung ─────────────────────────────────────────────────────────

export interface KundeSicht {
  id: string
  email?: string | null
  has_account?: boolean | null
  first_name?: string | null
}

/** Die emailpass-Identität, die über `app_metadata.customer_id` an diesem Kunden hängt. */
export interface IdentitaetSicht {
  /** ID der `provider_identity`-Zeile. */
  id: string
  auth_identity_id: string
  entity_id: string
}

/** Eine emailpass-Identität, die die NEUE Adresse schon trägt und nicht diesem Kunden gehört. */
export interface FremdeIdentitaet {
  auth_identity_id: string
  /** `app_metadata.customer_id`; `null` bei Admin-Benutzern und unverknüpften Identitäten. */
  customer_id: string | null
}

export interface KundenEmailLage {
  kunde: KundeSicht
  /** Alle ANDEREN Kundendatensätze mit der neuen Adresse. */
  andere_kunden: Array<{ id: string; has_account: boolean }>
  identitaet: IdentitaetSicht | null
  fremde_identitaet: FremdeIdentitaet | null
  bestellungen: BestellungSicht[]
}

export interface KundenEmailPlan {
  customer_id: string
  neu: string
  hat_konto: boolean
  /** Der Kunde hat eine verknüpfte emailpass-Anmeldung (ob sie sich ändert oder nicht). */
  hat_anmeldung: boolean
  kunde_aendern: boolean
  /** Gesetzt, wenn `provider_identity.entity_id` umgeschrieben wird. */
  identitaet: { id: string; alt: string } | null
  bestellung_ids: string[]
  hinweise: string[]
}

export type KundenEmailEntscheid =
  | { ok: true; plan: KundenEmailPlan }
  | { ok: false; fehler: string; konflikt_kunde_id?: string | null }

/**
 * Entscheidet, was geschrieben wird — oder warum nichts.
 *
 * Zusammengeführt wird NIE. Gehört die neue Adresse schon jemandem, ist das
 * eine Entscheidung über Bestellhistorie und Adressen zweier Datensätze, und
 * die trifft ein Mensch (siehe docs/odoo-datenmigration.md, Abschnitt 7).
 */
export function entscheideKundenEmail(
  lage: KundenEmailLage,
  eingabe: unknown,
  optionen: { bestellungen_anpassen: boolean; jetzt?: number }
): KundenEmailEntscheid {
  const neu = normalisiereEmail(eingabe)
  const fehler = pruefeEmail(neu)
  if (fehler.length) return { ok: false, fehler: fehler.join(" ") }

  const { kunde, identitaet, fremde_identitaet } = lage
  const hatKonto = Boolean(kunde.has_account)
  const hinweise: string[] = []

  // 1. Unique-Index (email, has_account): dieselbe Adresse mit demselben
  //    has_account gibt es nur einmal.
  const gleicher = lage.andere_kunden.find((k) => k.has_account === hatKonto)
  if (gleicher) {
    return {
      ok: false,
      konflikt_kunde_id: gleicher.id,
      fehler:
        `Diese E-Mail-Adresse gehört bereits zu einem anderen Kunden ` +
        `${hatKonto ? "mit Konto" : "ohne Konto"} (${gleicher.id}). Es wurde nichts geändert. ` +
        `Kunden werden hier nicht zusammengeführt — bitte zuerst klären, welcher Datensatz gilt.`,
    }
  }

  // 2. Unique-Index (entity_id, provider): die Adresse ist schon ein Login.
  //    Nur ein Hindernis, wenn dieser Kunde selbst ein Login hat, das
  //    umgeschrieben werden müsste.
  if (identitaet && fremde_identitaet) {
    const wem = fremde_identitaet.customer_id
      ? `zum Kunden ${fremde_identitaet.customer_id}`
      : "zu einem Login ohne Kundendatensatz (zum Beispiel einem Admin-Benutzer)"
    return {
      ok: false,
      konflikt_kunde_id: fremde_identitaet.customer_id,
      fehler:
        `Mit dieser E-Mail-Adresse gibt es bereits eine Anmeldung; sie gehört ${wem}. ` +
        `Es wurde nichts geändert.`,
    }
  }

  const anderer = lage.andere_kunden[0]
  if (anderer) {
    hinweise.push(
      `Achtung: Es gibt einen zweiten Kundendatensatz mit dieser Adresse ` +
        `(${anderer.id}, ${anderer.has_account ? "mit Konto" : "ohne Konto"}). ` +
        `Nach dem Speichern tragen beide dieselbe Adresse; die Bestellungen bleiben getrennt.`
    )
  } else if (!identitaet && fremde_identitaet) {
    hinweise.push(
      `Achtung: Mit dieser Adresse gibt es bereits eine Anmeldung` +
        (fremde_identitaet.customer_id ? ` (Kunde ${fremde_identitaet.customer_id}).` : `.`)
    )
  }

  if (hatKonto && !identitaet) {
    hinweise.push(
      "Dieser Kunde hat ein Konto, aber keine verknüpfte Anmeldung mit E-Mail und Passwort. " +
        "Geändert wird nur die Adresse am Kundendatensatz."
    )
  }

  const kundeAendern = (kunde.email ?? "") !== neu
  const identitaetAendern = identitaet && identitaet.entity_id !== neu ? identitaet : null
  const bestellungIds = optionen.bestellungen_anpassen
    ? waehleBestellungen(lage.bestellungen, neu, optionen.jetzt)
    : []

  if (!kundeAendern && !identitaetAendern && !bestellungIds.length) {
    return {
      ok: false,
      fehler: "Diese E-Mail-Adresse ist bereits hinterlegt — es gibt nichts zu ändern.",
    }
  }

  return {
    ok: true,
    plan: {
      customer_id: kunde.id,
      neu,
      hat_konto: hatKonto,
      hat_anmeldung: Boolean(identitaet),
      kunde_aendern: kundeAendern,
      identitaet: identitaetAendern
        ? { id: identitaetAendern.id, alt: identitaetAendern.entity_id }
        : null,
      bestellung_ids: bestellungIds,
      hinweise,
    },
  }
}

// ─── Mail an die neue Adresse ─────────────────────────────────────────────

export interface EmailKorrigiertInput {
  storeName: string
  firstName?: string | null
  /** Mit Anmeldung: der Text nennt das Konto und die Anmeldung. */
  mitAnmeldung: boolean
  bestellungen: number
}

/**
 * Kurze Mitteilung an die NEUE Adresse. Die alte Adresse steht nicht drin:
 * sie war falsch und gehört womöglich jemand anderem.
 */
export function renderEmailKorrigiert(input: EmailKorrigiertInput): EmailContent {
  const store = input.storeName
  const name = input.firstName?.trim()
  const greeting = name ? `Hallo ${name}` : "Hallo"
  const intro = input.mitAnmeldung
    ? `Wir haben die E-Mail-Adresse deines Kontos bei ${store} korrigiert. Ab sofort meldest du dich mit der Adresse an, an die diese Nachricht ging. Dein Passwort bleibt gleich.`
    : `Wir haben die E-Mail-Adresse korrigiert, die bei ${store} zu dir hinterlegt ist. Nachrichten von uns kommen ab sofort an die Adresse, an die diese Nachricht ging.`
  const orders =
    input.bestellungen > 0
      ? input.bestellungen === 1
        ? "Die Versandbestätigung zu deiner offenen Bestellung kommt ebenfalls hierhin."
        : "Die Versandbestätigungen zu deinen offenen Bestellungen kommen ebenfalls hierhin."
      : null
  const contact = `Stimmt etwas nicht? Schreib uns an ${getShopConfig().contactEmail}.`

  const text = [
    greeting,
    ``,
    intro,
    ...(orders ? [``, orders] : []),
    ``,
    contact,
    ``,
    `Liebe Grüsse`,
    store,
  ].join("\n")

  const html = htmlDocument(
    [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      ...(orders ? [`<p>${escapeHtml(orders)}</p>`] : []),
      `<p>Stimmt etwas nicht? Schreib uns an <a href="mailto:${getShopConfig().contactEmail}">${getShopConfig().contactEmail}</a>.</p>`,
      `<p>Liebe Grüsse<br>${escapeHtml(store)}</p>`,
    ].join("\n")
  )

  return { subject: `${store}: deine E-Mail-Adresse wurde korrigiert`, text, html }
}
