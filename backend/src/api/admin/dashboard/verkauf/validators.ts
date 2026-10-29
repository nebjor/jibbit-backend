import { z } from "@medusajs/framework/zod"

const datum = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Ungültiges Datum (ISO erwartet)")

/** Query-Parameter von GET /admin/dashboard/verkauf; beide optional. */
export const GetDashboardVerkaufSchema = z.object({
  von: datum.optional(),
  bis: datum.optional(),
})
export type GetDashboardVerkaufQuery = z.infer<typeof GetDashboardVerkaufSchema>
