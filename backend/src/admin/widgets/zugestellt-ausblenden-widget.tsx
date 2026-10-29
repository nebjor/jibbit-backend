/**
 * Versteckt «Als geliefert markieren» (bei Abholung: «Als abgeholt markieren»)
 * im Abschnitt «Fulfillment» der Bestelldetailseite.
 *
 * Warum so: Die Inhaberin braucht den Status nicht (sie weiss, wann sie
 * versendet hat, nicht wann die Post zustellt). Medusa 2.13.6 bietet keine
 * Möglichkeit, eingebaute Schaltflächen auszublenden, und der Knopf hat weder
 * `data-`-Attribut noch eigene Klasse — einziger Anhaltspunkt ist die
 * übersetzte Beschriftung. Darum liest das Widget die Beschriftung über
 * i18n (`orders.fulfillment.markAsDelivered`/`markAsPickedUp`, also in jeder
 * Sprache gleich) und versteckt passende Knöpfe per MutationObserver.
 * Bricht, wenn Medusa die Schlüssel umbenennt; dann ist der Knopf wieder
 * sichtbar, wirkungslos bleibt er dank Middleware
 * (src/lib/zugestellt-schutz.ts, Antwort 403).
 * «Als versendet markieren» hat eine andere Beschriftung und bleibt.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"

const SCHLUESSEL = [
  "orders.fulfillment.markAsDelivered",
  "orders.fulfillment.markAsPickedUp",
]

const ZugestelltAusblendenWidget = () => {
  const { t, i18n } = useTranslation()

  useEffect(() => {
    const beschriftungen = new Set(
      SCHLUESSEL.map((k) => t(k)).filter((s) => s && !SCHLUESSEL.includes(s))
    )
    if (!beschriftungen.size) return

    const verstecken = () => {
      document.querySelectorAll("button").forEach((knopf) => {
        if (beschriftungen.has(knopf.textContent?.trim() ?? "")) {
          knopf.style.display = "none"
          // Leere Fusszeile der Karte (grauer Balken) mit ausblenden.
          const leiste = knopf.parentElement
          if (
            leiste &&
            Array.from(leiste.children).every(
              (k) => (k as HTMLElement).style.display === "none"
            )
          ) {
            leiste.style.display = "none"
          }
        }
      })
    }

    verstecken()
    const beobachter = new MutationObserver(verstecken)
    beobachter.observe(document.body, { childList: true, subtree: true })
    return () => beobachter.disconnect()
  }, [t, i18n.language])

  return null
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default ZugestelltAusblendenWidget
