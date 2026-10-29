/**
 * Drei Kennzahlen (letzte 30 Tage, nur bezahlte Bestellungen) über der
 * Bestellliste, mit Link zum Dashboard «Verkauf».
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import type { DashboardAntwort } from "../../lib/dashboard-verkauf"
import { sdk } from "../lib/sdk"

const chf = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" })

const VerkaufKachelnWidget = () => {
  const { data, isError } = useQuery({
    queryKey: ["dashboard-verkauf-widget"],
    queryFn: () => sdk.client.fetch<DashboardAntwort>("/admin/dashboard/verkauf"),
  })

  // Bei Fehlern still bleiben: die Bestellliste darunter ist wichtiger.
  if (isError) return null

  const kacheln = [
    { titel: "Bestellungen", wert: data ? String(data.aktuell.bestellungen) : "…" },
    { titel: "Umsatz", wert: data ? chf.format(data.aktuell.umsatz_brutto) : "…" },
    {
      titel: "Durchschnittlicher Auftrag",
      wert: data ? chf.format(data.aktuell.durchschnitt_auftrag) : "…",
    },
  ]

  return (
    <Container className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {kacheln.map((k) => (
          <div key={k.titel}>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {k.titel} (30 Tage, bezahlt)
            </Text>
            <Text weight="plus">{k.wert}</Text>
          </div>
        ))}
      </div>
      <Link to="/dashboard-verkauf" className="text-ui-fg-interactive text-sm hover:underline">
        Zum Verkaufs-Dashboard
      </Link>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default VerkaufKachelnWidget
