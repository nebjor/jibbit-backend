/**
 * Rückkehr-Abgleich nach der Zahlung auf der Payrexx-Seite.
 *
 *   POST /store/payrexx/return
 *   Body: { "payment_session_id": "payses_..." }
 *
 * Die Storefront ruft das auf, sobald der Kunde von Payrexx zurückkommt.
 * `initiatePayment()` hängt `?payment_session_id=...` an alle drei
 * Rückkehr-URLs (success/failed/cancel), die Storefront muss den Wert also
 * nur aus der Query lesen und hierher weiterreichen.
 *
 * ─── Warum das nötig ist, obwohl es einen Webhook gibt ─────────────────────
 *
 * Webhook und Rückkehr sind zwei unabhängige Kanäle, und BEIDE können
 * ausfallen:
 *
 * - Der Kunde erreicht die Rückkehrseite nie (schliesst die TWINT-App,
 *   verliert das Netz, bricht ab). Dann trägt der Webhook allein — die
 *   Bestellung entsteht trotzdem, weil processPaymentWorkflow den Cart
 *   abschliesst.
 * - Payrexx' Webhook kommt gar nicht oder verspätet (Ausfall bei uns,
 *   Fehlkonfiguration der Webhook-URL, Netzwerkproblem). Dann trägt diese
 *   Route allein: sie fragt den Stand aktiv bei Payrexx ab.
 *
 * Damit beide Wege garantiert dasselbe Ergebnis liefern, gehen sie durch
 * denselben `PayrexxWebhookProcessor.evaluateTransaction()` — dieselbe
 * Status-Tabelle, derselbe Betragsabgleich, derselbe Idempotency-Key. Wer
 * zuerst kommt, verarbeitet; der andere sieht ein Duplikat.
 *
 * Der gemeldete Status stammt IMMER aus einer frischen Payrexx-Abfrage, nie
 * aus dem, was der Browser behauptet. Ein Kunde, der die Success-URL von
 * Hand aufruft, bekommt deshalb keinen bezahlten Auftrag.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type { Logger, IPaymentModuleService } from "@medusajs/framework/types"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { extractGatewayTransaction } from "../../../../modules/payrexx/client"
import { mapPayrexxStatus } from "../../../../modules/payrexx/service"
import {
  getPayrexxRuntime,
  type PayrexxRuntime,
} from "../../../../modules/payrexx/runtime"

const ACTIONABLE = new Set(["authorized", "captured"])

export async function handlePayrexxReturn(
  req: MedusaRequest,
  res: MedusaResponse,
  runtime: PayrexxRuntime,
  logger: Logger
): Promise<void> {
  const sessionId = (req.body as { payment_session_id?: unknown } | undefined)
    ?.payment_session_id

  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).json({ message: "payment_session_id is required." })
    return
  }

  if (!runtime.configured) {
    res.status(503).json({ message: "Payrexx is not configured." })
    return
  }

  const paymentModule = req.scope.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const [session] = await paymentModule.listPaymentSessions({ id: [sessionId] })

  if (!session) {
    res.status(404).json({ message: "Payment session not found." })
    return
  }

  if (!String(session.provider_id ?? "").startsWith("pp_payrexx")) {
    res
      .status(400)
      .json({ message: "This payment session does not belong to Payrexx." })
    return
  }

  const gatewayId = Number((session.data as Record<string, unknown> | null)?.id)

  if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
    res.status(409).json({ message: "Payment session has no Payrexx gateway." })
    return
  }

  let transaction
  try {
    const gateway = await runtime.client.retrieveGateway(gatewayId)
    transaction = extractGatewayTransaction(gateway.data?.[0])
  } catch (err) {
    // 502, nicht 200: die Storefront darf daraus keinen Misserfolg ableiten
    // und den Kunden auf "Zahlung fehlgeschlagen" schicken. Sie soll es
    // erneut versuchen — und selbst wenn nicht, zieht der Webhook nach.
    logger.error(
      `Payrexx return check failed for session ${sessionId}: ${String(err)}`
    )
    res
      .status(502)
      .json({ message: "Could not reach Payrexx, please retry.", status: "unknown" })
    return
  }

  if (!transaction) {
    // Gateway existiert, aber es hängt keine Transaktion daran: der Kunde
    // hat nicht (fertig) bezahlt.
    res.status(200).json({
      payment_session_id: sessionId,
      status: "pending",
      transaction_status: null,
    })
    return
  }

  // Die Gateway-Antwort führt die referenceId nicht zuverlässig mit — wir
  // setzen sie hier aus der Session, die wir sicher kennen. Damit ist die
  // Zuordnung auf diesem Weg sogar stärker als beim Webhook.
  const evaluation = await runtime.processor.evaluateTransaction({
    id: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    referenceId: sessionId,
    psp: transaction.psp,
  })

  const paymentStatus = mapPayrexxStatus(transaction.status)

  if (evaluation.status === "evaluated") {
    const { action } = evaluation.action
    if (ACTIONABLE.has(action) && evaluation.action.data?.session_id) {
      try {
        await processPaymentWorkflow(req.scope).run({
          input: evaluation.action,
        })
      } catch (err) {
        if (evaluation.idempotencyKey) {
          await runtime.processor.release(evaluation.idempotencyKey)
        }
        logger.error(
          `Payrexx return processing failed for session ${sessionId}: ${String(err)}`
        )
        res.status(500).json({
          message: "Payment confirmed at Payrexx but could not be completed yet.",
          payment_session_id: sessionId,
          status: paymentStatus,
          transaction_status: transaction.status,
        })
        return
      }
    }
  }

  res.status(200).json({
    payment_session_id: sessionId,
    status: paymentStatus,
    transaction_status: transaction.status,
  })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  await handlePayrexxReturn(req, res, getPayrexxRuntime(logger), logger)
}
