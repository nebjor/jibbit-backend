/**
 * Widget «Nachschub» an der Produktseite im Admin.
 *
 * Zwei Ebenen, zwei Abschnitte:
 *
 *   - LIEFERANTEN fürs ganze PRODUKT: der Betreiber kauft ein Produkt beim
 *     Grosshändler — ob Einzelheft oder Display, die Bezugsquelle ist
 *     dieselbe. Gepflegt einmal je Produkt («Bearbeiten» im Abschnitt
 *     Lieferanten), gespeichert in product.metadata.suppliers.
 *   - MELDEBESTAND je VARIANTE: der hängt am Bestand, und der ist je
 *     Variante verschieden. «Bearbeiten» je Tabellenzeile, gespeichert in
 *     variant.metadata.reorder_point. Der Bestand selbst kommt aus Medusas
 *     Lagerbeständen und wird dort gepflegt, nicht hier.
 *
 * ALT-DATEN: früher lagen die Lieferanten je Variante. Solche Einträge
 * werden weiter angezeigt (zusammengeführt über alle Varianten, siehe
 * effektiveLieferantenMetadata) und beim ersten Speichern der Lieferanten
 * ans Produkt geschrieben; die Varianten-Schlüssel werden dabei geräumt.
 * Der Betreiber muss nichts ein zweites Mal erfassen.
 *
 * WICHTIG: die metadata wird als Ganzes geschrieben —
 * lieferantenFormularMetadata()/meldebestandFormularMetadata() mergen
 * deshalb die bestehenden Schlüssel (brand am Produkt, ean/weight_g/
 * units_per_pack an der Variante, …) mit hinein, sonst wären sie nach dem
 * Speichern weg.
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
  lieferantenFormularMetadata,
  meldebestandEingabeAusMetadata,
  meldebestandFormularMetadata,
  NachschubZeile,
  parseLieferanten,
  pruefeLieferantenEingabe,
  pruefeMeldebestandEingabe,
  SUPPLIERS_KEY,
} from "../../lib/nachschub"
import { LieferantLink } from "../components/lieferant-link"
import {
  NACHSCHUB_PRODUCT_FIELDS,
  produktLieferanten,
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

type ProduktMitMetadata = {
  id: string
  title: string
  metadata?: Record<string, unknown> | null
  variants?: VarianteMitMetadata[] | null
}

/**
 * Drawer «Lieferanten bearbeiten» fürs GANZE Produkt: die Lieferantenliste
 * (der erste ist der Hauptlieferant; Pfeile ändern die Reihenfolge).
 *
 * Gespeichert wird in product.metadata.suppliers — und Alt-Einträge in den
 * Varianten-Metadaten werden im selben Zug geräumt, damit künftig nur noch
 * die Produktliste gilt.
 */
