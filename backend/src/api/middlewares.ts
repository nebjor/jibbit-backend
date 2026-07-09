import { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { defineMiddlewares } from "@medusajs/medusa"
import { z } from "zod"

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
