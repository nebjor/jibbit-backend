import {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
  validateAndTransformBody,
} from "@medusajs/framework/http"
import { defineMiddlewares } from "@medusajs/medusa"
import { z } from "@medusajs/framework/zod"

import { sammleNachschubMetadataFehler } from "../lib/nachschub"
import { schuetzePreistabelle } from "../lib/preistabelle-schutz"
import { sperreAlsGeliefertMarkieren } from "../lib/zugestellt-schutz"
import { PostPreistabelleSchema } from "./admin/products/[id]/preistabelle/validators"
import { PostKundenEmailSchema } from "./admin/customers/[id]/email/validators"
import { PostProduktwunschSchema } from "./store/produktwunsch/validators"
import { PostBestellungLoeschenSchema } from "./admin/orders/[id]/loeschen/validators"

const addressSchema = z.object({
  postal_code: z.string().min(4, "Postal code is required (min 4 chars)"),
  city: z.string().min(1, "City is required"),
}).passthrough()

async function validateAddress(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (req.body && typeof req.body === "object") {
    // Check if body directly has address fields or nested in address
    const addressData = (req.body as any).address || req.body

    const result = addressSchema.safeParse(addressData)
    if (!result.success) {
      res.status(400).json({
        message: result.error.issues.map((e) => e.message).join(", "),
      })
      return
    }
  }
  next()
}

/**
 * Nachschubdaten (product.metadata.suppliers, variant.metadata.reorder_point
 * und Alt-suppliers an Varianten) beim Speichern über die Admin-API prüfen —
 * der rekursive Body-Scan greift auf Produkt- wie Variantenebene.
 *
 * Das Widget «Nachschub» prüft dieselben Regeln schon im Formular — aber
 * wer die Admin-API direkt anspricht, umgeht das Formular. Die
 * Lieferanten-Adresse wird im Admin als Link gerendert (dort sitzt jemand
 * mit vollen Rechten), deshalb darf hier nichts ausser http(s) in die
 * Datenbank. Der Body wird rekursiv abgesucht, damit auch Batch- und
 * verschachtelte Varianten-Updates erfasst sind; Requests ohne
 * Nachschub-Schlüssel passieren unverändert. Die letzte Verteidigung
 * bleibt der Render-Ort (parseLieferanten/LieferantLink).
 */
export function validateNachschubBody(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const fehler = sammleNachschubMetadataFehler(req.body)
  if (fehler.length) {
    res.status(400).json({ message: fehler.join("; ") })
    return
  }
  next()
}

export default defineMiddlewares({
  routes: [
    {
      // Alle Schreibzugriffe auf Produkte/Varianten (auch Batch).
      matcher: "/admin/products*",
      method: "POST",
      middlewares: [validateNachschubBody],
    },
    {
      matcher: "/admin/price-lists/:id/prices/batch",
      method: "POST",
      middlewares: [schuetzePreistabelle],
    },
    {
      matcher: "/admin/products/:id/preistabelle",
      method: "POST",
      middlewares: [validateAndTransformBody(PostPreistabelleSchema)],
    },
    {
      /**
       * Roher Request-Body für den Webhook des zahls.ch-Plugins.
       *
       * zahls.ch signiert den ROHEN Request-Body. Ein aus `req.body` neu
       * serialisiertes JSON hat eine andere Byte-Folge (Reihenfolge der
       * Schlüssel, Whitespace) und produziert deshalb IMMER eine ungültige
       * Signatur. `preserveRawBody` legt den Originalkörper als
       * `req.rawBody` ab.
       *
       * Verarbeitet wird der POST von Medusas eingebauter Route
       * /hooks/payment/:provider (das Plugin bringt keine eigene mit), und
       * die bringt dieselbe Einstellung selbst mit. Unsere statische
       * GET-Probe-Route (src/api/hooks/payment/zahls_zahls/route.ts) macht
       * den Pfad aber zu einem STATISCHEN Eintrag im Body-Parser-Routing,
       * und der Body-Parser wählt den passendsten Eintrag PRO PFAD —
       * statische Pfade gewinnen gegen Parameter-Pfade. Damit der rohe
       * Body für die HMAC-Prüfung des Plugins sicher erhalten bleibt, steht
       * preserveRawBody hier explizit — fehlte es, verwürfe das Plugin
       * jeden Webhook still als "failed", weil die Signatur nie stimmt.
       */
      matcher: "/hooks/payment/zahls_zahls",
      method: "POST",
      bodyParser: { preserveRawBody: true },
    },
    {
      // Bestellung löschen, siehe docs/bestellungen-loeschen.md.
      matcher: "/admin/orders/:id/loeschen",
      method: "POST",
      middlewares: [validateAndTransformBody(PostBestellungLoeschenSchema)],
    },
    {
      // E-Mail-Adresse korrigieren, siehe docs/kunden-email-aendern.md.
      matcher: "/admin/customers/:id/email",
      method: "POST",
      middlewares: [validateAndTransformBody(PostKundenEmailSchema)],
    },
    {
      // «Als geliefert markieren» ist nicht vorgesehen, siehe lib/zugestellt-schutz.ts.
      matcher: "/admin/orders/:id/fulfillments/:fulfillment_id/mark-as-delivered",
      method: "POST",
      middlewares: [sperreAlsGeliefertMarkieren],
    },
    {
      matcher: "/admin/customers/:id/addresses",
      method: "POST",
      middlewares: [validateAddress],
    },
    {
      // Produktwunsch aus dem Shop, siehe docs/e-mails.md.
      matcher: "/store/produktwunsch",
      method: "POST",
      middlewares: [validateAndTransformBody(PostProduktwunschSchema)],
    },
    {
      matcher: "/store/customers/me/addresses",
      method: "POST",
      middlewares: [validateAddress],
    },
  ],
})