const LieferantenBearbeiten = ({ product }: { product: ProduktMitMetadata }) => {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [lieferanten, setLieferanten] = useState<LieferantEingabe[]>([])
  const [fehler, setFehler] = useState<string[]>([])

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (o) {
      // Rohwerte aus der massgeblichen Quelle — Produkt, oder (Alt-Daten)
      // die zusammengeführten Varianten-Einträge. Auch kaputte Einträge
      // erscheinen im Formular, damit sie korrigiert werden können.
      setLieferanten(
        lieferantenEingabeAusMetadata(produktLieferanten(product).metadata)
      )
      setFehler([])
    }
  }

  const speichern = useMutation({
    mutationFn: async (eingabe: LieferantEingabe[]) => {
      // 1. Die Liste ans Produkt — gemergt, brand & Co. bleiben erhalten.
      await sdk.admin.product.update(product.id, {
        metadata: lieferantenFormularMetadata(product.metadata, eingabe),
      })
      // 2. Alt-Einträge an den Varianten räumen (einmalige Übernahme) —
      // ebenfalls gemergt, ean/weight_g/reorder_point bleiben erhalten.
      for (const v of product.variants ?? []) {
        if (v.metadata?.[SUPPLIERS_KEY] != null) {
          await sdk.admin.product.updateVariant(product.id, v.id, {
            metadata: lieferantenFormularMetadata(v.metadata, []),
          })
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["nachschub-widget", product.id],
      })
      queryClient.invalidateQueries({ queryKey: ["nachschub-uebersicht"] })
      queryClient.invalidateQueries({ queryKey: ["product", product.id] })
      toast.success("Lieferanten für das Produkt gespeichert")
      setOpen(false)
    },
    onError: (e: unknown) => {
      setFehler([e instanceof Error ? e.message : "Speichern fehlgeschlagen."])
    },
  })

  const absenden = () => {
    const alleFehler = pruefeLieferantenEingabe(lieferanten)
    if (alleFehler.length) {
      setFehler(alleFehler)
      return
    }
    setFehler([])
    speichern.mutate(lieferanten)
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
        <Button size="small" variant="secondary">
          <PencilSquare />
          Bearbeiten
        </Button>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Lieferanten — {product.title}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-6 overflow-y-auto">
          <div className="flex flex-col gap-y-3">
            <div>
              <Label size="small" weight="plus">
                Lieferanten (für das ganze Produkt)
              </Label>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                Gilt für alle Varianten dieses Produkts. Der erste Eintrag
                ist der Hauptlieferant — mit den Pfeilen lässt sich die
                Reihenfolge ändern. Die Adresse der Produktseite muss mit
                http:// oder https:// beginnen.
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

/**
 * Drawer «Meldebestand bearbeiten» für EINE Variante: nur der Meldebestand
 * (Zahl, leer = nicht überwacht) — die Lieferanten hängen am Produkt.
 */
const MeldebestandBearbeiten = ({
  productId,
  variant,
}: {
  productId: string
  variant: VarianteMitMetadata
}) => {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [meldebestand, setMeldebestand] = useState("")
  const [fehler, setFehler] = useState<string[]>([])

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (o) {
      setMeldebestand(meldebestandEingabeAusMetadata(variant.metadata))
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
      toast.success("Meldebestand gespeichert")
      setOpen(false)
    },
    onError: (e: unknown) => {
      setFehler([e instanceof Error ? e.message : "Speichern fehlgeschlagen."])
    },
  })

  const absenden = () => {
    const meldebestandFehler = pruefeMeldebestandEingabe(meldebestand)
    if (meldebestandFehler) {
      setFehler([meldebestandFehler])
      return
    }
    setFehler([])
    // Gemergt speichern: bestehende metadata-Schlüssel (ean, weight_g, …)
    // bleiben erhalten.
    speichern.mutate(meldebestandFormularMetadata(variant.metadata, meldebestand))
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <Drawer.Trigger asChild>
        <IconButton size="small" variant="transparent" title="Meldebestand bearbeiten">
          <PencilSquare />
        </IconButton>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>
            Meldebestand — {variant.title ?? variant.sku ?? ""}
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

/** Abschnitt «Lieferanten» — einmal fürs ganze Produkt. */
const LieferantenAbschnitt = ({ product }: { product: ProduktMitMetadata }) => {
  const quelle = produktLieferanten(product)
  const lieferanten = parseLieferanten(quelle.metadata)
  const z = quelle.zusammenfuehrung

  return (
    <div className="flex flex-col gap-y-2 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <Text size="small" leading="compact" weight="plus">
            Lieferanten (für das ganze Produkt, erster = Hauptlieferant)
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Die Bezugsquelle ist für alle Varianten dieselbe — hier einmal
            pflegen.
          </Text>
        </div>
        <LieferantenBearbeiten product={product} />
      </div>
      {lieferanten.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {lieferanten.map((l, i) => (
            <LieferantLink key={`${l.name}-${i}`} lieferant={l} haupt={i === 0} />
          ))}
        </div>
      ) : (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          kein Lieferant gepflegt
        </Text>
      )}
      {quelle.quelle === "varianten" && (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Aus den bisherigen Varianten-Einträgen übernommen
          {z && z.vonVarianten > 1
            ? ` (zusammengeführt aus ${z.vonVarianten} Varianten${
                z.unterschiedlich
                  ? ", die Listen waren unterschiedlich — alle Einträge bleiben erhalten"
                  : ""
              })`
            : ""}
          . Beim nächsten Speichern über «Bearbeiten» werden sie einmalig für
          das ganze Produkt übernommen.
        </Text>
      )}
    </div>
  )
}

const NachschubWidget = ({
  data: product,
}: DetailWidgetProps<HttpTypes.AdminProduct>) => {
  // Eigene Abfrage statt der data-Prop: das Widget braucht die Produkt- und
  // Varianten-Metadaten und den berechneten Bestand (+inventory_quantity),
  // die die Produktseite selbst nicht lädt. Lädt beim Mounten.
  const { data, isPending, isError } = useQuery({
    queryKey: ["nachschub-widget", product.id],
    queryFn: () =>
      sdk.admin.product.retrieve(product.id, {
        fields: NACHSCHUB_PRODUCT_FIELDS,
      }),
  })

  const geladen = data?.product as ProduktMitMetadata | undefined
  const varianten = (geladen?.variants ?? []) as VarianteMitMetadata[]
  const zeilen = data?.product ? zeilenAusProdukt(data.product) : []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Nachschub</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Lieferanten für das ganze Produkt, Meldebestand je Variante —
            hier über «Bearbeiten» pflegen. Der Bestand kommt aus den
            Lagerbeständen der Variante.
          </Text>
        </div>
      </div>
      {isPending ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Lädt…
          </Text>
        </div>
      ) : isError || !geladen ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            Nachschubdaten konnten nicht geladen werden.
          </Text>
        </div>
      ) : (
        <>
          <LieferantenAbschnitt product={geladen} />
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
                  <Table.Cell className="text-right">
                    {varianten[index] && (
                      <MeldebestandBearbeiten
                        productId={product.id}
                        variant={varianten[index]}
                      />
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default NachschubWidget
