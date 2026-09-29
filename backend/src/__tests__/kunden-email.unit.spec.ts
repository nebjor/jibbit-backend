/**
 * «E-Mail-Adresse korrigieren» (src/lib/kunden-email.ts, Workflow
 * aendere-kunden-email).
 *
 * Was hier schiefgehen kann, erzeugt keinen Fehler, sondern einen stillen
 * Schaden: ein Konto, das die neue Adresse anzeigt und sich nur mit der alten
 * anmelden lässt; eine Versandbestätigung an die vertippte Adresse; eine
 * abgeschlossene Bestellung, deren Adresse nachträglich geändert wurde.
 *
 * Der Workflow läuft hier echt (Medusas Orchestrator, lokal im Speicher),
 * nur die Module sind Attrappen. So ist auch das Zurückrollen geprüft und
 * nicht bloss behauptet. Alle Namen und Adressen sind erfunden.
 */

import { ContainerRegistrationKeys, createMedusaContainer, Modules } from "@medusajs/framework/utils"
import { asValue } from "@medusajs/framework/awilix"

import {
  BESTELLUNG_MAX_ALTER_TAGE,
  type BestellungSicht,
  type KundenEmailLage,
  entscheideKundenEmail,
  ilikeMuster,
  istOffeneBestellung,
  normalisiereEmail,
  pruefeEmail,
  renderEmailKorrigiert,
  waehleBestellungen,
} from "../lib/kunden-email"
import {
  ladeKundenEmailLage,
  setzeBestellEmail,
  setzeBestellEmailZurueck,
  setzeLoginAdresse,
  setzeLoginAdresseZurueck,
} from "../lib/kunden-email-daten"
import { aendereKundenEmailWorkflow } from "../workflows/kunden-email/aendere-kunden-email"

const JETZT = new Date("2026-09-29T10:00:00Z").getTime()
const TAG = 24 * 60 * 60 * 1000

const ALT = "mia.muster@exampel.test"
const NEU = "mia.muster@example.test"

function bestellung(teil: Partial<BestellungSicht> & { id: string }): BestellungSicht {
  return {
    status: "pending",
    email: ALT,
    canceled_at: null,
    created_at: new Date(JETZT - 2 * TAG).toISOString(),
    items: [{ quantity: 2, detail: { quantity: 2, shipped_quantity: 0 } }],
    ...teil,
  }
}

function lage(teil: Partial<KundenEmailLage> = {}): KundenEmailLage {
  return {
    kunde: { id: "cus_mia", email: ALT, has_account: true, first_name: "Mia" },
    andere_kunden: [],
    identitaet: { id: "provid_mia", auth_identity_id: "authid_mia", entity_id: ALT },
    fremde_identitaet: null,
    bestellungen: [],
    ...teil,
  }
}

const mitBestellungen = { bestellungen_anpassen: true, jetzt: JETZT }

describe("normalisiereEmail und pruefeEmail", () => {
  it("trimmt und schreibt klein", () => {
    expect(normalisiereEmail("  Mia.Muster@Example.TEST \n")).toBe(NEU)
  })

  it("macht aus allem, was kein Text ist, eine leere Adresse", () => {
    expect(normalisiereEmail(undefined)).toBe("")
    expect(normalisiereEmail(null)).toBe("")
    expect(normalisiereEmail(42)).toBe("")
  })

  it("akzeptiert übliche Adressen", () => {
    for (const ok of [NEU, "a@b.ch", "vor.nach+shop@mail.example.test", "o'neil@example.test"]) {
      expect(pruefeEmail(ok)).toEqual([])
    }
  })

  it("lehnt leere, zu lange und kaputte Adressen mit deutscher Meldung ab", () => {
    expect(pruefeEmail("").join(" ")).toMatch(/Bitte eine E-Mail-Adresse/)
    expect(pruefeEmail(`${"a".repeat(250)}@example.test`).join(" ")).toMatch(/länger als 254/)
    for (const kaputt of [
      "mia.example.test",
      "mia@@example.test",
      "@example.test",
      "mia@",
      "mia@example",
      "mia@example..test",
      "mia@-example.test",
      "mia muster@example.test",
      "mia@example.test,lea@example.test",
      "<mia@example.test>",
      ".mia@example.test",
      "mia..muster@example.test",
      "mia@example.t",
    ]) {
      expect(pruefeEmail(kaputt)).toHaveLength(1)
    }
  })

  it("nimmt den Platzhaltern von LIKE ihre Wirkung", () => {
    // Sonst träfe «a_b@…» auch «axb@…» — und meldete einen Konflikt, den es nicht gibt.
    expect(ilikeMuster("a_b%c@example.test")).toBe("a\\_b\\%c@example.test")
  })
})

