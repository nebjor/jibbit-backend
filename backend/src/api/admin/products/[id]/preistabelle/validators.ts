import { z } from "@medusajs/framework/zod"

export const PostPreistabelleSchema = z.object({
  regulaerer_preis: z.number().nullish(),
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
