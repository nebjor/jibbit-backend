/**
 * Widget «Nachschub» an der Produktseite im Admin.
 *
 * Je Variante: aktueller Bestand, Meldebestand, Lieferanten — und der Klick,
 * der die Produktseite beim Lieferanten in einem neuen Tab öffnet
 * (LieferantLink, nur geprüfte http(s)-Adressen).
 *
 * Meldebestand und Lieferanten werden HIER gepflegt: «Bearbeiten» je
 * Variante öffnet einen Drawer, gespeichert wird über die Admin-API in
 * variant.metadata (reorder_point, suppliers). WICHTIG: die metadata wird
 * als Ganzes geschrieben — nachschubFormularMetadata() mergt deshalb die
 * bestehenden Schlüssel (units_per_pack, pack_type, …) mit hinein, sonst
 * wären sie nach dem Speichern weg. Der Bestand kommt aus Medusas
 * Lagerbeständen und wird dort gepflegt, nicht hier.
 *
 * SICHERHEIT: die Lieferanten-Adresse wird im Admin als Link gerendert.
 * pruefeLieferantenEingabe() blockt beim Speichern alles ausser http(s) —
 * zusätzlich prüfen Server (src/api/middlewares.ts) und Render-Ort
 * (parseLieferanten/LieferantLink) dieselbe Regel.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { ArrowDownMini, ArrowUpMini, PencilSquare, Plus, Trash } from "@medusajs/icons"
import {
  Button,
  Container,
  Drawer,
  Heading,
  IconButton,
  Input,
  Label,
  StatusBadge,
  Table,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  istFaellig,
  LieferantEingabe,
  lieferantenEingabeAusMetadata,
  meldebestandEingabeAusMetadata,
  nachschubFormularMetadata,
  NachschubZeile,
  pruefeLieferantenEingabe,
  pruefeMeldebestandEingabe,
} from "../../lib/nachschub"
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

type VarianteMitMetadata = {
  id: string
  title?: string | null
  sku?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * Drawer «Nachschub bearbeiten» für EINE Variante: Meldebestand (Zahl,
 * leer = nicht überwacht) und die Lieferantenliste (der erste ist der
 * Hauptlieferant; Pfeile ändern die Reihenfolge).
 */
