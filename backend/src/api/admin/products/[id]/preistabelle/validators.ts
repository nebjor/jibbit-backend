import { z } from "@medusajs/framework/zod"

/** Body von POST /admin/products/:id/preistabelle. Fachliche Prüfung: lib/preistabelle.ts. */
export const PostPreistabelleSchema = z.object({
  zeilen: z
    .array(
      z.object({
        min_quantity: z.number(),
        amount: z.number(),
        image_id: z.string().nullish(),
        label: z.string().nullish(),
      })
    )
    .min(1),
})
export type PostPreistabelleBody = z.infer<typeof PostPreistabelleSchema>
