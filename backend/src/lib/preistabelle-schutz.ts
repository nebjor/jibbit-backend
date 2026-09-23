import { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { listenpreisIdsOhneMengen } from "./preistabelle"

/**
 * Das Standard-Preisraster einer Preisliste kennt je Währung nur eine Zelle
 * und würde beim Speichern eine Staffelzeile überschreiben oder löschen.
 * Solche Requests werden für Staffelpreise abgelehnt; gepflegt werden sie im
 * Widget «Preistabelle» am Produkt. Admin-Erweiterungen können die
 * Standardmaske in Medusa 2.13 nicht ausblenden.
 */
export async function schuetzePreistabelle(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const ids = listenpreisIdsOhneMengen(req.body)
  if (!ids.length) return next()

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: prices } = await query.graph({
    entity: "price",
    fields: ["id", "min_quantity"],
    filters: { id: ids },
  })
  if (prices.some((p: any) => p.min_quantity != null)) {
    res.status(400).json({
      type: "not_allowed",
      message:
        "Staffelpreise (Mengenrabatt) bitte im Abschnitt «Preistabelle» auf der " +
        "Produktseite ändern — hier würden sie überschrieben.",
    })
    return
  }
  next()
}
