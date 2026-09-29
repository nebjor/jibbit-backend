import { z } from "@medusajs/framework/zod"

/**
 * Die Adresse wird hier nur grob begrenzt; normalisiert und geprüft wird sie
 * in src/lib/kunden-email.ts, damit die Fehlermeldung deutsch ist.
 */
export const PostKundenEmailSchema = z.object({
  email: z.string().max(320),
  /** Nur prüfen und zählen, nichts schreiben. */
  vorschau: z.boolean().optional().default(false),
  bestellungen_anpassen: z.boolean().optional().default(true),
  benachrichtigen: z.boolean().optional().default(true),
})
export type PostKundenEmailBody = z.infer<typeof PostKundenEmailSchema>
