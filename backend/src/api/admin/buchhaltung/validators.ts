import { z } from "@medusajs/framework/zod"

/** GET /admin/buchhaltung/lagerbestand?stichtag=JJJJ-MM-TT[&format=csv] */
export const GetLagerbestandSchema = z.object({
  stichtag: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "«stichtag» muss das Format JJJJ-MM-TT haben.")
    .optional(),
  format: z.enum(["csv"], { message: "«format» muss «csv» sein." }).optional(),
})

/** GET /admin/buchhaltung/lagerbestand/snapshots[?id=...&format=csv] */
export const GetSnapshotsSchema = z.object({
  id: z
    .string()
    .regex(/^bestand-\d{4}-\d{2}-\d{2}-\d{6}$/, "Ungültige Snapshot-ID.")
    .optional(),
  format: z.enum(["csv"], { message: "«format» muss «csv» sein." }).optional(),
})

/** GET /admin/buchhaltung/umsatz?jahr=JJJJ[&format=csv|zahlungen-csv] */
export const GetUmsatzSchema = z.object({
  jahr: z
    .string()
    .regex(/^\d{4}$/, "«jahr» muss vierstellig sein (JJJJ).")
    .transform(Number)
    .refine((j) => j >= 2000 && j <= 2100, "«jahr» muss zwischen 2000 und 2100 liegen.")
    .optional(),
  format: z
    .enum(["csv", "zahlungen-csv"], { message: "«format» muss «csv» oder «zahlungen-csv» sein." })
    .optional(),
})
