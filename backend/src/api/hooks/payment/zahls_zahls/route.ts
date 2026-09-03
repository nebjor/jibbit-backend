/**
 * Erreichbarkeitsprüfung für die Webhook-Adresse des zahls.ch-Plugins.
 *
 *   GET /hooks/payment/zahls_zahls
 *
 * ─── Warum es diese Datei braucht ──────────────────────────────────────────
 *
 * Das offizielle Plugin (@zahls/medusa-plugin) bringt KEINE eigene
 * Webhook-Route mit — es nutzt Medusas eingebaute Route
 * `POST /hooks/payment/:provider` (@medusajs/medusa, hooks/payment/[provider]).
 * Die eingebaute Route exportiert ausschliesslich POST.
 *
 * zahls.ch prüft eine eingetragene Webhook-Adresse aber mit einem GET, bevor
 * es sie annimmt. Ohne diese Datei antwortete Medusa darauf mit 404, und das
 * zahls.ch-Backend wies die Adresse als «nicht gültig» zurück — exakt der
 * Fehler, an dem die Einrichtung schon einmal gescheitert ist.
 *
 * ─── Warum hier KEIN POST steht ────────────────────────────────────────────
 *
 * Diese statische Route registriert nur GET. Ein POST auf denselben Pfad
 * passt nicht auf den GET-Layer und fällt im Express-Router auf Medusas
 * eingebaute `POST /hooks/payment/:provider`-Route durch — dort verarbeitet
 * das Plugin den Webhook (Signaturprüfung inklusive). Ein eigener POST hier
 * würde die Plugin-Verarbeitung ersetzen, nicht ergänzen.
 *
 * Der Rohkörper für die Signaturprüfung bleibt erhalten, weil
 * src/api/middlewares.ts für POST auf genau diesen Pfad `preserveRawBody`
 * setzt — der Body-Parser wählt den passendsten Eintrag PRO PFAD, und der
 * statische Pfad gewinnt gegen Medusas eingebauten Parameter-Matcher.
 *
 * Bewusst OHNE jede Aussage über den Zustand: keine Angabe, ob Zugangsdaten
 * hinterlegt sind oder welche Instanz konfiguriert ist. Die Adresse ist
 * öffentlich und unauthentifiziert erreichbar.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.status(200).json({ status: "ok", accepts: "POST" })
}