describe("istOffeneBestellung — welche Bestellungen die neue Adresse bekommen", () => {
  it("offen: nichts oder erst ein Teil versendet", () => {
    expect(istOffeneBestellung(bestellung({ id: "order_1" }), JETZT)).toBe(true)
    expect(
      istOffeneBestellung(
        bestellung({
          id: "order_2",
          items: [
            { detail: { quantity: 1, shipped_quantity: 1 } },
            { detail: { quantity: 3, shipped_quantity: 1 } },
          ],
        }),
        JETZT
      )
    ).toBe(true)
  })

  it("liest Mengen auch als Text und als BigNumber-Objekt", () => {
    expect(
      istOffeneBestellung(
        bestellung({
          id: "order_3",
          items: [{ detail: { quantity: { value: "2" }, shipped_quantity: "1" } }],
        }),
        JETZT
      )
    ).toBe(true)
  })

  it("nie: abgeschlossen, storniert, archiviert, Entwurf", () => {
    for (const status of ["completed", "canceled", "archived", "draft"]) {
      expect(istOffeneBestellung(bestellung({ id: "order_x", status }), JETZT)).toBe(false)
    }
    expect(
      istOffeneBestellung(bestellung({ id: "order_x", canceled_at: "2026-09-28T08:00:00Z" }), JETZT)
    ).toBe(false)
  })

  it("nie: alles versendet", () => {
    expect(
      istOffeneBestellung(
        bestellung({ id: "order_x", items: [{ detail: { quantity: 2, shipped_quantity: 2 } }] }),
        JETZT
      )
    ).toBe(false)
  })

  it(`nie: älter als ${BESTELLUNG_MAX_ALTER_TAGE} Tage, auch wenn unversendet`, () => {
    const alt = new Date(JETZT - (BESTELLUNG_MAX_ALTER_TAGE + 1) * TAG).toISOString()
    const knapp = new Date(JETZT - (BESTELLUNG_MAX_ALTER_TAGE - 1) * TAG).toISOString()
    expect(istOffeneBestellung(bestellung({ id: "order_x", created_at: alt }), JETZT)).toBe(false)
    expect(istOffeneBestellung(bestellung({ id: "order_y", created_at: knapp }), JETZT)).toBe(true)
  })

  it("im Zweifel nicht: ohne Datum oder ohne Artikel", () => {
    expect(istOffeneBestellung(bestellung({ id: "order_x", created_at: null }), JETZT)).toBe(false)
    expect(istOffeneBestellung(bestellung({ id: "order_x", created_at: "kein Datum" }), JETZT)).toBe(
      false
    )
    expect(istOffeneBestellung(bestellung({ id: "order_x", items: [] }), JETZT)).toBe(false)
    expect(istOffeneBestellung(bestellung({ id: "order_x", items: null }), JETZT)).toBe(false)
  })

  it("waehleBestellungen lässt aus, was die neue Adresse schon trägt", () => {
    expect(
      waehleBestellungen(
        [
          bestellung({ id: "order_offen" }),
          bestellung({ id: "order_schon_richtig", email: " Mia.Muster@Example.test" }),
          bestellung({ id: "order_fertig", status: "completed" }),
        ],
        NEU,
        JETZT
      )
    ).toEqual(["order_offen"])
  })
})

