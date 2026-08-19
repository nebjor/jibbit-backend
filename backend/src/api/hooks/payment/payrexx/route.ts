/**
 * Payrexx-Webhook-Endpunkt.
 *
 *   POST /hooks/payment/payrexx
 *
 * Das ist die URL, die im Payrexx-Backend als Webhook zu hinterlegen ist
 * (siehe docs/payrexx-go-live.md). Der Caddyfile-Block `/hooks/payment/*`
 * reicht sie ohne Rate-Limit durch.
 *
 * ─── Warum eine eigene Route neben Medusas eingebauter? ────────────────────
 *
 * Medusa bringt `POST /hooks/payment/:provider` mit. Die funktioniert auch —
 * die passende URL wäre `/hooks/payment/payrexx_payrexx`, weil Medusa intern
 * `pp_${provider}` bildet und der Provider als `pp_payrexx_payrexx`
 * registriert ist (identifier + id aus medusa-config.ts). Sie hat aber drei
 * Eigenschaften, die für echtes Geld unbrauchbar sind:
 *
 * 1. Sie antwortet IMMER 200 — auch auf eine gefälschte Signatur. Payrexx
 *    erfährt nie, dass etwas nicht stimmt, und wir sehen es nur im Log.
 * 2. Sie verarbeitet asynchron über den Event-Bus mit 5 s Verzögerung. Ohne
 *    Redis-Event-Bus (dieses Projekt läuft mit dem In-Memory-Default) liegt
 *    das Ereignis so lange NUR im Prozessspeicher. Ein Neustart in diesem
 *    Fenster verliert eine bereits bezahlte Bestellung — und Payrexx hat
 *    schon 200 bekommen, wiederholt also nicht.
 * 3. Scheitert die Verarbeitung, merkt der Aufrufer nichts.
 *
 * Diese Route verarbeitet synchron und antwortet ehrlich:
 *   401 — Signatur ungültig (Payrexx soll das gar nicht erst wiederholen)
 *   400 — Body unbrauchbar
 *   200 — verarbeitet, Duplikat, oder bewusst ignoriert
 *   500 — vorübergehend gescheitert; Payrexx soll es WIEDERHOLEN
 *
 * Die Routen-Registrierung gewinnt gegen Medusas `:provider`-Route, weil der
 * Framework-Router statische Segmente vor Parameter-Segmenten einhängt
 * (RoutesSorter, orderBy ["global","wildcard","regex","static","params"]).
 *
 * Der Rohkörper wird für die Signaturprüfung gebraucht — `preserveRawBody`
 * ist dafür in src/api/middlewares.ts für genau diesen Pfad gesetzt.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import { completePayrexxPayment } from "../../../../modules/payrexx/complete-payment"
import {
  getPayrexxRuntime,
  type PayrexxRuntime,
} from "../../../../modules/payrexx/runtime"

/** Aktionen, für die es überhaupt etwas zu tun gibt. */
const ACTIONABLE = new Set(["authorized", "captured"])

export async function handlePayrexxWebhook(
  req: MedusaRequest,
  res: MedusaResponse,
  runtime: PayrexxRuntime,
  logger: Logger
): Promise<void> {
  if (!runtime.configured) {
    logger.error(
      "Payrexx webhook received but the provider is not configured " +
        "(PAYREXX_INSTANCE / PAYREXX_API_SECRET / PAYREXX_WEBHOOK_SECRET missing)."
    )
    res.status(503).json({ message: "Payrexx is not configured." })
    return
  }

  const rawBody = (req as unknown as { rawBody?: unknown }).rawBody ?? req.body

  const evaluation = await runtime.processor.evaluateRaw(
    rawBody,
    req.headers as unknown as Record<string, unknown>
  )

  if (evaluation.status === "invalid_signature") {
    // 401 statt 200: eine ungültige Signatur ist kein vorübergehendes
    // Problem. Payrexx soll sie nicht wiederholen, und ein Angreifer soll
    // kein 200 als Bestätigung bekommen.
    res.status(401).json({ message: "Invalid webhook signature." })
    return
  }

  if (evaluation.status === "malformed") {
    logger.warn(`Payrexx webhook rejected: ${evaluation.reason}`)
    res.status(400).json({ message: `Malformed webhook: ${evaluation.reason}` })
    return
  }

  if (evaluation.status === "duplicate") {
    // Bereits verarbeitet — entweder ein Payrexx-Retry oder die
    // Rückkehr-Route war schneller. 200, damit Payrexx aufhört.
    res.status(200).json({ status: "duplicate" })
    return
  }

  const { action } = evaluation.action

  if (!ACTIONABLE.has(action) || !evaluation.action.data?.session_id) {
    res.status(200).json({ status: action })
    return
  }

  try {
    await completePayrexxPayment(req.scope, evaluation.action)
  } catch (err) {
    // Der häufigste Grund ist ein Rennen: Payrexx meldet die Zahlung, bevor
    // Medusa die Payment Session / den Cart geschrieben hat. Deshalb die
    // Reservierung wieder freigeben und 500 antworten — Payrexx wiederholt,
    // und der zweite Anlauf findet die Session vor. Ohne das Freigeben
    // würde der Retry als Duplikat verworfen und die Zahlung wäre verloren.
    if (evaluation.idempotencyKey) {
      await runtime.processor.release(evaluation.idempotencyKey)
    }
    logger.error(
      `Payrexx webhook processing failed for session ` +
        `${String(evaluation.action.data.session_id)}: ${String(err)}. ` +
        `Answering 500 so Payrexx retries.`
    )
    res.status(500).json({ message: "Webhook processing failed, please retry." })
    return
  }

  res.status(200).json({ status: action })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  await handlePayrexxWebhook(req, res, getPayrexxRuntime(logger), logger)
}
