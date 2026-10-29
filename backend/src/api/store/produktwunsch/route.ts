import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { clientKey } from "../../../lib/client-key"
import { sendEmail, sendPush } from "../../../lib/notify"
import { orderNotificationRecipients } from "../../../lib/order-notification"
import {
  PRODUKTWUNSCH_TEMPLATE,
  renderProduktwunsch,
  renderProduktwunschPush,
} from "../../../lib/produktwunsch"
import { createRateLimiter } from "../../../lib/rate-limit"
import { PostProduktwunschBody } from "./validators"

/**
 * POST /store/produktwunsch — Produktwunsch eines Besuchers an den Betreiber.
 *
 * Antwort 204 ohne Inhalt. Schutz vor Missbrauch: höchstens 5 Wünsche pro
 * Stunde und Adresse, dazu eine Obergrenze für alle zusammen. Beide Zähler
 * liegen im Arbeitsspeicher und lehnen ab, wenn keine Adresse erkennbar ist.
 *
 * Datenschutz: Wunschtext und E-Mail-Adresse stehen nie im Log.
 */

const PRO_ADRESSE = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 })
const INSGESAMT = createRateLimiter({ max: 60, windowMs: 60 * 60 * 1000, maxKeys: 1 })

export async function POST(req: MedusaRequest<PostProduktwunschBody>, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as {
    info(msg: string): void
    error(msg: string): void
  }

  const einzeln = PRO_ADRESSE.check(clientKey(req))
  const gesamt = einzeln.allowed ? INSGESAMT.check("alle") : einzeln
  if (!gesamt.allowed) {
    res.setHeader("Retry-After", String(gesamt.retryAfterSeconds))
    res.status(429).json({ message: "Zu viele Wünsche. Bitte versuche es später noch einmal." })
    return
  }

  const wunsch = (req as unknown as { validatedBody: PostProduktwunschBody }).validatedBody
  const content = renderProduktwunsch(wunsch)
  const empfaenger = orderNotificationRecipients(process.env.ORDER_NOTIFICATION_TO)

  const mails = await Promise.all(
    empfaenger.map((to) =>
      sendEmail(req.scope, {
        to,
        template: PRODUKTWUNSCH_TEMPLATE,
        content,
        trigger: "produktwunsch",
      })
    )
  )
  // Push ist Beiwerk: sein Ausbleiben macht den Wunsch nicht ungültig.
  await sendPush(req.scope.resolve(ContainerRegistrationKeys.LOGGER), process.env.NTFY_URL, renderProduktwunschPush(wunsch)).catch(
    () => false
  )

  if (!mails.some(Boolean)) {
    logger.error("[produktwunsch] nicht versendet")
    res.status(502).json({ message: "Der Wunsch konnte gerade nicht zugestellt werden." })
    return
  }
  logger.info("[produktwunsch] gesendet")
  res.status(204).end()
}