describe("entscheideKundenEmail", () => {
  it("Kunde mit Konto: Kundendatensatz und Anmeldung ändern sich zusammen", () => {
    const e = entscheideKundenEmail(lage(), `  ${NEU.toUpperCase()} `, mitBestellungen)
    expect(e).toEqual({
      ok: true,
      plan: {
        customer_id: "cus_mia",
        neu: NEU,
        hat_konto: true,
        hat_anmeldung: true,
        kunde_aendern: true,
        identitaet: { id: "provid_mia", alt: ALT },
        bestellung_ids: [],
        hinweise: [],
      },
    })
  })

  it("Gastkunde: nur der Kundendatensatz, keine Anmeldung", () => {
    const e = entscheideKundenEmail(
      lage({
        kunde: { id: "cus_gast", email: ALT, has_account: false },
        identitaet: null,
        bestellungen: [bestellung({ id: "order_1" })],
      }),
      NEU,
      mitBestellungen
    )
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.plan.identitaet).toBeNull()
    expect(e.plan.hat_anmeldung).toBe(false)
    expect(e.plan.kunde_aendern).toBe(true)
    expect(e.plan.bestellung_ids).toEqual(["order_1"])
    expect(e.plan.hinweise).toEqual([])
  })

  it("ungültige Adresse: Fehler, kein Plan", () => {
    const e = entscheideKundenEmail(lage(), "mia.example.test", mitBestellungen)
    expect(e).toEqual({ ok: false, fehler: expect.stringMatching(/genau ein @/) })
  })

  it("Konflikt: anderer Kunde mit derselben Adresse und demselben has_account", () => {
    const e = entscheideKundenEmail(
      lage({ andere_kunden: [{ id: "cus_lea", has_account: true }] }),
      NEU,
      mitBestellungen
    )
    expect(e.ok).toBe(false)
    if (e.ok) return
    expect(e.konflikt_kunde_id).toBe("cus_lea")
    expect(e.fehler).toMatch(/gehört bereits zu einem anderen Kunden mit Konto \(cus_lea\)/)
    expect(e.fehler).toMatch(/nichts geändert/)
    // Die Meldung landet im Admin UND über den Fehler im Log: keine Adresse darin.
    expect(e.fehler).not.toMatch(/@/)
  })

  it("Konflikt auch beim Gast: anderer Gast-Datensatz mit der Adresse", () => {
    const e = entscheideKundenEmail(
      lage({
        kunde: { id: "cus_gast", email: ALT, has_account: false },
        identitaet: null,
        andere_kunden: [{ id: "cus_gast_2", has_account: false }],
      }),
      NEU,
      mitBestellungen
    )
    expect(e).toMatchObject({ ok: false, konflikt_kunde_id: "cus_gast_2" })
  })

  it("kein Konflikt, aber Hinweis: anderer Datensatz mit ANDEREM has_account", () => {
    const e = entscheideKundenEmail(
      lage({
        kunde: { id: "cus_gast", email: ALT, has_account: false },
        identitaet: null,
        andere_kunden: [{ id: "cus_lea", has_account: true }],
        fremde_identitaet: { auth_identity_id: "authid_lea", customer_id: "cus_lea" },
      }),
      NEU,
      mitBestellungen
    )
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.plan.hinweise).toHaveLength(1)
    expect(e.plan.hinweise[0]).toMatch(/zweiten Kundendatensatz.*cus_lea, mit Konto/)
  })

  it("Konflikt: die Adresse ist schon die Anmeldung eines anderen Kunden", () => {
    const e = entscheideKundenEmail(
      lage({ fremde_identitaet: { auth_identity_id: "authid_lea", customer_id: "cus_lea" } }),
      NEU,
      mitBestellungen
    )
    expect(e).toMatchObject({ ok: false, konflikt_kunde_id: "cus_lea" })
    if (e.ok) return
    expect(e.fehler).toMatch(/bereits eine Anmeldung.*zum Kunden cus_lea/)
  })

  it("Konflikt: die Adresse ist die Anmeldung eines Admin-Benutzers", () => {
    // emailpass-Identitäten teilen sich Kundschaft und Admin-Benutzer;
    // der Unique-Index (entity_id, provider) gilt über beide.
    const e = entscheideKundenEmail(
      lage({ fremde_identitaet: { auth_identity_id: "authid_admin", customer_id: null } }),
      NEU,
      mitBestellungen
    )
    expect(e).toMatchObject({ ok: false, konflikt_kunde_id: null })
    if (e.ok) return
    expect(e.fehler).toMatch(/Admin-Benutzer/)
  })

  it("Konto ohne verknüpfte Anmeldung: Hinweis, Kundendatensatz wird geändert", () => {
    const e = entscheideKundenEmail(lage({ identitaet: null }), NEU, mitBestellungen)
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.plan.identitaet).toBeNull()
    expect(e.plan.hinweise.join(" ")).toMatch(/keine verknüpfte Anmeldung/)
  })

  it("Checkbox aus: keine Bestellung wird angefasst", () => {
    const e = entscheideKundenEmail(
      lage({ bestellungen: [bestellung({ id: "order_1" })] }),
      NEU,
      { bestellungen_anpassen: false, jetzt: JETZT }
    )
    expect(e).toMatchObject({ ok: true, plan: { bestellung_ids: [] } })
  })

  it("nichts zu ändern: Fehler statt leerem Speichern", () => {
    const e = entscheideKundenEmail(
      lage({
        kunde: { id: "cus_mia", email: NEU, has_account: true },
        identitaet: { id: "provid_mia", auth_identity_id: "authid_mia", entity_id: NEU },
      }),
      NEU,
      mitBestellungen
    )
    expect(e).toEqual({ ok: false, fehler: expect.stringMatching(/bereits hinterlegt/) })
  })

  it("holt nach, was fehlt: Kunde stimmt schon, Anmeldung und Bestellung noch nicht", () => {
    // Entsteht, wenn die Adresse früher nur am Kundendatensatz geändert wurde.
    const e = entscheideKundenEmail(
      lage({
        kunde: { id: "cus_mia", email: NEU, has_account: true },
        bestellungen: [bestellung({ id: "order_1" })],
      }),
      NEU,
      mitBestellungen
    )
    expect(e).toMatchObject({
      ok: true,
      plan: {
        kunde_aendern: false,
        identitaet: { id: "provid_mia", alt: ALT },
        bestellung_ids: ["order_1"],
      },
    })
  })
})

