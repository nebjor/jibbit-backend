/**
 * Admin-Seite «Buchhaltung» — zwei Berichte für Steuerberater/Steueramt:
 *  - Lagerbestand per Stichtag (bewertet zum Einstandspreis, Schnappschüsse)
 *  - Umsatz pro Jahr (bezahlte Bestellungen, Monatstabelle, CSV-Exporte)
 * Daten: GET /admin/buchhaltung/* (rein lesend, ausser dem Speichern eines
 * Schnappschusses). Rechenweg und Grenzen: docs/buchhaltung.md.
 *
 * CSV-Downloads sind einfache Links auf dieselben API-Routen (Session-Cookie,
 * gleiche Herkunft); der Server setzt Content-Disposition.
 */
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Book } from "@medusajs/icons"
import { Badge, Button, Container, Heading, Table, Tabs, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { LagerAntwort, UmsatzMonat } from "../../../lib/buchhaltung"
import type { SnapshotMeta } from "../../../lib/buchhaltung-snapshots"
import { sdk } from "../../lib/sdk"

// ------------------------------------------------------------ Formatierung

const chf = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" })
const zahl = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 2 })

function datumString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function monatName(schluessel: string) {
  const [j, m] = schluessel.split("-").map(Number)
  return new Date(j, m - 1, 1).toLocaleDateString("de-CH", { month: "long" })
}

function zeitText(iso: string) {
  return new Date(iso).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" })
}

// ---------------------------------------------------------------- Bausteine

const eingabeKlasse =
  "bg-ui-bg-field text-ui-fg-base border-ui-border-base shadow-borders-base h-8 rounded-md border px-2 text-sm"

function CsvLink(props: { href: string; label: string }) {
  return (
    <Button variant="secondary" size="small" asChild>
      <a href={props.href} download>
        {props.label}
      </a>
    </Button>
  )
}

function Meldung(props: { text: string; fehler?: boolean }) {
  return (
    <div className="px-6 py-4">
      <Text
        size="small"
        leading="compact"
        className={props.fehler ? "text-ui-fg-error" : "text-ui-fg-subtle"}
      >
        {props.text}
      </Text>
    </div>
  )
}

function Kachel(props: { titel: string; wert: string; zusatz?: string }) {
  return (
    <div className="flex flex-col gap-y-1 px-6 py-4">
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {props.titel}
      </Text>
      <Heading level="h2">{props.wert}</Heading>
      {props.zusatz ? (
        <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
          {props.zusatz}
        </Text>
      ) : null}
    </div>
  )
}

function fehlerText(error: unknown, vorne: string) {
  return `${vorne}${error instanceof Error && error.message ? `: ${error.message}` : "."}`
}

// ------------------------------------------------------------- Lagerbestand

type LagerDaten = LagerAntwort & { abgeschnitten: boolean }

function SchnappschussListe() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["buchhaltung-snapshots"],
    queryFn: () =>
      sdk.client.fetch<{ snapshots: SnapshotMeta[] }>(
        "/admin/buchhaltung/lagerbestand/snapshots"
      ),
  })
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Gespeicherte Stichtage</Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Unveränderliche Kopien des Bestands zum Zeitpunkt des Speicherns.
        </Text>
      </div>
      {isError ? (
        <Meldung fehler text={fehlerText(error, "Die Liste konnte nicht geladen werden")} />
      ) : isPending ? (
        <Meldung text="Lade …" />
      ) : data.snapshots.length === 0 ? (
        <Meldung text="Noch kein Stichtag gespeichert." />
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Stichtag</Table.HeaderCell>
              <Table.HeaderCell>Gespeichert am</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Stück</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Wert</Table.HeaderCell>
              <Table.HeaderCell>Hinweis</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.snapshots.map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell>{s.stichtag.split("-").reverse().join(".")}</Table.Cell>
                <Table.Cell>{zeitText(s.erstellt_am)}</Table.Cell>
                <Table.Cell className="text-right">{zahl.format(s.stueck)}</Table.Cell>
                <Table.Cell className="text-right">{chf.format(s.wert)}</Table.Cell>
                <Table.Cell>
                  {s.ohne_einstandspreis > 0 ? (
                    <Badge color="orange" size="2xsmall">
                      {s.ohne_einstandspreis} ohne Einstandspreis
                    </Badge>
                  ) : null}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <CsvLink
                    href={`/admin/buchhaltung/lagerbestand/snapshots?id=${s.id}&format=csv`}
                    label="CSV"
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </Container>
  )
}

