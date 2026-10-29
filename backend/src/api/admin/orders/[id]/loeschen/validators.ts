import { z } from "@medusajs/framework/zod"

/**
 * `bestaetigung` ist die Bestellnummer als Text (so tippt sie der Benutzer);
 * ob sie stimmt, prüft src/lib/bestellung-loeschen.ts. `vorschau` rechnet nur
 * und schreibt nichts — der Dialog zeigt damit die Folgen vor dem Löschen.
 */
export const PostBestellungLoeschenSchema = z.object({
  bestaetigung: z.string().max(40),
  zahlung_erstatten: z.boolean().optional().default(false),
  ware_zurueck_ins_lager: z.boolean().optional().default(false),
  vorschau: z.boolean().optional().default(false),
})
export type PostBestellungLoeschenBody = z.infer<typeof PostBestellungLoeschenSchema>