describe("renderEmailKorrigiert", () => {
  it("mit Anmeldung: nennt Konto, Anmeldung und Passwort — per du, ohne Adressen", () => {
    const mail = renderEmailKorrigiert({
      storeName: "jibbit",
      firstName: "Mia",
      mitAnmeldung: true,
      bestellungen: 1,
    })
    expect(mail.subject).toBe("jibbit: deine E-Mail-Adresse wurde korrigiert")
    expect(mail.text).toMatch(/^Hallo Mia\n/)
    expect(mail.text).toMatch(/deines Kontos/)
    expect(mail.text).toMatch(/Dein Passwort bleibt gleich/)
    expect(mail.text).toMatch(/deiner offenen Bestellung /)
    expect(mail.text).not.toMatch(/Sie |Ihre/)
    // Nur die Kontaktadresse, weder alte noch neue Kundenadresse.
    expect(mail.text.match(/\S+@\S+/g)).toEqual(["info@jibbit.ch."])
  })

  it("ohne Anmeldung und ohne Bestellung: kein Wort von Konto oder Versand", () => {
    const mail = renderEmailKorrigiert({
      storeName: "jibbit",
      firstName: " ",
      mitAnmeldung: false,
      bestellungen: 0,
    })
    expect(mail.text).toMatch(/^Hallo\n/)
    expect(mail.text).not.toMatch(/Konto|Passwort|Versandbestätigung/)
  })

  it("maskiert den Vornamen im HTML", () => {
    const mail = renderEmailKorrigiert({
      storeName: "jibbit",
      firstName: "<b>Mia</b>",
      mitAnmeldung: false,
      bestellungen: 0,
    })
    expect(mail.html).toContain("Hallo &lt;b&gt;Mia&lt;/b&gt;")
    expect(mail.html).not.toContain("<b>Mia</b>")
  })
})

// ─── Attrappen für die Module ─────────────────────────────────────────────

type Kunde = { id: string; email: string | null; has_account: boolean; first_name?: string | null }
type ProviderIdentity = {
  id: string
  entity_id: string
  provider: string
  auth_identity_id: string
  provider_metadata: Record<string, unknown>
}
type AuthIdentity = { id: string; app_metadata: Record<string, unknown> | null }
type Bestellung = BestellungSicht & { customer_id: string }

