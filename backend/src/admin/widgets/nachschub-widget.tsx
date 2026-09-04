/**
 * Widget «Nachschub» an der Produktseite im Admin.
 *
 * Je Variante: aktueller Bestand, Meldebestand, Lieferanten — und der Klick,
 * der die Produktseite beim Lieferanten in einem neuen Tab öffnet
 * (LieferantLink, nur geprüfte http(s)-Adressen).
 *
 * Gepflegt werden die Daten nicht hier, sondern in data/catalog.json
 * (reorder_point, suppliers) bzw. data/inventory.json (quantity), eingespielt
 * mit update-catalog.ts — das Widget zeigt den Stand aus der Datenbank.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Container, Heading, StatusBadge, Table, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"

import { istFaellig, NachschubZeile } from "../../lib/nachschub"
import { LieferantLink } from "../components/lieferant-link"
import {
  NACHSCHUB_PRODUCT_FIELDS,
  zeilenAusProdukt,
} from "../lib/nachschub-daten"
import { sdk } from "../lib/sdk"

const ZeilenStatus = ({ zeile }: { zeile: NachschubZeile }) => {
  if (zeile.bestand === null) {
    return <StatusBadge color="grey">nicht überwacht</StatusBadge>
  }
  if (zeile.meldebestand === null) {
    return <StatusBadge color="grey">kein Meldebestand</StatusBadge>
  }
  if (istFaellig(zeile)) {
    return <StatusBadge color="red">nachbestellen</StatusBadge>
  }
  return <StatusBadge color="green">ok</StatusBadge>
}

const NachschubWidget = ({
  data: product,
}: DetailWidgetProps<HttpTypes.AdminProduct>) => {
  // Eigene Abfrage statt der data-Prop: das Widget braucht die
  // Varianten-Metadaten und den berechneten Bestand (+inventory_quantity),
  // die die Produktseite selbst nicht lädt. Lädt beim Mounten.
  const { data, isPending, isError } = useQuery({
    queryKey: ["nachschub-widget", product.id],
    queryFn: () =>
      sdk.admin.product.retrieve(product.id, {
        fields: NACHSCHUB_PRODUCT_FIELDS,
      }),
  })

  const zeilen = data?.product ? zeilenAusProdukt(data.product) : []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Nachschub</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Bestand, Meldebestand und Lieferanten je Variante — Pflege über
            data/catalog.json und update-catalog.ts.
          </Text>
        </div>
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
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Variante</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                Bestand
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                Meldebestand
              </Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>
                Lieferanten (erster = Hauptlieferant)
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {zeilen.map((z) => (
              <Table.Row key={z.sku ?? z.variante}>
                <Table.Cell>
                  <Text size="small" leading="compact" weight="plus">
                    {z.variante}
                  </Text>
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle"
                  >
                    {z.sku ?? "ohne SKU"}
                  </Text>
                </Table.Cell>
                <Table.Cell className="text-right">
                  {z.bestand === null ? "—" : z.bestand}
                </Table.Cell>
                <Table.Cell className="text-right">
                  {z.meldebestand === null ? "—" : z.meldebestand}
                </Table.Cell>
                <Table.Cell>
                  <ZeilenStatus zeile={z} />
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
                      className="text-ui-fg-subtle"
                    >
                      kein Lieferant gepflegt
                    </Text>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default NachschubWidget
