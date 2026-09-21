/**
 * Widget «Preistabelle»: der ganze Preis eines Produkts an einem Ort —
 * regulärer Preis (im Shop durchgestrichen) und Zeilen «ab Menge →
 * Stückpreis», optional mit Bezeichnung und Produktfoto je Zeile.
 * Speichermodell: src/lib/preistabelle.ts. Neues Produkt: wie gewohnt
 * «Erstellen», danach hier die Preistabelle ergänzen.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { PencilSquare, Plus, Trash } from "@medusajs/icons"
import {
  Button,
  Container,
  Drawer,
  Heading,
  IconButton,
  Input,
  Label,
  Table,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { sdk } from "../lib/sdk"

type Zeile = {
  min_quantity: number
  amount: number
  image_id?: string | null
  label?: string | null
}

type Antwort = {
  variant_count: number
  regulaerer_preis: number | null
  zeilen: Zeile[]
  hinweise: string[]
}

type EingabeZeile = { menge: string; preis: string; label: string; image_id: string | null }

type Bild = { id: string; url: string }

const chf = (n: number) =>
  n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const rabatt = (basis: number, preis: number) =>
  basis > 0 ? Math.round(((basis - preis) / basis) * 100) : 0

const queryKey = (id: string) => ["preistabelle", id]

const bilderVon = (product: HttpTypes.AdminProduct): Bild[] =>
  (product.images ?? [])
    .filter((i): i is NonNullable<typeof i> => Boolean(i?.id && i?.url))
    .map((i) => ({ id: i.id, url: i.url }))

const PreistabelleWidget = ({ data: product }: DetailWidgetProps<HttpTypes.AdminProduct>) => {
  const { data, isLoading } = useQuery({
    queryKey: queryKey(product.id),
    queryFn: () => sdk.client.fetch<Antwort>(`/admin/products/${product.id}/preistabelle`),
  })
  const bilder = bilderVon(product)
  const bildUrl = (id?: string | null) => bilder.find((b) => b.id === id)?.url

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-4 px-6 py-4">
        <div>
          <Heading level="h2">Preistabelle</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Stückpreis je Menge (Mengenrabatt). Gilt im Shop und im Warenkorb.
          </Text>
        </div>
        {data && data.variant_count === 1 && (
          <PreistabelleBearbeiten product={product} bilder={bilder} daten={data} />
        )}
      </div>

      {isLoading || !data ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">Lädt …</Text>
        </div>
      ) : data.variant_count !== 1 ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Dieses Produkt hat {data.variant_count} Varianten. Die Preistabelle
            funktioniert nur bei Produkten mit genau einer Variante — ältere
            Produkte mit eigener Display-Variante werden bei der Bereinigung
            zusammengeführt.
          </Text>
        </div>
      ) : (
        <>
          <div className="px-6 py-4">
            <Text size="small" leading="compact">
              Regulärer Preis:{" "}
              {data.regulaerer_preis != null
                ? `CHF ${chf(data.regulaerer_preis)} (im Shop durchgestrichen)`
                : "keiner"}
            </Text>
          </div>
          {data.zeilen.length ? (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Menge</Table.HeaderCell>
                  <Table.HeaderCell>Stückpreis</Table.HeaderCell>
                  <Table.HeaderCell>Rabatt</Table.HeaderCell>
                  <Table.HeaderCell>Im Shop</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.zeilen.map((z) => {
                  const r = rabatt(data.zeilen[0].amount, z.amount)
                  const url = bildUrl(z.image_id)
                  return (
                    <Table.Row key={z.min_quantity}>
                      <Table.Cell>ab {z.min_quantity} Stk.</Table.Cell>
                      <Table.Cell>CHF {chf(z.amount)}</Table.Cell>
                      <Table.Cell>{r > 0 ? `−${r} %` : "–"}</Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center gap-x-2">
                          {url && (
                            <img src={url} alt="" className="h-8 w-8 rounded object-cover" />
                          )}
                          <span>{z.label || (z.min_quantity === 1 ? "1 Stück" : `${z.min_quantity} Stück`)}</span>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  )
                })}
              </Table.Body>
            </Table>
          ) : (
            <div className="px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                Noch kein Preis erfasst. Mit «Bearbeiten» die Preistabelle anlegen.
              </Text>
            </div>
          )}
          {data.hinweise.length > 0 && (
            <div className="flex flex-col gap-y-1 px-6 py-4">
              {data.hinweise.map((h) => (
                <Text key={h} size="small" className="text-ui-fg-error">{h}</Text>
              ))}
            </div>
          )}
        </>
      )}
    </Container>
  )
}

const PreistabelleBearbeiten = ({
  product,
  bilder,
  daten: { zeilen, regulaerer_preis },
}: {
  product: HttpTypes.AdminProduct
  bilder: Bild[]
  daten: Antwort
}) => {
  const queryClient = useQueryClient()
  const [offen, setOffen] = useState(false)
  const [eingabe, setEingabe] = useState<EingabeZeile[]>([])
  const [regulaer, setRegulaer] = useState("")

  const oeffnen = (o: boolean) => {
    if (o) {
      setRegulaer(regulaerer_preis != null ? regulaerer_preis.toFixed(2) : "")
      setEingabe(
        zeilen.length
          ? zeilen.map((z) => ({
              menge: String(z.min_quantity),
              preis: z.amount.toFixed(2),
              label: z.label ?? "",
              image_id: z.image_id ?? null,
            }))
          : [{ menge: "1", preis: "", label: "", image_id: null }]
      )
    }
    setOffen(o)
  }

  const speichern = useMutation({
    mutationFn: (body: { regulaerer_preis: number | null; zeilen: Zeile[] }) =>
      sdk.client.fetch<Antwort>(`/admin/products/${product.id}/preistabelle`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey(product.id) })
      queryClient.invalidateQueries({ queryKey: ["products"] })
      toast.success("Preistabelle gespeichert")
      setOffen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const setze = (i: number, teil: Partial<EingabeZeile>) =>
    setEingabe((alt) => alt.map((z, j) => (j === i ? { ...z, ...teil } : z)))

  const zahl = (s: string) => Number(s.trim().replace(",", "."))

  const absenden = () => {
    const zeilenNeu = eingabe
      .filter((z) => z.menge.trim() !== "" || z.preis.trim() !== "")
      .map((z) => ({
        min_quantity: Number(z.menge.trim()),
        amount: zahl(z.preis),
        label: z.label.trim() || null,
        image_id: z.image_id,
      }))
    speichern.mutate({
      regulaerer_preis: regulaer.trim() ? zahl(regulaer) : null,
      zeilen: zeilenNeu,
    })
  }

  return (
    <Drawer open={offen} onOpenChange={oeffnen}>
      <Drawer.Trigger asChild>
        <Button size="small" variant="secondary">
          <PencilSquare /> Bearbeiten
        </Button>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Preistabelle — {product.title}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-4 overflow-y-auto">
          <Text size="small" className="text-ui-fg-subtle">
            Pro Zeile: ab welcher Menge welcher Preis pro Stück gilt (CHF, so wie im
            Shop angezeigt). Die erste Zeile muss «ab 1» sein. Grössere Mengen dürfen
            nicht teurer sein. Beispiel: ab 1 → 1.95, ab 10 → 1.85, ab 24 → 1.40.
            Bezeichnung und Foto sind freiwillig (z.B. «24er Display» mit dem Foto
            der Box).
          </Text>
          <div className="flex flex-col gap-y-1">
            <Label size="small" weight="plus">Regulärer Preis (CHF, freiwillig)</Label>
            <Input
              size="small"
              inputMode="decimal"
              placeholder="z.B. 2.50 — im Shop durchgestrichen"
              value={regulaer}
              onChange={(e) => setRegulaer(e.target.value)}
            />
          </div>
          {eingabe.map((z, i) => (
            <div
              key={i}
              className="flex flex-col gap-y-3 rounded-lg border border-ui-border-base p-3"
            >
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                <div className="flex flex-col gap-y-1">
                  <Label size="small" weight="plus">ab Menge (Stk.)</Label>
                  <Input
                    size="small"
                    type="number"
                    min={1}
                    step={1}
                    value={z.menge}
                    onChange={(e) => setze(i, { menge: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-y-1">
                  <Label size="small" weight="plus">Stückpreis (CHF)</Label>
                  <Input
                    size="small"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={z.preis}
                    onChange={(e) => setze(i, { preis: e.target.value })}
                  />
                </div>
                <IconButton
                  size="small"
                  variant="transparent"
                  onClick={() => setEingabe((alt) => alt.filter((_, j) => j !== i))}
                  disabled={eingabe.length === 1}
                  aria-label="Zeile löschen"
                >
                  <Trash />
                </IconButton>
              </div>
              <div className="flex flex-col gap-y-1">
                <Label size="small" weight="plus">Bezeichnung im Shop (freiwillig)</Label>
                <Input
                  size="small"
                  maxLength={30}
                  placeholder={z.menge === "1" ? "1 Stück" : `${z.menge || "…"} Stück`}
                  value={z.label}
                  onChange={(e) => setze(i, { label: e.target.value })}
                />
              </div>
              {bilder.length > 0 && (
                <div className="flex flex-col gap-y-1">
                  <Label size="small" weight="plus">Foto (freiwillig)</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="small"
                      variant={z.image_id ? "secondary" : "primary"}
                      onClick={() => setze(i, { image_id: null })}
                    >
                      Keins
                    </Button>
                    {bilder.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setze(i, { image_id: b.id })}
                        aria-pressed={z.image_id === b.id}
                        aria-label="Dieses Foto wählen"
                        className={
                          "h-11 w-11 overflow-hidden rounded border-2 " +
                          (z.image_id === b.id
                            ? "border-ui-fg-interactive"
                            : "border-transparent")
                        }
                      >
                        <img src={b.url} alt="" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          <div>
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                setEingabe((alt) => [...alt, { menge: "", preis: "", label: "", image_id: null }])
              }
            >
              <Plus /> Zeile hinzufügen
            </Button>
          </div>
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={speichern.isPending}>
              Abbrechen
            </Button>
          </Drawer.Close>
          <Button size="small" onClick={absenden} isLoading={speichern.isPending}>
            Speichern
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default PreistabelleWidget