interface Welt {
  kunden: Kunde[]
  auth: AuthIdentity[]
  provider: ProviderIdentity[]
  bestellungen: Bestellung[]
  /** Name der Methode, die werfen soll. */
  kaputt?: "updateCustomers" | "updateProviderIdentities" | "updateOrders"
}

function ilike(muster: string, wert: string | null): boolean {
  if (wert == null) return false
  const regex = muster.replace(/\\(.)|([%_])|([.*+?^${}()|[\]\\])/g, (_m, wörtlich, platz, sonder) =>
    wörtlich !== undefined
      ? wörtlich.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : platz === "%"
        ? ".*"
        : platz === "_"
          ? "."
          : `\\${sonder}`
  )
  return new RegExp(`^${regex}$`, "i").test(wert)
}

function passt(filter: unknown, wert: string | null): boolean {
  if (filter === undefined) return true
  if (Array.isArray(filter)) return filter.includes(wert)
  if (filter && typeof filter === "object" && "$ilike" in filter) {
    return ilike((filter as { $ilike: string }).$ilike, wert)
  }
  return filter === wert
}

function baueContainer(welt: Welt) {
  const aufrufe: string[] = []
  const log: string[] = []
  const wirfWenn = (name: Welt["kaputt"]) => {
    aufrufe.push(name as string)
    if (welt.kaputt === name) {
      // Wie ein Datenbankfehler nur EINMAL: das Zurückrollen danach muss gelingen.
      welt.kaputt = undefined
      throw new Error(`${name} fehlgeschlagen`)
    }
  }

  const customerService = {
    async listCustomers(filter: { id?: string | string[]; email?: unknown }) {
      const ids = filter.id === undefined ? null : ([] as string[]).concat(filter.id)
      return welt.kunden
        .filter((k) => (!ids || ids.includes(k.id)) && passt(filter.email, k.email))
        .map((k) => ({ ...k }))
    },
    async updateCustomers(selector: string | { id: string }, update: Partial<Kunde>) {
      wirfWenn("updateCustomers")
      const id = typeof selector === "string" ? selector : selector.id
      const treffer = welt.kunden.filter((k) => k.id === id)
      for (const k of treffer) {
        for (const [feld, wert] of Object.entries(update)) {
          if (wert !== undefined) (k as Record<string, unknown>)[feld] = wert
        }
      }
      return typeof selector === "string" ? treffer[0] : treffer
    },
  }

  const authService = {
    async listAuthIdentities(filter: { id?: string[]; app_metadata?: Record<string, unknown> }) {
      return welt.auth
        .filter(
          (a) =>
            (!filter.id || filter.id.includes(a.id)) &&
            Object.entries(filter.app_metadata ?? {}).every(
              ([k, v]) => a.app_metadata?.[k] === v
            )
        )
        .map((a) => ({
          ...a,
          provider_identities: welt.provider
            .filter((p) => p.auth_identity_id === a.id)
            .map((p) => ({ ...p })),
        }))
    },
    async listProviderIdentities(filter: { id?: string[]; entity_id?: unknown; provider?: string }) {
      return welt.provider
        .filter(
          (p) =>
            (!filter.id || filter.id.includes(p.id)) &&
            passt(filter.entity_id, p.entity_id) &&
            (!filter.provider || filter.provider === p.provider)
        )
        .map((p) => ({ ...p }))
    },
    async updateProviderIdentities(daten: Array<Partial<ProviderIdentity> & { id: string }>) {
      wirfWenn("updateProviderIdentities")
      for (const d of daten) {
        const ziel = welt.provider.find((p) => p.id === d.id)
        if (!ziel) throw new Error("nicht gefunden")
        const belegt = welt.provider.some(
          (p) => p.id !== d.id && p.provider === ziel.provider && p.entity_id === d.entity_id
        )
        if (belegt) throw new Error("IDX_provider_identity_provider_entity_id")
        Object.assign(ziel, d)
      }
      return daten
    },
  }

  const orderService = {
    async listOrders(filter: { id: string[] }) {
      return welt.bestellungen
        .filter((b) => filter.id.includes(b.id))
        .map((b) => ({ id: b.id, email: b.email }))
    },
    async updateOrders(daten: Array<{ id: string; email: string }>) {
      wirfWenn("updateOrders")
      for (const d of daten) {
        const ziel = welt.bestellungen.find((b) => b.id === d.id)
        if (ziel) ziel.email = d.email
      }
      return daten
    },
  }

  const query = {
    async graph({ entity, filters }: { entity: string; filters: Record<string, string> }) {
      if (entity === "order") {
        return {
          data: welt.bestellungen
            .filter((b) => b.customer_id === filters.customer_id)
            .map((b) => ({ ...b })),
        }
      }
      return { data: [] }
    },
  }

  const logger = {
    info: (m: string) => log.push(m),
    warn: (m: string) => log.push(m),
    error: (m: string) => log.push(m),
    debug: (m: string) => log.push(m),
  }

  // updateCustomersWorkflow meldet `customer.updated`; ein Fehlschlag nimmt
  // die gesammelten Events wieder zurück.
  const events: string[] = []
  const eventBus = {
    async emit(nachrichten: Array<{ name: string }>) {
      events.push(...nachrichten.map((n) => n.name))
    },
    async releaseGroupedEvents() {},
    async clearGroupedEvents() {
      events.length = 0
    },
  }

  const container = createMedusaContainer()
  container.register({
    [Modules.EVENT_BUS]: asValue(eventBus),
    [Modules.CUSTOMER]: asValue(customerService),
    [Modules.AUTH]: asValue(authService),
    [Modules.ORDER]: asValue(orderService),
    [ContainerRegistrationKeys.QUERY]: asValue(query),
    [ContainerRegistrationKeys.LOGGER]: asValue(logger),
  })
  return { container, aufrufe, log, events }
}

