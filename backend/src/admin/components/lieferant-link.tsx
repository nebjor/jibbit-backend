/**
 * Der Klick zum Lieferanten — als echter Link, damit «in neuem Tab öffnen»
 * und Kopieren der Adresse funktionieren.
 *
 * SICHERHEIT: gerendert wird ausschliesslich Lieferant.url, und die ist per
 * parseLieferanten() (lib/nachschub.ts) garantiert http(s) — eine
 * javascript:-Adresse, die es an Formular- und API-Prüfung vorbei in die
 * Varianten-Metadaten geschafft hätte, käme sonst hier im Admin mit vollen
 * Rechten zur Ausführung. Steht statt einer sicheren URL
 * nur eine unsichere Roh-Angabe da, erscheint eine Warnung und KEIN Link.
 * Jeder Link trägt target="_blank" rel="noopener noreferrer".
 */
import { ArrowUpRightOnBox } from "@medusajs/icons"
import { Button, Text, Tooltip } from "@medusajs/ui"

import { isSafeSupplierUrl, Lieferant } from "../../lib/nachschub"

export const LieferantLink = ({
  lieferant,
  haupt,
}: {
  lieferant: Lieferant
  /** Erster Eintrag der Liste = Hauptlieferant. */
  haupt?: boolean
}) => {
  // Zweite Prüfung direkt am Render-Ort — auch wenn ein Aufrufer die Zeile
  // einmal anders baut, entsteht aus einer unsicheren Adresse nie ein href.
  if (lieferant.url && isSafeSupplierUrl(lieferant.url)) {
    return (
      <Button size="small" variant={haupt ? "secondary" : "transparent"} asChild>
        <a
          href={lieferant.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${lieferant.name} — Produktseite beim Lieferanten öffnen`}
        >
          {lieferant.name}
          {lieferant.artikelnummer ? (
            <span className="text-ui-fg-subtle">
              {" "}
              · {lieferant.artikelnummer}
            </span>
          ) : null}
          <ArrowUpRightOnBox />
        </a>
      </Button>
    )
  }

  return (
    <span className="inline-flex items-center gap-x-1">
      <Text size="small" leading="compact">
        {lieferant.name}
      </Text>
      {lieferant.unsichereUrl ? (
        <Tooltip content={`Adresse nicht verlinkbar: «${lieferant.unsichereUrl}» — nur http/https ist erlaubt. An der Produktseite im Abschnitt «Nachschub» über «Bearbeiten» korrigieren.`}>
          <Text size="small" leading="compact" className="text-ui-fg-error">
            Adresse ungültig
          </Text>
        </Tooltip>
      ) : (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          ohne Adresse
        </Text>
      )}
    </span>
  )
}
