import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * Die Wurzel der API-Domain leitet ins Admin-Dashboard.
 *
 * ─── WOFÜR ────────────────────────────────────────────────────────────────
 *
 * `https://api-test.jibbit.ch/` beantwortete Medusa mit Express' nacktem
 * «Cannot GET /» — eine 404-Seite ohne jeden Hinweis. Wer die Adresse aus dem
 * Gedächtnis eintippt (und das tut man, der Admin ist die Arbeitsoberfläche),
 * landete auf einem Fehler statt bei der Anmeldung.
 *
 * ─── WARUM 302 UND NICHT 301 ──────────────────────────────────────────────
 *
 * 301 wäre dauerhaft und würde vom Browser gecached — auch dann noch, wenn
 * hier später einmal etwas anderes stehen soll. Ein Ziel, das man nicht mehr
 * los wird, ohne die Nutzer ihren Verlauf leeren zu lassen, ist den kleinen
 * Geschwindigkeitsvorteil nicht wert.
 *
 * ─── WARUM /app UND NICHT /app/login ──────────────────────────────────────
 *
 * `/app` entscheidet selbst: angemeldet → Dashboard, sonst → Anmeldung. Wer
 * eine gültige Sitzung hat, soll nicht auf einem Anmeldeformular landen, das
 * ihn sofort weiterschickt.
 *
 * Nur GET: eine API-Wurzel, die POST beantwortet, wäre eine Einladung.
 */
export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.redirect(302, "/app")
}