const HASH = "c2NyeXB0LWhhc2gtZXJmdW5kZW4="

function welt(teil: Partial<Welt> = {}): Welt {
  return {
    kunden: [
      { id: "cus_mia", email: ALT, has_account: true, first_name: "Mia" },
      { id: "cus_gast", email: "jonas.beispiel@exampel.test", has_account: false },
    ],
    auth: [{ id: "authid_mia", app_metadata: { customer_id: "cus_mia" } }],
    provider: [
      {
        id: "provid_mia",
        entity_id: ALT,
        provider: "emailpass",
        auth_identity_id: "authid_mia",
        provider_metadata: { password: HASH },
      },
    ],
    bestellungen: [
      { ...bestellung({ id: "order_offen" }), customer_id: "cus_mia" },
      { ...bestellung({ id: "order_fertig", status: "completed" }), customer_id: "cus_mia" },
      { ...bestellung({ id: "order_storniert", status: "canceled" }), customer_id: "cus_mia" },
      {
        ...bestellung({
          id: "order_versendet",
          items: [{ detail: { quantity: 1, shipped_quantity: 1 } }],
        }),
        customer_id: "cus_mia",
      },
      {
        ...bestellung({ id: "order_gast", email: "jonas.beispiel@exampel.test" }),
        customer_id: "cus_gast",
      },
    ],
    ...teil,
  }
}

const schnappschuss = (w: Welt) =>
  JSON.parse(
    JSON.stringify({
      kunden: w.kunden,
      auth: w.auth,
      provider: w.provider,
      bestellungen: w.bestellungen,
    })
  )

