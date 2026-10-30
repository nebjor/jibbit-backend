import { z } from "@medusajs/framework/zod"

/** Obergrenzen — die Storefront prüft dieselben Werte, aber nur die Route zählt. */
export const WUNSCH_MAX = 500
export const EMAIL_MAX = 254
export const KONTEXT_KATEGORIE_MAX = 120
export const KONTEXT_SUCHE_MAX = 200
export const KONTEXT_URL_MAX = 500

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Leerer Text gilt als «nicht angegeben». */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))

export const PostProduktwunschSchema = z.object({
  wunsch: z
    .string()
    .trim()
    .min(1, "Bitte beschreibe dein Produkt.")
    .max(WUNSCH_MAX, `Der Wunsch darf höchstens ${WUNSCH_MAX} Zeichen lang sein.`),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || EMAIL_RE.test(v), "Die E-Mail-Adresse ist ungültig."),
  kontext: z
    .object({
      kategorie: optionalText(KONTEXT_KATEGORIE_MAX),
      suche: optionalText(KONTEXT_SUCHE_MAX),
      url: optionalText(KONTEXT_URL_MAX),
    })
    .optional()
    .default({ kategorie: undefined, suche: undefined, url: undefined }),
})
export type PostProduktwunschBody = z.infer<typeof PostProduktwunschSchema>
