/**
 * Widget «E-Mail-Adresse korrigieren» auf der Kundenseite.
 *
 * Das Formular «Bearbeiten» des Dashboards sperrt das Feld E-Mail, sobald der
 * Kunde ein Konto hat. Dieses Widget ändert die Adresse an allen Orten
 * zusammen: Kundendatensatz, Anmeldung und offene Bestellungen. Regeln und
 * Gründe: src/lib/kunden-email.ts, docs/kunden-email-aendern.md.
 *
 * Ablauf: Adresse eingeben → «Prüfen» zeigt, was geändert würde → «Speichern».
 * Gespeichert werden kann nur, was gerade geprüft wurde.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { PencilSquare } from "@medusajs/icons"
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
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { sdk } from "../lib/sdk"

type Antwort = {
  customer_id: string
  email: string
  kunde_geaendert: boolean
  anmeldung_geaendert: boolean
  bestellungen: number
  hinweise: string[]
  vorschau: boolean
  benachrichtigt: boolean
}

type Eingabe = {
  email: string
  bestellungen_anpassen: boolean
  benachrichtigen: boolean
}

const bestellungenText = (n: number) =>
  n === 0 ? "keine offene Bestellung" : n === 1 ? "1 offene Bestellung" : `${n} offene Bestellungen`

const KundenEmailWidget = ({ data: customer }: DetailWidgetProps<HttpTypes.AdminCustomer>) => {
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-4 px-6 py-4">
        <div>
          <Heading level="h2">E-Mail-Adresse korrigieren</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {customer.has_account
              ? "Kunde mit Konto: ändert die Adresse am Kunden und an der Anmeldung. Das Passwort bleibt."
              : "Kunde ohne Konto: ändert die Adresse am Kunden."}{" "}
            Auf Wunsch auch auf offenen Bestellungen, damit die Versandbestätigung ankommt.
          </Text>
        </div>
        <KundenEmailBearbeiten customer={customer} />
      </div>
    </Container>
  )
}

const KundenEmailBearbeiten = ({ customer }: { customer: HttpTypes.AdminCustomer }) => {
  const queryClient = useQueryClient()
  const [offen, setOffen] = useState(false)
  const [eingabe, setEingabe] = useState<Eingabe>({
    email: "",
    bestellungen_anpassen: true,
    benachrichtigen: true,
  })
  const [vorschau, setVorschau] = useState<Antwort | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)

  const sende = (body: Eingabe & { vorschau: boolean }) =>
    sdk.client.fetch<Antwort>(`/admin/customers/${customer.id}/email`, { method: "POST", body })

  const pruefen = useMutation({
    mutationFn: () => sende({ ...eingabe, vorschau: true }),
    onSuccess: (antwort) => {
      setFehler(null)
      setVorschau(antwort)
    },
    onError: (e: Error) => {
      setVorschau(null)
      setFehler(e.message)
    },
  })

  const speichern = useMutation({
    mutationFn: () => sende({ ...eingabe, vorschau: false }),
    onSuccess: (antwort) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] })
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      toast.success("E-Mail-Adresse korrigiert", {
        description:
          `${bestellungenText(antwort.bestellungen)} angepasst.` +
          (eingabe.benachrichtigen
            ? antwort.benachrichtigt
              ? " Mitteilung an die neue Adresse verschickt."
              : " Die Mitteilung konnte nicht verschickt werden (siehe Log)."
            : ""),
      })
      setOffen(false)
    },
    onError: (e: Error) => {
      setVorschau(null)
      setFehler(e.message)
    },
  })

  const oeffnen = (o: boolean) => {
    if (o) {
      setEingabe({ email: "", bestellungen_anpassen: true, benachrichtigen: true })
      setVorschau(null)
      setFehler(null)
    }
    setOffen(o)
  }

  // Jede Änderung der Eingabe macht die Prüfung ungültig.
  const setze = (teil: Partial<Eingabe>) => {
    setEingabe((alt) => ({ ...alt, ...teil }))
    setVorschau(null)
    setFehler(null)
  }

  const beschaeftigt = pruefen.isPending || speichern.isPending

  return (
    <Drawer open={offen} onOpenChange={oeffnen}>
      <Drawer.Trigger asChild>
        <Button size="small" variant="secondary">
          <PencilSquare /> Korrigieren
        </Button>
      </Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>E-Mail-Adresse korrigieren</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-4 overflow-y-auto">
          <Text size="small" className="text-ui-fg-subtle">
            Bisher hinterlegt: {customer.email || "keine Adresse"}
          </Text>
          <div className="flex flex-col gap-y-1">
            <Label size="small" weight="plus" htmlFor="kunden-email-neu">
              Neue E-Mail-Adresse
            </Label>
            <Input
              id="kunden-email-neu"
              size="small"
              type="email"
              autoComplete="off"
              placeholder="name@beispiel.ch"
              value={eingabe.email}
              onChange={(e) => setze({ email: e.target.value })}
            />
            <Text size="xsmall" className="text-ui-fg-subtle">
              Wird klein geschrieben gespeichert.
            </Text>
          </div>
          <div className="flex items-start gap-x-2">
            <Checkbox
              id="kunden-email-bestellungen"
              checked={eingabe.bestellungen_anpassen}
              onCheckedChange={(c) => setze({ bestellungen_anpassen: c === true })}
            />
            <Label size="small" htmlFor="kunden-email-bestellungen">
              Auch auf offenen Bestellungen setzen (noch nicht vollständig versendet).
              Abgeschlossene und stornierte Bestellungen bleiben unverändert.
            </Label>
          </div>
          <div className="flex items-start gap-x-2">
            <Checkbox
              id="kunden-email-mitteilung"
              checked={eingabe.benachrichtigen}
              onCheckedChange={(c) => setze({ benachrichtigen: c === true })}
            />
            <Label size="small" htmlFor="kunden-email-mitteilung">
              Kurze Mitteilung an die neue Adresse schicken. An die alte Adresse geht nichts.
            </Label>
          </div>

          {fehler && (
            <Text size="small" className="text-ui-fg-error">
              {fehler}
            </Text>
          )}

          {vorschau && (
            <div className="flex flex-col gap-y-1 rounded-lg border border-ui-border-base p-3">
              <Text size="small" weight="plus">
                Das wird geändert
              </Text>
              <Text size="small">Neue Adresse: {vorschau.email}</Text>
              <Text size="small">
                Kundendatensatz: {vorschau.kunde_geaendert ? "wird geändert" : "stimmt bereits"}
              </Text>
              <Text size="small">
                Anmeldung:{" "}
                {vorschau.anmeldung_geaendert
                  ? "wird geändert (Passwort bleibt)"
                  : "keine Änderung"}
              </Text>
              <Text size="small">
                Bestellungen:{" "}
                {eingabe.bestellungen_anpassen
                  ? `${bestellungenText(vorschau.bestellungen)} ${
                      vorschau.bestellungen === 1 ? "bekommt" : "bekommen"
                    } die neue Adresse`
                  : "werden nicht angepasst"}
              </Text>
              {vorschau.hinweise.map((h) => (
                <Text key={h} size="small" className="text-ui-fg-error">
                  {h}
                </Text>
              ))}
            </div>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          <Drawer.Close asChild>
            <Button size="small" variant="secondary" disabled={beschaeftigt}>
              Abbrechen
            </Button>
          </Drawer.Close>
          {vorschau ? (
            <Button size="small" onClick={() => speichern.mutate()} isLoading={speichern.isPending}>
              Speichern
            </Button>
          ) : (
            <Button
              size="small"
              onClick={() => pruefen.mutate()}
              isLoading={pruefen.isPending}
              disabled={!eingabe.email.trim()}
            >
              Prüfen
            </Button>
          )}
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.after",
})

export default KundenEmailWidget
