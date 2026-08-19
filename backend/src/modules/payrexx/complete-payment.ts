/**
 * Abschluss einer bestätigten Payrexx-Zahlung in Medusa.
 *
 * Beide Wege — Webhook und Rückkehr-Abgleich — laufen hier zusammen, damit
 * sie garantiert dieselbe Fehlerbehandlung haben.
 *
 * ─── Warum `errors` geprüft wird, obwohl `run()` schon werfen kann ────────
 *
 * `processPaymentWorkflow` schliesst den Warenkorb über
 * `completeCartAfterPaymentStep` ab — und dieser Schritt ist in Medusas
 * Workflow-Definition ausdrücklich als
 *
 *     .config({ continueOnPermanentFailure: true })
 *
 * markiert ("Continue payment processing even if cart completion fails").
 * Für eine mit einem Cart verknüpfte Session ist das aber der EINZIGE
 * Schritt, der die Bestellung erzeugt.
 *
 * `run()` wirft nur, wenn die Transaktion im Zustand FAILED oder REVERTED
 * endet (workflows-sdk, helper/workflow-export.js). Ein Schritt mit
 * `continueOnPermanentFailure` bringt sie NICHT dorthin: der Flow läuft
 * durch, endet als erfolgreich, und der Fehler steht nur in `errors`.
 *
 * Ohne diese Prüfung wäre die Folge genau der Verlust, gegen den die
 * Idempotenz-Freigabe gebaut ist: Route antwortet 200, der Idempotenz-Key
 * bleibt belegt, Payrexx hört auf zu wiederholen — und der Kunde hat bezahlt,
 * ohne dass je eine Bestellung entsteht.
 */

import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import type {
  MedusaContainer,
  WebhookActionResult,
} from "@medusajs/framework/types"

export async function completePayrexxPayment(
  scope: MedusaContainer,
  action: WebhookActionResult
): Promise<void> {
  const outcome = (await processPaymentWorkflow(scope).run({
    input: action,
  })) as { errors?: Array<{ error?: unknown }> } | undefined

  const errors = outcome?.errors

  if (errors?.length) {
    const detail = errors
      .map((entry) => String((entry?.error as Error)?.message ?? entry?.error))
      .join("; ")
    throw new Error(
      `processPaymentWorkflow reported step errors without failing the flow: ${detail}`
    )
  }
}
