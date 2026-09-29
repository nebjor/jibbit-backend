import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { renderInviteEmail } from "../lib/invite-email"
import type { EmailContent } from "../lib/notify"
import { describeError, sendEmail } from "../lib/notify"

/**
 * Einladung für neue Admin-Benutzer, beim Anlegen und beim erneuten Senden.
 *
 * `invite.created` (`createInvitesWorkflow`) und `invite.resent`
 * (`refreshInviteTokensWorkflow`) tragen nur die ID der Einladung. Weder das
 * Token (ein Zugang zum Admin) noch die eingeladene Adresse dürfen ins Log.
 */

type InviteEvent = {
  id: string
}

interface InviteView {
  id: string
  email?: string | null
  token?: string | null
  accepted?: boolean | null
  expires_at?: unknown
}

const INVITE_FIELDS = ["id", "email", "token", "accepted", "expires_at"]

function expiryKey(value: unknown): string {
  const time = value instanceof Date ? value.getTime() : new Date(String(value ?? "")).getTime()
  return Number.isFinite(time) ? String(time) : "ohne-ablauf"
}

export default async function inviteCreatedHandler({
  event: { data, name },
  container,
}: SubscriberArgs<InviteEvent>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const inviteId = data?.id
  if (!inviteId) {
    logger.warn("[invite] Event ohne Einladungs-ID — nichts versendet.")
    return
  }

  let invite: InviteView | undefined
  try {
    const { data: invites } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: "invite",
      fields: INVITE_FIELDS,
      filters: { id: inviteId },
    })
    invite = invites[0] as unknown as InviteView | undefined
  } catch (err) {
    logger.error(`[invite] Einladung ${inviteId} nicht geladen: ${describeError(err)}`)
    return
  }
  if (!invite) {
    logger.error(`[invite] Einladung ${inviteId} nicht gefunden.`)
    return
  }
  if (invite.accepted) {
    logger.info(`[invite] Einladung ${inviteId} ist schon angenommen — nichts versendet.`)
    return
  }
  if (!invite.email || !invite.token) {
    logger.warn(`[invite] Einladung ${inviteId} ohne Empfänger oder Token — nichts versendet.`)
    return
  }

  let content: EmailContent
  try {
    content = renderInviteEmail({
      backendUrl: process.env.MEDUSA_BACKEND_URL,
      storeName: process.env.STORE_NAME || "jibbit",
      token: invite.token,
      expiresAt: invite.expires_at,
    })
  } catch (err) {
    logger.error(`[invite] Einladung ${inviteId} nicht gerendert: ${describeError(err)}`)
    return
  }

  await sendEmail(container, {
    to: invite.email,
    template: "admin-invite",
    content,
    trigger: name || "invite.created",
    resourceId: invite.id,
    data: { invite_id: invite.id },
    // Erneutes Senden erneuert Token und Ablaufdatum: Das Ablaufdatum im
    // Schlüssel lässt die neue Mail durch und sperrt nur das doppelte Event.
    // Das Token selbst gehört nicht in den Schlüssel, der steht in der Datenbank.
    idempotencyKey: `admin-invite:${invite.id}:${expiryKey(invite.expires_at)}`,
  })
}

export const config: SubscriberConfig = {
  event: ["invite.created", "invite.resent"],
}
