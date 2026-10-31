import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getShopConfig } from "../../../../../lib/shop-config"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

import {
  entscheideKundenEmail,
  KundenEmailPlan,
  normalisiereEmail,
  renderEmailKorrigiert,
} from "../../../../../lib/kunden-email"
import { ladeKundenEmailLage } from "../../../../../lib/kunden-email-daten"
import { sendEmail } from "../../../../../lib/notify"
import { aendereKundenEmailWorkflow } from "../../../../../workflows/kunden-email/aendere-kunden-email"
import { PostKundenEmailBody } from "./validators"

/**
 * POST /admin/customers/:id/email — E-Mail-Adresse eines Kunden korrigieren.
 *
 * Nur für angemeldete Admin-Benutzer: Medusa legt die Authentifizierung auf
 * alles unter /admin, auch auf eigene Routen. Eine Store-Route gibt es
 * bewusst nicht.
 *
 * Die neue Adresse kommt im BODY, auch für die Vorschau (`vorschau: true`) —
 * in einer URL stünde sie im Zugriffslog. Aus demselben Grund nennt der
 * Logeintrag nur IDs.
 */

function antwort(plan: KundenEmailPlan, extra: Record<string, unknown>) {
  return {
    customer_id: plan.customer_id,
    email: plan.neu,
    kunde_geaendert: plan.kunde_aendern,
    anmeldung_geaendert: Boolean(plan.identitaet),
    bestellungen: plan.bestellung_ids.length,
    bestellung_ids: plan.bestellung_ids,
    hinweise: plan.hinweise,
    ...extra,
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest<PostKundenEmailBody>,
  res: MedusaResponse
) {
  const { email, vorschau, bestellungen_anpassen, benachrichtigen } = req.validatedBody
  const customerId = req.params.id

  if (vorschau) {
    const lage = await ladeKundenEmailLage(req.scope, customerId, normalisiereEmail(email))
    const entscheid = entscheideKundenEmail(lage, email, { bestellungen_anpassen })
    if (!entscheid.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, entscheid.fehler)
    }
    res.json(antwort(entscheid.plan, { vorschau: true, benachrichtigt: false }))
    return
  }

  const { result: plan } = await aendereKundenEmailWorkflow(req.scope).run({
    input: { customer_id: customerId, email, bestellungen_anpassen },
  })

  // Ohne Adressen: Personendaten gehören nicht ins Log.
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.info(
    `[kunden-email] Kunde ${plan.customer_id}: E-Mail-Adresse korrigiert durch ` +
      `${req.auth_context?.actor_type ?? "unbekannt"} ${req.auth_context?.actor_id ?? "unbekannt"}. ` +
      `Kundendatensatz: ${plan.kunde_aendern ? "geändert" : "unverändert"}, ` +
      `Anmeldung: ${plan.identitaet ? "geändert" : "keine oder unverändert"}, ` +
      `Bestellungen: ${plan.bestellung_ids.length}.`
  )

  // Mitteilung nur an die NEUE Adresse. sendEmail wirft nie; klemmt der
  // Mailserver, bleibt die Korrektur trotzdem gespeichert.
  let benachrichtigt = false
  if (benachrichtigen) {
    const vorname = await req.scope
      .resolve(ContainerRegistrationKeys.QUERY)
      .graph({ entity: "customer", fields: ["id", "first_name"], filters: { id: customerId } })
      .then(({ data }) => (data[0]?.first_name as string | null | undefined) ?? null)
      .catch(() => null)
    benachrichtigt = await sendEmail(req.scope, {
      to: plan.neu,
      template: "customer-email-corrected",
      content: renderEmailKorrigiert({
        storeName: getShopConfig().storeName,
        firstName: vorname,
        mitAnmeldung: plan.hat_anmeldung,
        bestellungen: plan.bestellung_ids.length,
      }),
      trigger: "admin.customer_email_corrected",
      resourceId: plan.customer_id,
      data: { customer_id: plan.customer_id, orders: plan.bestellung_ids.length },
    })
  }

  res.json(antwort(plan, { vorschau: false, benachrichtigt }))
}