describe("ladeKundenEmailLage", () => {
  it("findet die Anmeldung über die Verknüpfung, nicht über die Adresse", async () => {
    const w = welt()
    // Anmeldung und Kundendatensatz laufen schon auseinander.
    w.provider[0].entity_id = "mia.alt@example.test"
    const { container } = baueContainer(w)
    const l = await ladeKundenEmailLage(container as any, "cus_mia", NEU)
    expect(l.identitaet).toEqual({
      id: "provid_mia",
      auth_identity_id: "authid_mia",
      entity_id: "mia.alt@example.test",
    })
    expect(l.bestellungen.map((b) => b.id)).toEqual([
      "order_offen",
      "order_fertig",
      "order_storniert",
      "order_versendet",
    ])
  })

  it("findet andere Kunden auch bei anderer Gross-/Kleinschreibung — aber nicht über Platzhalter", async () => {
    const w = welt()
    w.kunden.push({ id: "cus_lea", email: "Mia.Muster@Example.test", has_account: true })
    w.kunden.push({ id: "cus_fast", email: "miaxmuster@example.test", has_account: true })
    const { container } = baueContainer(w)
    const l = await ladeKundenEmailLage(container as any, "cus_mia", NEU)
    expect(l.andere_kunden).toEqual([{ id: "cus_lea", has_account: true }])
  })

  it("meldet eine fremde Anmeldung mit ihrem Kunden; die eigene ist keine fremde", async () => {
    const w = welt()
    w.auth.push({ id: "authid_lea", app_metadata: { customer_id: "cus_lea" } })
    w.provider.push({
      id: "provid_lea",
      entity_id: NEU,
      provider: "emailpass",
      auth_identity_id: "authid_lea",
      provider_metadata: {},
    })
    const { container } = baueContainer(w)
    expect((await ladeKundenEmailLage(container as any, "cus_mia", NEU)).fremde_identitaet).toEqual({
      auth_identity_id: "authid_lea",
      customer_id: "cus_lea",
    })
    expect(
      (await ladeKundenEmailLage(container as any, "cus_mia", ALT)).fremde_identitaet
    ).toBeNull()
  })

  it("wirft NOT_FOUND mit deutscher Meldung, wenn es den Kunden nicht gibt", async () => {
    const { container } = baueContainer(welt())
    await expect(ladeKundenEmailLage(container as any, "cus_fehlt", NEU)).rejects.toMatchObject({
      type: "not_found",
      message: "Kunde cus_fehlt nicht gefunden.",
    })
  })
})

describe("Schreiben und Zurückrollen, einzeln", () => {
  it("Anmeldung: schreibt nur entity_id; Hash und Verknüpfung bleiben", async () => {
    const w = welt()
    const { container } = baueContainer(w)
    const vorher = await setzeLoginAdresse(container as any, { id: "provid_mia", neu: NEU })
    expect(vorher).toEqual({ id: "provid_mia", entity_id: ALT })
    expect(w.provider[0]).toEqual({
      id: "provid_mia",
      entity_id: NEU,
      provider: "emailpass",
      auth_identity_id: "authid_mia",
      provider_metadata: { password: HASH },
    })
    expect(w.auth[0].app_metadata).toEqual({ customer_id: "cus_mia" })

    await setzeLoginAdresseZurueck(container as any, vorher)
    expect(w.provider[0].entity_id).toBe(ALT)
    expect(w.provider[0].provider_metadata).toEqual({ password: HASH })
  })

  it("Anmeldung: fasst keinen anderen Provider an", async () => {
    const w = welt()
    w.provider[0].provider = "google"
    const { container, aufrufe } = baueContainer(w)
    await expect(
      setzeLoginAdresse(container as any, { id: "provid_mia", neu: NEU })
    ).rejects.toThrow(/nicht gefunden/)
    expect(aufrufe).toEqual([])
  })

  it("Bestellungen: merkt sich die alte Adresse je Bestellung und stellt sie wieder her", async () => {
    const w = welt()
    w.bestellungen[0].email = "andere.adresse@example.test"
    const { container } = baueContainer(w)
    const vorher = await setzeBestellEmail(container as any, {
      ids: ["order_offen", "order_versendet"],
      neu: NEU,
    })
    expect(w.bestellungen.map((b) => b.email)).toEqual([
      NEU,
      ALT,
      ALT,
      NEU,
      "jonas.beispiel@exampel.test",
    ])
    await setzeBestellEmailZurueck(container as any, vorher)
    expect(w.bestellungen.map((b) => b.email)).toEqual([
      "andere.adresse@example.test",
      ALT,
      ALT,
      ALT,
      "jonas.beispiel@exampel.test",
    ])
  })

  it("ohne Bestellungen und ohne Vorher-Stand passiert nichts", async () => {
    const { container, aufrufe } = baueContainer(welt())
    expect(await setzeBestellEmail(container as any, { ids: [], neu: NEU })).toEqual([])
    await setzeBestellEmailZurueck(container as any, undefined)
    await setzeLoginAdresseZurueck(container as any, undefined)
    expect(aufrufe).toEqual([])
  })
})

