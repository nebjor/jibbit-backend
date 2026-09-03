import { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { defineMiddlewares } from "@medusajs/medusa"
import { z } from "@medusajs/framework/zod"

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
        message: result.error.errors.map((e) => e.message).join(", "),
      })
      return
    }
  }
  next()
}

export default defineMiddlewares({
  routes: [
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
      matcher: "/admin/customers/:id/addresses",
      method: "POST",
      middlewares: [validateAddress],
    },
    {
      matcher: "/store/customers/me/addresses",
      method: "POST",
      middlewares: [validateAddress],
    },
  ],
})
