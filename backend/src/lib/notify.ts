import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Versand von E-Mails und Push-Nachrichten, der NIE wirft.
 *
 * Eine Benachrichtigung ist Beiwerk: eine Bestellung oder ein Reset-Request
 * darf nicht scheitern, weil der Mailserver klemmt. Fehler landen im Log —
 * ohne E-Mail-Adressen (Personendaten) und ohne Inhalt (Reset-Token).
 */

export interface EmailContent {
  subject: string
  text: string
  html: string
}

export interface EmailMessage {
  to: string
  template: string
  content: EmailContent
  trigger: string
  resourceId?: string
  /** Wird in der Datenbank gespeichert — nur Unkritisches, niemals Tokens. */
  data?: Record<string, unknown>
  /**
   * Schutz vor Doppelversand: Gibt es zu diesem Schlüssel schon eine
   * erfolgreich versendete Notification, verschickt das Notification-Modul
   * keine zweite. Fehlgeschlagene Versuche sperren nicht.
   */
  idempotencyKey?: string
}

export interface PushMessage {
  title: string
  message: string
  click?: string
  tags?: string
}

export const PUSH_TIMEOUT_MS = 10_000

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unbekannter Fehler"
  const message = err.message.replace(/[^\s@<>"',;:]+@[^\s@<>"',;:]+/g, "<adresse>")
  return `${err.name}: ${message}`.replace(/\s+/g, " ").trim()
}

export async function sendEmail(
  container: MedusaContainer,
  { to, template, content, trigger, resourceId, data, idempotencyKey }: EmailMessage
): Promise<boolean> {
  const logger: Logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    await container.resolve(Modules.NOTIFICATION).createNotifications({
      to,
      channel: "email",
      template,
      trigger_type: trigger,
      resource_id: resourceId,
      data,
      content,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    })
    return true
  } catch (err) {
    logger.error(`[notify] E-Mail "${template}" nicht versendet: ${describeError(err)}`)
    return false
  }
}

/** Push über ntfy: ein POST auf die Topic-URL, Titel und Link als Header. */
export async function sendPush(
  logger: Logger,
  topicUrl: string | undefined,
  { title, message, click, tags }: PushMessage
): Promise<boolean> {
  if (!topicUrl?.trim()) return false
  try {
    const res = await fetch(topicUrl.trim(), {
      method: "POST",
      body: message,
      headers: {
        Title: title,
        ...(click ? { Click: click } : {}),
        ...(tags ? { Tags: tags } : {}),
      },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.error(`[notify] Push nicht versendet: ntfy antwortet ${res.status}.`)
      return false
    }
    return true
  } catch (err) {
    logger.error(`[notify] Push nicht versendet: ${describeError(err)}`)
    return false
  }
}