describe("aendereKundenEmailWorkflow", () => {
  const lauf = (container: unknown, input: Record<string, unknown>) =>
    aendereKundenEmailWorkflow(container as any).run({
      input: { bestellungen_anpassen: true, ...input } as any,
      throwOnError: false,
    })

  it("Kunde mit Konto: Kunde, Anmeldung und nur die offene Bestellung", async () => {
    const w = welt()
    const { container, log } = baueContainer(w)
    const { errors, result } = await lauf(container, { customer_id: "cus_mia", email: ` ${NEU} ` })

    expect(errors).toEqual([])
    expect(result).toMatchObject({
      neu: NEU,
      kunde_aendern: true,
      identitaet: { id: "provid_mia" },
      bestellung_ids: ["order_offen"],
    })
    expect(w.kunden[0].email).toBe(NEU)
    expect(w.provider[0]).toMatchObject({
      entity_id: NEU,
      auth_identity_id: "authid_mia",
      provider_metadata: { password: HASH },
    })
    expect(w.auth[0].app_metadata).toEqual({ customer_id: "cus_mia" })
    expect(Object.fromEntries(w.bestellungen.map((b) => [b.id, b.email]))).toEqual({
      order_offen: NEU,
      order_fertig: ALT,
      order_storniert: ALT,
      order_versendet: ALT,
      order_gast: "jonas.beispiel@exampel.test",
    })
    expect(log.join("\n")).not.toMatch(/@/)
  })

  it("Gastkunde: keine Anmeldung wird angefasst", async () => {
    const w = welt()
    const { container, aufrufe } = baueContainer(w)
    const { errors } = await lauf(container, {
      customer_id: "cus_gast",
      email: "jonas.beispiel@example.test",
    })
    expect(errors).toEqual([])
    expect(w.kunden[1].email).toBe("jonas.beispiel@example.test")
    expect(w.bestellungen[4].email).toBe("jonas.beispiel@example.test")
    expect(w.provider[0].entity_id).toBe(ALT)
    expect(aufrufe).toEqual(["updateCustomers", "updateOrders"])
  })

  it("Checkbox aus: Bestellungen bleiben", async () => {
    const w = welt()
    const { container, aufrufe } = baueContainer(w)
    await lauf(container, { customer_id: "cus_mia", email: NEU, bestellungen_anpassen: false })
    expect(w.bestellungen[0].email).toBe(ALT)
    expect(aufrufe).toEqual(["updateCustomers", "updateProviderIdentities"])
  })

  it("Konflikt: nichts wird geschrieben, die Meldung nennt den anderen Kunden", async () => {
    const w = welt()
    w.kunden.push({ id: "cus_lea", email: NEU, has_account: true })
    const vorher = schnappschuss(w)
    const { container, aufrufe } = baueContainer(w)
    const { errors } = await lauf(container, { customer_id: "cus_mia", email: NEU })

    expect(errors).toHaveLength(1)
    expect(errors[0].error.message).toMatch(/anderen Kunden mit Konto \(cus_lea\)/)
    expect(aufrufe).toEqual([])
    expect(schnappschuss(w)).toEqual(vorher)
  })

  it.each(["updateProviderIdentities", "updateOrders"] as const)(
    "scheitert %s, ist danach alles wie vorher",
    async (kaputt) => {
      const w = welt({ kaputt })
      const vorher = schnappschuss(w)
      const { container, aufrufe } = baueContainer(w)
      const { errors } = await lauf(container, { customer_id: "cus_mia", email: NEU })

      expect(errors).toHaveLength(1)
      expect(errors[0].error.message).toBe(`${kaputt} fehlgeschlagen`)
      // Geschrieben wurde — und wieder zurückgenommen.
      expect(aufrufe.filter((a) => a === "updateCustomers")).toHaveLength(2)
      expect(schnappschuss(w)).toEqual(vorher)
    }
  )

  it("scheitert schon der Kundendatensatz, wird gar nichts weiter versucht", async () => {
    const w = welt({ kaputt: "updateCustomers" })
    const vorher = schnappschuss(w)
    const { container, aufrufe } = baueContainer(w)
    const { errors } = await lauf(container, { customer_id: "cus_mia", email: NEU })
    expect(errors).toHaveLength(1)
    expect(aufrufe).toEqual(["updateCustomers"])
    expect(schnappschuss(w)).toEqual(vorher)
  })
})