const NachschubBearbeiten = ({
  productId,
  variant,
}: {
  productId: string
  variant: VarianteMitMetadata
}) => {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [meldebestand, setMeldebestand] = useState("")
  const [lieferanten, setLieferanten] = useState<LieferantEingabe[]>([])
  const [fehler, setFehler] = useState<string[]>([])

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (o) {
      // Rohwerte aus den aktuellen Metadaten — auch kaputte Einträge
      // erscheinen im Formular, damit sie korrigiert werden können.
      setMeldebestand(meldebestandEingabeAusMetadata(variant.metadata))
      setLieferanten(lieferantenEingabeAusMetadata(variant.metadata))
      setFehler([])
    }
  }

  const speichern = useMutation({
    mutationFn: (metadata: Record<string, unknown>) =>
      sdk.admin.product.updateVariant(productId, variant.id, { metadata }),
    onSuccess: () => {
      // Anzeige-Query des Widgets UND die Übersichtsseite nachladen — die
      // Ansicht zeigt den neuen Stand ohne Neuladen der Seite.
      queryClient.invalidateQueries({
        queryKey: ["nachschub-widget", productId],
      })
      queryClient.invalidateQueries({ queryKey: ["nachschub-uebersicht"] })
      queryClient.invalidateQueries({ queryKey: ["product", productId] })
      toast.success("Nachschubdaten gespeichert")
      setOpen(false)
    },
    onError: (e: unknown) => {
      setFehler([e instanceof Error ? e.message : "Speichern fehlgeschlagen."])
    },
  })

  const absenden = () => {
    const meldebestandFehler = pruefeMeldebestandEingabe(meldebestand)
    const alleFehler = [
      ...(meldebestandFehler ? [meldebestandFehler] : []),
      ...pruefeLieferantenEingabe(lieferanten),
    ]
    if (alleFehler.length) {
      setFehler(alleFehler)
      return
    }
    setFehler([])
    // Gemergt speichern: bestehende metadata-Schlüssel bleiben erhalten.
    speichern.mutate(
      nachschubFormularMetadata(variant.metadata, { meldebestand, lieferanten })
    )
  }

  const setzeLieferant = (
    index: number,
    feld: keyof LieferantEingabe,
    wert: string
  ) => {
    setLieferanten((alt) =>
      alt.map((l, i) => (i === index ? { ...l, [feld]: wert } : l))
    )
  }

  const verschiebe = (index: number, richtung: -1 | 1) => {
    setLieferanten((alt) => {
      const ziel = index + richtung
      if (ziel < 0 || ziel >= alt.length) {
        return alt
      }
      const neu = [...alt]
      ;[neu[index], neu[ziel]] = [neu[ziel], neu[index]]
      return neu
    })
  }

  const entferne = (index: number) => {
    setLieferanten((alt) => alt.filter((_, i) => i !== index))
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <Drawer.Trigger asChild>
        <IconButton size="small" variant="transparent" title="Nachschub bearbeiten">
          <PencilSquare />
        </IconButton>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>
            Nachschub bearbeiten — {variant.title ?? variant.sku ?? ""}
          </Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-6 overflow-y-auto">
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus" htmlFor="nachschub-meldebestand">
              Meldebestand
            </Label>
            <Input
              id="nachschub-meldebestand"
              type="number"
              min={0}
              step={1}
              value={meldebestand}
              onChange={(e) => setMeldebestand(e.target.value)}
              placeholder="leer = nicht überwachen"
            />
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Liegt der Bestand auf oder unter diesem Wert, erscheint die
              Variante auf der Seite «Nachschub». Leer lassen, um die
              Variante nicht zu überwachen.
            </Text>
          </div>

          <div className="flex flex-col gap-y-3">
            <div>
              <Label size="small" weight="plus">
                Lieferanten
              </Label>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                Der erste Eintrag ist der Hauptlieferant — mit den Pfeilen
                lässt sich die Reihenfolge ändern. Die Adresse der
                Produktseite muss mit http:// oder https:// beginnen.
              </Text>
            </div>

            {lieferanten.map((l, i) => (
              <div
                key={i}
                className="bg-ui-bg-subtle flex flex-col gap-y-2 rounded-lg p-3"
              >
                <div className="flex items-center justify-between">
                  <Text size="small" leading="compact" weight="plus">
                    {i === 0 ? "Hauptlieferant" : `Lieferant ${i + 1}`}
                  </Text>
                  <div className="flex items-center gap-x-1">
                    <IconButton
                      size="small"
                      variant="transparent"
                      title="nach oben"
                      disabled={i === 0}
                      onClick={() => verschiebe(i, -1)}
                    >
                      <ArrowUpMini />
                    </IconButton>
                    <IconButton
                      size="small"
                      variant="transparent"
                      title="nach unten"
                      disabled={i === lieferanten.length - 1}
                      onClick={() => verschiebe(i, 1)}
                    >
                      <ArrowDownMini />
                    </IconButton>
                    <IconButton
                      size="small"
                      variant="transparent"
                      title="Lieferant entfernen"
                      onClick={() => entferne(i)}
                    >
                      <Trash />
                    </IconButton>
                  </div>
                </div>
                <Input
                  value={l.name}
                  onChange={(e) => setzeLieferant(i, "name", e.target.value)}
                  placeholder="Name (z.B. Grosshandel AG)"
                  aria-label={`Lieferant ${i + 1}: Name`}
                />
                <Input
                  value={l.url}
                  onChange={(e) => setzeLieferant(i, "url", e.target.value)}
                  placeholder="https://… (Produktseite beim Lieferanten)"
                  aria-label={`Lieferant ${i + 1}: Adresse der Produktseite`}
                />
                <Input
                  value={l.article_number}
                  onChange={(e) =>
                    setzeLieferant(i, "article_number", e.target.value)
                  }
                  placeholder="Artikelnummer beim Lieferanten (optional)"
                  aria-label={`Lieferant ${i + 1}: Artikelnummer`}
                />
              </div>
            ))}

            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                setLieferanten((alt) => [
                  ...alt,
                  { name: "", url: "", article_number: "" },
                ])
              }
            >
              <Plus />
              Lieferant hinzufügen
            </Button>
          </div>

          {fehler.length > 0 && (
            <div className="flex flex-col gap-y-1">
              {fehler.map((f, i) => (
                <Text
                  key={i}
                  size="small"
                  leading="compact"
                  className="text-ui-fg-error"
                >
                  {f}
                </Text>
              ))}
            </div>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary">
              Abbrechen
            </Button>
          </Drawer.Close>
          <Button
            size="small"
            onClick={absenden}
            isLoading={speichern.isPending}
            disabled={speichern.isPending}
          >
            Speichern
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
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

  const varianten = (data?.product?.variants ?? []) as VarianteMitMetadata[]
  const zeilen = data?.product ? zeilenAusProdukt(data.product) : []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Nachschub</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Meldebestand und Lieferanten je Variante — hier über «Bearbeiten»
            pflegen. Der Bestand kommt aus den Lagerbeständen der Variante.
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
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {zeilen.map((z, index) => (
              <Table.Row key={varianten[index]?.id ?? z.sku ?? z.variante}>
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
                <Table.Cell className="text-right">
                  {varianten[index] && (
                    <NachschubBearbeiten
                      productId={product.id}
                      variant={varianten[index]}
                    />
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
