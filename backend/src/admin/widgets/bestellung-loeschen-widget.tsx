/**
 * Widget «Gefahrenzone: Bestellung endgültig löschen» am Ende der
 * Bestelldetailseite.
 *
 * Medusas «Stornieren» verweigert Bestellungen mit versandter Lieferung. Dieses
 * Widget ruft POST /admin/orders/:id/loeschen auf (Regeln und Gründe:
 * src/lib/bestellung-loeschen.ts, docs/bestellungen-loeschen.md). Der Dialog
 * zeigt zuerst, was geschehen würde (Vorschau vom Server, nicht im Browser
 * nachgerechnet), und verlangt zur Sicherheit die Bestellnummer.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Trash } from "@medusajs/icons"
import {
  Button,
  Checkbox,
  Container,
  Drawer,
  Heading,
  Input,
  Label,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { sdk } from "../lib/sdk"

type Plan = {
  display_id: number
  lieferungen_stornieren: string[]
  lieferungen_versandt: string[]
  lager_zurueckbuchen: { inventory_item_id: string; location_id: string; menge: number }[]
  zahlungen_abbrechen: string[]
  erstattung_betrag: number
  nicht_erstattet_betrag: number
  currency_code: string | null
  hinweise: string[]
}

type Antwort = { vorschau: boolean; plan: Plan }

type Eingabe = { zahlung_erstatten: boolean; ware_zurueck_ins_lager: boolean }

const betrag = (n: number, waehrung: string | null) =>
  `${waehrung ? waehrung.toUpperCase() + " " : ""}${n.toFixed(2)}`

const lieferungenText = (n: number) => (n === 1 ? "1 Lieferung" : `${n} Lieferungen`)

const BestellungLoeschenWidget = ({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const [aufgeklappt, setAufgeklappt] = useState(false)

  return (
    <Container className="divide-y border border-ui-tag-red-border p-0">
      <div className="flex items-center justify-between gap-x-4 px-6 py-4">
        <div>
          <Heading level="h2" className="text-ui-tag-red-text">
            Gefahrenzone
          </Heading>
          {!aufgeklappt && (
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Bestellung endgültig löschen, zum Beispiel eine Testbestellung.
            </Text>
          )}
        </div>
        <Button size="small" variant="secondary" onClick={() => setAufgeklappt((a) => !a)}>
          {aufgeklappt ? "Zuklappen" : "Aufklappen"}
        </Button>
      </div>
      {aufgeklappt && (
        <div className="flex items-center justify-between gap-x-4 px-6 py-4">
          <Text size="small" leading="compact" className="max-w-[60ch] text-ui-fg-subtle">
            Die Bestellung verschwindet aus den Listen, dem Dashboard und der Buchhaltung. Bezahlte
            Bestellungen von echten Kunden gehören zu den Belegen und sollten storniert statt
            gelöscht werden.
          </Text>
          <LoeschenDialog order={order} />
        </div>
      )}
    </Container>
  )
}

const LoeschenDialog = ({ order }: { order: HttpTypes.AdminOrder }) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [offen, setOffen] = useState(false)
  const [eingabe, setEingabe] = useState<Eingabe>({
    zahlung_erstatten: false,
    ware_zurueck_ins_lager: false,
  })
  const [nummer, setNummer] = useState("")
  const [fehler, setFehler] = useState<string | null>(null)

  const sende = (body: Eingabe & { bestaetigung: string; vorschau: boolean }) =>
    sdk.client.fetch<Antwort>(`/admin/orders/${order.id}/loeschen`, { method: "POST", body })

  const vorschau = useQuery({
    queryKey: ["bestellung-loeschen-vorschau", order.id, eingabe],
    queryFn: () => sende({ ...eingabe, bestaetigung: String(order.display_id), vorschau: true }),
    enabled: offen,
    retry: false,
    // Immer frisch: der Zustand der Bestellung kann sich geändert haben.
    gcTime: 0,
  })

  const loeschen = useMutation({
    mutationFn: () => sende({ ...eingabe, bestaetigung: nummer, vorschau: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      toast.success(`Bestellung #${order.display_id} gelöscht`)
      setOffen(false)
      navigate("/orders")
    },
    onError: (e: Error) => setFehler(e.message),
  })

  const oeffnen = (o: boolean) => {
    if (o) {
      setEingabe({ zahlung_erstatten: false, ware_zurueck_ins_lager: false })
      setNummer("")
      setFehler(null)
    }
    setOffen(o)
  }

  const plan = vorschau.data?.plan
  const stimmt = nummer.trim().replace(/^#/, "") === String(order.display_id)
  const hatVersandte = (plan?.lieferungen_versandt.length ?? 0) > 0
  const hatZahlung = (plan?.erstattung_betrag ?? 0) + (plan?.nicht_erstattet_betrag ?? 0) > 0

  return (
    <Drawer open={offen} onOpenChange={oeffnen}>
      <Drawer.Trigger asChild>
        <Button size="small" variant="danger">
          <Trash /> Bestellung endgültig löschen
        </Button>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Bestellung #{order.display_id} endgültig löschen</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-4 overflow-y-auto">
          <div className="flex flex-col gap-y-1 rounded-lg border border-ui-border-base p-3">
            <Text size="small" weight="plus">
              Das geschieht
            </Text>
            {vorschau.isLoading && <Text size="small">Wird berechnet …</Text>}
            {vorschau.error && (
              <Text size="small" className="text-ui-fg-error">
                {(vorschau.error as Error).message}
              </Text>
            )}
            {plan && (
              <>
                <Text size="small">
                  Offene Lieferungen: {plan.lieferungen_stornieren.length === 0
                    ? "keine"
                    : `${lieferungenText(plan.lieferungen_stornieren.length)} werden storniert, Reservierung und Bestand kommen zurück`}
                </Text>
                <Text size="small">
                  Versandte Lieferungen: {plan.lieferungen_versandt.length === 0
                    ? "keine"
                    : `${lieferungenText(plan.lieferungen_versandt.length)} (Ware ist beim Kunden)`}
                </Text>
                <Text size="small">
                  Lager:{" "}
                  {plan.lager_zurueckbuchen.length === 0
                    ? "keine Rückbuchung"
                    : `${plan.lager_zurueckbuchen.reduce((s, l) => s + l.menge, 0)} Stück werden zurückgebucht`}
                </Text>
                <Text size="small">
                  Zahlung:{" "}
                  {!hatZahlung
                    ? "kein erfasster Betrag"
                    : plan.erstattung_betrag > 0
                      ? `${betrag(plan.erstattung_betrag, plan.currency_code)} werden dem Kunden zurückerstattet (echtes Geld)`
                      : `${betrag(plan.nicht_erstattet_betrag, plan.currency_code)} werden NICHT zurückerstattet`}
                  {plan.zahlungen_abbrechen.length > 0 && "; nicht erfasste Zahlungen werden abgebrochen"}
                </Text>
                <Text size="small">
                  Bestellung: wird gelöscht und verschwindet aus Listen, Dashboard und Buchhaltung.
                </Text>
                {plan.hinweise.map((h) => (
                  <Text key={h} size="small" className="text-ui-fg-error">
                    {h}
                  </Text>
                ))}
              </>
            )}
          </div>

          <div className="flex items-start gap-x-2">
            <Checkbox
              id="bestellung-loeschen-erstatten"
              checked={eingabe.zahlung_erstatten}
              onCheckedChange={(c) => setEingabe((e) => ({ ...e, zahlung_erstatten: c === true }))}
            />
            <Label size="small" htmlFor="bestellung-loeschen-erstatten">
              Zahlung zurückerstatten. Ohne Häkchen (Testbestellung) bleibt die Zahlung beim Shop
              und wird nicht zurückerstattet.
            </Label>
          </div>
          <div className="flex items-start gap-x-2">
            <Checkbox
              id="bestellung-loeschen-lager"
              checked={eingabe.ware_zurueck_ins_lager}
              disabled={plan ? !hatVersandte : false}
              onCheckedChange={(c) =>
                setEingabe((e) => ({ ...e, ware_zurueck_ins_lager: c === true }))
              }
            />
            <Label size="small" htmlFor="bestellung-loeschen-lager">
              Ware ist zurück im Lager: versandte Menge wieder zum Bestand addieren. Nur sinnvoll,
              wenn die Ware wirklich wieder da ist.
            </Label>
          </div>

          <div className="flex flex-col gap-y-1">
            <Label size="small" weight="plus" htmlFor="bestellung-loeschen-nummer">
              Zur Bestätigung die Bestellnummer {order.display_id} eingeben
            </Label>
            <Input
              id="bestellung-loeschen-nummer"
              size="small"
              autoComplete="off"
              value={nummer}
              onChange={(e) => {
                setNummer(e.target.value)
                setFehler(null)
              }}
            />
          </div>

          <Text size="small" className="text-ui-fg-subtle">
            Das lässt sich in der Oberfläche nicht rückgängig machen.
          </Text>
          {fehler && (
            <Text size="small" className="text-ui-fg-error">
              {fehler}
            </Text>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={loeschen.isPending}>
              Abbrechen
            </Button>
          </Drawer.Close>
          <Button
            size="small"
            variant="danger"
            onClick={() => loeschen.mutate()}
            isLoading={loeschen.isPending}
            disabled={!stimmt || !plan}
          >
            Endgültig löschen
          </Button>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default BestellungLoeschenWidget
