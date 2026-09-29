/**
 * Lesen und Schreiben für «E-Mail-Adresse korrigieren». Die Regeln stehen in
 * `kunden-email.ts`; hier steht nur, was einen Container braucht.
 *
 * Die Schreibfunktionen geben zurück, was für das Zurückrollen nötig ist, und
 * haben je ein Gegenstück `…Zurueck`. Die Workflow-Steps sind dünne Hüllen
 * darum — so lässt sich das Zurückrollen ohne Workflow-Engine testen.
 */

import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"

import {
  type BestellungSicht,
  EMAILPASS,
  type FremdeIdentitaet,
  type IdentitaetSicht,
  type KundenEmailLage,
  ilikeMuster,
  normalisiereEmail,
} from "./kunden-email"

const BESTELL_FELDER = [
  "id",
  "status",
  "email",
  "canceled_at",
  "created_at",
  "items.id",
  "items.quantity",
  "items.detail.quantity",
  "items.detail.shipped_quantity",
]

type ProviderIdentityZeile = {
  id: string
  entity_id: string
  provider: string
  auth_identity_id?: string | null
}

/**
 * Liest den Kunden und alles, woran die neue Adresse scheitern kann.
 * `neu` muss bereits normalisiert sein.
 */
export async function ladeKundenEmailLage(
  container: MedusaContainer,
  customerId: string,
  neu: string
): Promise<KundenEmailLage> {
  const customerService = container.resolve(Modules.CUSTOMER)
  const authService = container.resolve(Modules.AUTH)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const [kunde] = await customerService.listCustomers(
    { id: [customerId] },
    { select: ["id", "email", "has_account", "first_name"], take: 1 }
  )
  if (!kunde) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Kunde ${customerId} nicht gefunden.`)
  }

  // Gross-/Kleinschreibung: der Unique-Index vergleicht genau, ältere
  // Datensätze können aber gemischt geschrieben sein. `$ilike` findet sie,
  // der Vergleich danach entscheidet.
  const muster = neu ? ilikeMuster(neu) : null
  const gleicheAdresse = muster
    ? await customerService.listCustomers(
        { email: { $ilike: muster } } as any,
        { select: ["id", "email", "has_account"], take: 50 }
      )
    : []
  const andereKunden = gleicheAdresse
    .filter((k) => k.id !== kunde.id && normalisiereEmail(k.email) === neu)
    .map((k) => ({ id: k.id, has_account: Boolean(k.has_account) }))

  // Die Anmeldung dieses Kunden: über die Verknüpfung gesucht, nicht über die
  // Adresse — die Adresse ist ja gerade das, was falsch sein kann.
  const authIdentities = await authService.listAuthIdentities(
    { app_metadata: { customer_id: kunde.id } },
    { relations: ["provider_identities"], take: 10 }
  )
  let identitaet: IdentitaetSicht | null = null
  for (const auth of authIdentities) {
    // Der JSON-Filter ist ein Enthaltensein-Vergleich; hier noch einmal genau.
    if ((auth.app_metadata as Record<string, unknown> | null)?.customer_id !== kunde.id) continue
    const pi = (auth.provider_identities ?? []).find((p) => p.provider === EMAILPASS)
    if (pi?.id && pi.entity_id) {
      identitaet = { id: pi.id, auth_identity_id: auth.id, entity_id: pi.entity_id }
      break
    }
  }

  let fremdeIdentitaet: FremdeIdentitaet | null = null
  if (muster) {
    const treffer = (await authService.listProviderIdentities(
      { entity_id: { $ilike: muster }, provider: EMAILPASS } as any,
      { select: ["id", "entity_id", "provider", "auth_identity_id"], take: 50 }
    )) as unknown as ProviderIdentityZeile[]
    const fremd = treffer.find(
      (p) => p.id !== identitaet?.id && normalisiereEmail(p.entity_id) === neu
    )
    if (fremd?.auth_identity_id) {
      const [auth] = await authService.listAuthIdentities(
        { id: [fremd.auth_identity_id] },
        { select: ["id", "app_metadata"], take: 1 }
      )
      const besitzer = (auth?.app_metadata as Record<string, unknown> | null)?.customer_id
      // Dieselbe Person, zweite Zeile derselben Anmeldung: kein Konflikt.
      if (besitzer !== kunde.id) {
        fremdeIdentitaet = {
          auth_identity_id: fremd.auth_identity_id,
          customer_id: typeof besitzer === "string" ? besitzer : null,
        }
      }
    }
  }

  const { data: bestellungen } = await query.graph({
    entity: "order",
    fields: BESTELL_FELDER,
    filters: { customer_id: kunde.id },
  })

  return {
    kunde: {
      id: kunde.id,
      email: kunde.email,
      has_account: kunde.has_account,
      first_name: kunde.first_name,
    },
    andere_kunden: andereKunden,
    identitaet,
    fremde_identitaet: fremdeIdentitaet,
    bestellungen: bestellungen as unknown as BestellungSicht[],
  }
}

// ─── Anmeldung ────────────────────────────────────────────────────────────

export interface LoginAdresseInput {
  /** ID der `provider_identity`-Zeile. */
  id: string
  neu: string
}

export interface LoginAdresseVorher {
  id: string
  entity_id: string
}

/**
 * Schreibt NUR `entity_id`. `provider_metadata` (der Passwort-Hash) und
 * `auth_identity.app_metadata` (die Verknüpfung zum Kunden) werden nicht
 * mitgegeben und bleiben, wie sie sind.
 */
export async function setzeLoginAdresse(
  container: MedusaContainer,
  input: LoginAdresseInput
): Promise<LoginAdresseVorher> {
  const authService = container.resolve(Modules.AUTH)
  const [vorher] = (await authService.listProviderIdentities(
    { id: [input.id] },
    { select: ["id", "entity_id", "provider"], take: 1 }
  )) as unknown as ProviderIdentityZeile[]
  if (!vorher || vorher.provider !== EMAILPASS) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "Die Anmeldung dieses Kunden wurde nicht gefunden. Es wurde nichts geändert."
    )
  }
  await authService.updateProviderIdentities([{ id: input.id, entity_id: input.neu }])
  return { id: vorher.id, entity_id: vorher.entity_id }
}

export async function setzeLoginAdresseZurueck(
  container: MedusaContainer,
  vorher: LoginAdresseVorher | undefined
): Promise<void> {
  if (!vorher?.id) return
  await container
    .resolve(Modules.AUTH)
    .updateProviderIdentities([{ id: vorher.id, entity_id: vorher.entity_id }])
}

// ─── Bestellungen ─────────────────────────────────────────────────────────

export interface BestellEmailInput {
  ids: string[]
  neu: string
}

export type BestellEmailVorher = Array<{ id: string; email: string | null }>

export async function setzeBestellEmail(
  container: MedusaContainer,
  input: BestellEmailInput
): Promise<BestellEmailVorher> {
  if (!input.ids.length) return []
  const orderService = container.resolve(Modules.ORDER)
  const vorher = await orderService.listOrders(
    { id: input.ids },
    { select: ["id", "email"], take: input.ids.length }
  )
  await orderService.updateOrders(vorher.map((o) => ({ id: o.id, email: input.neu })))
  return vorher.map((o) => ({ id: o.id, email: o.email ?? null }))
}

export async function setzeBestellEmailZurueck(
  container: MedusaContainer,
  vorher: BestellEmailVorher | undefined
): Promise<void> {
  if (!vorher?.length) return
  await container
    .resolve(Modules.ORDER)
    .updateOrders(vorher.map((o) => ({ id: o.id, email: o.email as string })))
}
