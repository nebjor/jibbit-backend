/**
 * Admin-Seite «Nachschub» — die Einkaufsliste des Betreibers.
 *
 * Zeigt alle Varianten auf oder unter ihrem Meldebestand, die dringendsten
 * zuerst, jeweils mit Lieferant und dem Klick auf dessen Produktseite.
 *
 * WICHTIG: eine leere Liste ist KEINE Entwarnung. Varianten ohne
 * Bestandsführung oder ohne Meldebestand können gar nicht überwacht werden —
 * die Seite nennt deshalb immer beide Zahlen (überwacht / nicht überwachbar)
 * und warnt deutlich, solange die zweite über null liegt.
 */
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ExclamationCircle, HandTruck } from "@medusajs/icons"
import { Container, Heading, StatusBadge, Table, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import { nachschubUebersicht } from "../../../lib/nachschub"
import { LieferantLink } from "../../components/lieferant-link"
import {
  NACHSCHUB_PRODUCT_FIELDS,
  zeilenAusProdukten,
} from "../../lib/nachschub-daten"
import { sdk } from "../../lib/sdk"

/** Alle Produkte seitenweise laden — der Katalog ist klein (28 Produkte). */
async function alleProdukteLaden() {
  const limit = 100
  let offset = 0
  const products = []
  for (;;) {
    const page = await sdk.admin.product.list({
      limit,
      offset,
      fields: NACHSCHUB_PRODUCT_FIELDS,
    })
    products.push(...page.products)
    offset += limit
    if (products.length >= page.count || !page.products.length) {
      return products
    }
  }
}

const NachschubSeite = () => {
  const { data: products, isPending, isError } = useQuery({
    queryKey: ["nachschub-uebersicht"],
    queryFn: alleProdukteLaden,
  })

  const u = nachschubUebersicht(zeilenAusProdukten(products ?? []))

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">Nachschub</Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Varianten auf oder unter ihrem Meldebestand — die dringendsten
          zuerst. Meldebestand (reorder_point) und Lieferanten (suppliers)
          werden in data/catalog.json gepflegt und mit update-catalog.ts
          eingespielt; der Bestand kommt aus data/inventory.json.
        </Text>
      </div>

      {isPending ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Lädt…
          </Text>
        </div>
      ) : isError ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            Nachschubdaten konnten nicht geladen werden.
          </Text>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
            <Text size="small" leading="compact">
              <span className="font-medium">{u.faellig.length}</span>{" "}
              nachzubestellen
            </Text>
            <Text size="small" leading="compact">
              <span className="font-medium">{u.ueberwacht}</span> von{" "}
              {u.gesamt} Varianten überwacht
            </Text>
            <Text
              size="small"
              leading="compact"
              className={
                u.nichtUeberwachbar > 0 ? "text-ui-fg-error" : undefined
              }
            >
              <span className="font-medium">{u.nichtUeberwachbar}</span> nicht
              überwachbar
            </Text>
          </div>

          {u.nichtUeberwachbar > 0 && (
            <div className="bg-ui-bg-subtle flex items-start gap-x-3 px-6 py-4">
              <ExclamationCircle className="text-ui-fg-error mt-0.5 shrink-0" />
              <div>
                <Text size="small" leading="compact" weight="plus" className="text-ui-fg-error">
                  {u.nichtUeberwachbar} von {u.gesamt} Varianten können nicht
                  überwacht werden — diese Liste ist für sie ohne Aussage.
                </Text>
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {u.ohneBestand} ohne Bestandsführung (quantity in
                  data/inventory.json pflegen), {u.ohneMeldebestand} ohne
                  Meldebestand (reorder_point in data/catalog.json pflegen),
                  danach update-catalog.ts laufen lassen. Eine leere Liste
                  heisst hier nicht «alles im grünen Bereich».
                </Text>
              </div>
            </div>
          )}

          {u.faellig.length ? (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Produkt / Variante</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Bestand
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Meldebestand
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Fehlmenge
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    Lieferanten (erster = Hauptlieferant)
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {u.faellig.map((z) => (
                  <Table.Row key={`${z.productId}-${z.sku ?? z.variante}`}>
                    <Table.Cell>
                      {z.productId ? (
                        <Link
                          to={`/products/${z.productId}`}
                          className="hover:text-ui-fg-interactive"
                        >
                          <Text size="small" leading="compact" weight="plus">
                            {z.produkt} · {z.variante}
                          </Text>
                        </Link>
                      ) : (
                        <Text size="small" leading="compact" weight="plus">
                          {z.produkt} · {z.variante}
                        </Text>
                      )}
                      <Text
                        size="small"
                        leading="compact"
                        className="text-ui-fg-subtle"
                      >
                        {z.sku ?? "ohne SKU"}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <StatusBadge color={z.bestand === 0 ? "red" : "orange"}>
                        {z.bestand}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {z.meldebestand}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {Math.max(0, (z.meldebestand ?? 0) - (z.bestand ?? 0))}
                    </Table.Cell>
                    <Table.Cell>
                      {z.lieferanten.length ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {z.lieferanten.map((l, i) => (
                            <LieferantLink
                              key={`${l.name}-${i}`}
                              lieferant={l}
                              haupt={i === 0}
                            />
                          ))}
                        </div>
                      ) : (
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-error"
                        >
                          kein Lieferant gepflegt
                        </Text>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : (
            <div className="px-6 py-4">
              <Text size="small" leading="compact">
                {u.ueberwacht > 0
                  ? `Keine der ${u.ueberwacht} überwachten Varianten liegt auf oder unter dem Meldebestand.`
                  : "Noch keine Variante überwachbar — zuerst Bestand und Meldebestand pflegen (siehe Hinweis oben)."}
              </Text>
            </div>
          )}
        </>
      )}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Nachschub",
  icon: HandTruck,
})

export default NachschubSeite