function LagerbestandTeil() {
  const heute = datumString(new Date())
  const [stichtag, setStichtag] = useState(heute)
  const gueltig = /^\d{4}-\d{2}-\d{2}$/.test(stichtag) && stichtag <= heute
  const qc = useQueryClient()

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["buchhaltung-lager", stichtag],
    enabled: gueltig,
    queryFn: () =>
      sdk.client.fetch<LagerDaten>("/admin/buchhaltung/lagerbestand", { query: { stichtag } }),
  })

  const speichern = useMutation({
    mutationFn: () =>
      sdk.client.fetch<{ snapshot: SnapshotMeta }>("/admin/buchhaltung/lagerbestand/snapshot", {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Der heutige Bestand wurde als Stichtag gespeichert.")
      qc.invalidateQueries({ queryKey: ["buchhaltung-snapshots"] })
    },
    onError: (e) => toast.error(fehlerText(e, "Speichern fehlgeschlagen")),
  })

  const s = data?.summe

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="flex flex-col items-start justify-between gap-3 px-6 py-4 md:flex-row md:items-center">
          <div>
            <Heading level="h2">Lagerbestand per Stichtag</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Bestand am Ende des Stichtags, bewertet zum Einstandspreis. Für vergangene Tage
              zurückgerechnet aus dem heutigen Bestand und den Lieferungen seither; manuelle
              Korrekturen danach sind nicht enthalten. Empfehlung: am 31.12. den Bestand
              speichern.
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Stichtag"
              value={stichtag}
              max={heute}
              onChange={(e) => setStichtag(e.target.value)}
              className={eingabeKlasse}
            />
            {gueltig ? (
              <CsvLink
                href={`/admin/buchhaltung/lagerbestand?stichtag=${stichtag}&format=csv`}
                label="CSV herunterladen"
              />
            ) : null}
            <Button
              size="small"
              onClick={() => speichern.mutate()}
              isLoading={speichern.isPending}
            >
              Bestand jetzt als Stichtag speichern
            </Button>
          </div>
        </div>

        {!gueltig ? (
          <Meldung text="Bitte einen Stichtag bis und mit heute wählen." />
        ) : isError ? (
          <Meldung fehler text={fehlerText(error, "Der Bestand konnte nicht geladen werden")} />
        ) : isPending || !data || !s ? (
          <Meldung text="Lade Bestand …" />
        ) : (
          <>
            <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
              <Kachel
                titel="Lagerwert (Einstandspreis)"
                wert={chf.format(s.wert)}
                zusatz={
                  s.ohne_einstandspreis > 0
                    ? `ohne ${s.ohne_einstandspreis} Positionen ohne Einstandspreis`
                    : undefined
                }
              />
              <Kachel titel="Stück" wert={zahl.format(s.stueck)} />
              <Kachel
                titel="Positionen"
                wert={zahl.format(s.positionen)}
                zusatz={data.live ? "Stand heute (live)" : "rückgerechnet"}
              />
            </div>
            {data.hinweise.length > 0 || data.abgeschnitten ? (
              <div className="flex flex-col gap-y-1 px-6 py-3">
                {data.hinweise.map((h) => (
                  <Text key={h} size="small" leading="compact" className="text-ui-fg-subtle">
                    {h}
                  </Text>
                ))}
              </div>
            ) : null}
            {data.positionen.length === 0 ? (
              <Meldung text="Keine Lagerartikel vorhanden." />
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Produkt</Table.HeaderCell>
                    <Table.HeaderCell>Variante / SKU</Table.HeaderCell>
                    <Table.HeaderCell>GTIN</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">Menge</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">Einstandspreis</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">Wert</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.positionen.map((p) => (
                    <Table.Row key={p.variant_id}>
                      <Table.Cell>{p.produkt}</Table.Cell>
                      <Table.Cell>
                        {p.variante}
                        {p.sku ? (
                          <span className="text-ui-fg-subtle"> · {p.sku}</span>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>{p.gtin}</Table.Cell>
                      <Table.Cell className="text-right">{zahl.format(p.menge)}</Table.Cell>
                      <Table.Cell className="text-right">
                        {p.einstandspreis === null ? (
                          <Badge color="orange" size="2xsmall">
                            Einstandspreis fehlt
                          </Badge>
                        ) : (
                          chf.format(p.einstandspreis)
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        {p.wert === null ? "" : chf.format(p.wert)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                  <Table.Row>
                    <Table.Cell>
                      <b>Total</b>
                    </Table.Cell>
                    <Table.Cell />
                    <Table.Cell />
                    <Table.Cell className="text-right">
                      <b>{zahl.format(s.stueck)}</b>
                    </Table.Cell>
                    <Table.Cell />
                    <Table.Cell className="text-right">
                      <b>{chf.format(s.wert)}</b>
                    </Table.Cell>
                  </Table.Row>
                </Table.Body>
              </Table>
            )}
          </>
        )}
      </Container>
      <SchnappschussListe />
    </div>
  )
}

// ------------------------------------------------------------------- Umsatz

type UmsatzDaten = {
  jahr: number
  monate: UmsatzMonat[]
  summe: UmsatzMonat
  zahlungen: { anzahl: number; eingaenge: number; rueckerstattungen: number; saldo: number }
  abgeschnitten: boolean
  geladen: number
}

function UmsatzZeile(props: { m: UmsatzMonat; name: string; fett?: boolean }) {
  const { m } = props
  const t = (inhalt: string) => (props.fett ? <b>{inhalt}</b> : inhalt)
  return (
    <Table.Row>
      <Table.Cell>{t(props.name)}</Table.Cell>
      <Table.Cell className="text-right">{t(zahl.format(m.bestellungen))}</Table.Cell>
      <Table.Cell className="text-right">{t(chf.format(m.waren))}</Table.Cell>
      <Table.Cell className="text-right">{t(chf.format(m.versand))}</Table.Cell>
      <Table.Cell className="text-right">{t(chf.format(m.brutto))}</Table.Cell>
      <Table.Cell className="text-right">{t(chf.format(m.rueckerstattungen))}</Table.Cell>
      <Table.Cell className="text-right">{t(chf.format(m.netto))}</Table.Cell>
    </Table.Row>
  )
}

function UmsatzTeil() {
  const aktuell = new Date().getFullYear()
  const [jahr, setJahr] = useState(aktuell)
  const gueltig = Number.isInteger(jahr) && jahr >= 2000 && jahr <= aktuell

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["buchhaltung-umsatz", jahr],
    enabled: gueltig,
    queryFn: () => sdk.client.fetch<UmsatzDaten>("/admin/buchhaltung/umsatz", { query: { jahr } }),
  })

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col items-start justify-between gap-3 px-6 py-4 md:flex-row md:items-center">
        <div>
          <Heading level="h2">Umsatz pro Jahr</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            Bezahlte Bestellungen nach Bestelldatum (Zürcher Zeit), Endpreise in CHF, nicht
            MwSt-pflichtig. Rückerstattungen zählen im Monat der Bestellung. Nicht enthalten:
            Verkäufe vor dem Wechsel auf diesen Shop (alte Odoo-Buchhaltung).
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            aria-label="Jahr"
            value={jahr}
            min={2000}
            max={aktuell}
            onChange={(e) => setJahr(Number(e.target.value))}
            className={`${eingabeKlasse} w-24`}
          />
          {gueltig ? (
            <>
              <CsvLink
                href={`/admin/buchhaltung/umsatz?jahr=${jahr}&format=csv`}
                label="CSV Bestellungen"
              />
              <CsvLink
                href={`/admin/buchhaltung/umsatz?jahr=${jahr}&format=zahlungen-csv`}
                label="CSV Zahlungen"
              />
            </>
          ) : null}
        </div>
      </div>

      {!gueltig ? (
        <Meldung text={`Bitte ein Jahr zwischen 2000 und ${aktuell} wählen.`} />
      ) : isError ? (
        <Meldung fehler text={fehlerText(error, "Die Auswertung konnte nicht geladen werden")} />
      ) : isPending || !data ? (
        <Meldung text="Lade Auswertung …" />
      ) : (
        <>
          {data.abgeschnitten ? (
            <div className="px-6 py-3">
              <Badge color="orange">
                Es wurden nur {data.geladen} Bestellungen ausgewertet (Obergrenze) — die Zahlen
                sind unvollständig.
              </Badge>
            </div>
          ) : null}
          <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
            <Kachel
              titel="Umsatz brutto"
              wert={chf.format(data.summe.brutto)}
              zusatz={`${zahl.format(data.summe.bestellungen)} Bestellungen`}
            />
            <Kachel
              titel="Rückerstattungen"
              wert={chf.format(data.summe.rueckerstattungen)}
            />
            <Kachel titel="Umsatz netto" wert={chf.format(data.summe.netto)} />
          </div>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Monat</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Bestellungen</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Waren</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Versand</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Brutto</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Rückerstattungen</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Netto</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.monate.map((m) => (
                <UmsatzZeile key={m.monat} m={m} name={monatName(m.monat)} />
              ))}
              <UmsatzZeile m={data.summe} name={`Total ${data.jahr}`} fett />
            </Table.Body>
          </Table>
          <div className="px-6 py-4">
            <Heading level="h3" className="mb-1">
              Nach Zahlungsdatum (Geldeingang {data.jahr})
            </Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Zahlungen {chf.format(data.zahlungen.eingaenge)} − Rückerstattungen{" "}
              {chf.format(data.zahlungen.rueckerstattungen)} = Saldo{" "}
              {chf.format(data.zahlungen.saldo)} ({data.zahlungen.anzahl} Buchungen). Kann vom
              Umsatz nach Bestelldatum abweichen, z. B. bei Bestellungen um den Jahreswechsel.
              Die Einzelbuchungen stehen im CSV «Zahlungen».
            </Text>
          </div>
        </>
      )}
    </Container>
  )
}

// ------------------------------------------------------------------- Seite

const BuchhaltungSeite = () => (
  <div className="flex flex-col gap-y-3">
    <Container className="px-6 py-4">
      <Heading level="h1">Buchhaltung</Heading>
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        Berichte für Steuerberater und Steuererklärung. Anleitung: docs/buchhaltung.md.
      </Text>
    </Container>
    <Tabs defaultValue="lager">
      <Tabs.List>
        <Tabs.Trigger value="lager">Lagerbestand per Stichtag</Tabs.Trigger>
        <Tabs.Trigger value="umsatz">Umsatz pro Jahr</Tabs.Trigger>
      </Tabs.List>
      <div className="mt-3">
        <Tabs.Content value="lager">
          <LagerbestandTeil />
        </Tabs.Content>
        <Tabs.Content value="umsatz">
          <UmsatzTeil />
        </Tabs.Content>
      </div>
    </Tabs>
  </div>
)

export const config = defineRouteConfig({
  label: "Buchhaltung",
  icon: Book,
})

export default BuchhaltungSeite
