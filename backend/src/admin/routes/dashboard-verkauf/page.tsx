/**
 * Admin-Seite «Verkauf» — Dashboard nach dem Vorbild des alten Odoo-Dashboards
 * (Daten: GET /admin/dashboard/verkauf, nur lesend).
 *
 * Es zählen nur BEZAHLTE Bestellungen (Zahlung erfasst, nicht storniert);
 * Details in src/lib/dashboard-verkauf.ts und docs/admin-dashboard.md.
 * Der Zeitraum steht in der URL (?zeitraum=30 oder ?zeitraum=eigen&von=&bis=),
 * damit er sich per Link teilen und neu laden lässt.
 *
 * Diagramm: eigenes SVG, ohne zusätzliche Abhängigkeit (recharts ist im
 * Backend nicht installiert und gehört nicht zu den Admin-Paketen, die
 * Erweiterungen nutzen dürfen).
 */
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ChartBar } from "@medusajs/icons"
import { Badge, Container, Heading, Select, Table, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { Link, useSearchParams } from "react-router-dom"

import type { DashboardAntwort, Monat, TopProdukt } from "../../../lib/dashboard-verkauf"
import { sdk } from "../../lib/sdk"

// ------------------------------------------------------------- Zeitraum

const VOREINSTELLUNGEN = [
  { wert: "jahr", label: "Seit Jahresbeginn" },
  { wert: "7", label: "Letzte 7 Tage" },
  { wert: "30", label: "Letzte 30 Tage" },
  { wert: "90", label: "Letzte 90 Tage" },
  { wert: "180", label: "Letzte 180 Tage" },
  { wert: "365", label: "Letzte 365 Tage" },
  { wert: "3j", label: "Letzte 3 Jahre" },
  { wert: "eigen", label: "Eigener Zeitraum" },
] as const

function datumString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Von/bis (beide Tage inklusive) für eine Voreinstellung, ab heute gerechnet. */
function bereich(wert: string, von: string, bis: string, heute = new Date()) {
  const bisHeute = datumString(heute)
  if (wert === "eigen") return { von, bis }
  if (wert === "jahr") return { von: `${heute.getFullYear()}-01-01`, bis: bisHeute }
  if (wert === "3j") {
    // Heute vor 3 Jahren + 1 Tag, damit es genau 3 Jahre sind.
    const d = new Date(heute.getFullYear() - 3, heute.getMonth(), heute.getDate() + 1)
    return { von: datumString(d), bis: bisHeute }
  }
  const tage = Number(wert) || 30
  const d = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - (tage - 1))
  return { von: datumString(d), bis: bisHeute }
}

// ------------------------------------------------------------ Formatierung

const chf = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" })
const zahl = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 2 })
const prozentFormat = new Intl.NumberFormat("de-CH", {
  style: "percent",
  maximumFractionDigits: 0,
})

function monatLabel(schluessel: string, lang = false) {
  const [j, m] = schluessel.split("-").map(Number)
  return new Date(j, m - 1, 1).toLocaleDateString("de-CH", {
    month: lang ? "long" : "short",
    year: lang ? "numeric" : "2-digit",
  })
}

function datum(iso: string) {
  return new Date(iso).toLocaleDateString("de-CH", { dateStyle: "medium" })
}

// ---------------------------------------------------------------- Bausteine

function Veraenderung({ prozent }: { prozent: number | null }) {
  if (prozent === null) {
    return <Badge color="grey" size="2xsmall">kein Vergleich</Badge>
  }
  const text = `${prozent > 0 ? "+" : ""}${zahl.format(prozent)} %`
  return (
    <Badge color={prozent > 0 ? "green" : prozent < 0 ? "red" : "grey"} size="2xsmall">
      {text}
    </Badge>
  )
}

function Kachel(props: {
  titel: string
  wert: string
  prozent?: number | null
  zusatz?: string
}) {
  return (
    <div className="flex flex-col gap-y-1 px-6 py-4">
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {props.titel}
      </Text>
      <Heading level="h2">{props.wert}</Heading>
      <div className="flex items-center gap-x-2">
        {props.prozent !== undefined ? <Veraenderung prozent={props.prozent} /> : null}
        {props.zusatz ? (
          <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
            {props.zusatz}
          </Text>
        ) : null}
      </div>
    </div>
  )
}

/** Balkendiagramm Umsatz pro Monat — reines SVG, Werte als Tooltip (title). */
function MonatsDiagramm({ monate }: { monate: Monat[] }) {
  const B = 800
  const H = 220
  const links = 8
  const unten = 28
  const oben = 18
  const max = Math.max(1, ...monate.map((m) => m.umsatz))
  const platz = (B - links) / monate.length
  const balken = Math.min(56, platz * 0.7)
  const hoehe = H - unten - oben
  // Beschriftung ausdünnen, wenn es viele Monate sind.
  const takt = Math.ceil(monate.length / 12)

  return (
    <svg
      viewBox={`0 0 ${B} ${H}`}
      className="w-full"
      role="img"
      aria-label="Umsatz pro Monat"
      style={{ maxHeight: 280 }}
    >
      <line
        x1={0}
        x2={B}
        y1={H - unten}
        y2={H - unten}
        style={{ stroke: "var(--border-base)" }}
      />
      {monate.map((m, i) => {
        const h = (m.umsatz / max) * hoehe
        const x = links + i * platz + (platz - balken) / 2
        const mitte = x + balken / 2
        return (
          <g key={m.monat}>
            <title>
              {`${monatLabel(m.monat, true)}: ${chf.format(m.umsatz)} (${m.bestellungen} Bestellungen)`}
            </title>
            <rect
              x={x}
              y={H - unten - Math.max(h, m.umsatz > 0 ? 1 : 0)}
              width={balken}
              height={Math.max(h, m.umsatz > 0 ? 1 : 0)}
              rx={2}
              style={{ fill: "var(--bg-interactive)" }}
            />
            {/* unsichtbare, volle Trefferfläche, damit auch kleine Balken Tooltips zeigen */}
            <rect x={x} y={oben} width={balken} height={hoehe} fill="transparent" />
            {m.umsatz > 0 && monate.length <= 12 ? (
              <text
                x={mitte}
                y={H - unten - h - 4}
                textAnchor="middle"
                fontSize={11}
                style={{ fill: "var(--fg-subtle)" }}
              >
                {zahl.format(Math.round(m.umsatz))}
              </text>
            ) : null}
            {i % takt === 0 ? (
              <text
                x={mitte}
                y={H - 8}
                textAnchor="middle"
                fontSize={11}
                style={{ fill: "var(--fg-subtle)" }}
              >
                {monatLabel(m.monat)}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

function ProduktTabelle(props: { titel: string; zeilen: TopProdukt[]; nachMenge?: boolean }) {
  return (
    <div className="px-6 py-4">
      <Heading level="h3" className="mb-3">
        {props.titel}
      </Heading>
      {props.zeilen.length === 0 ? (
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Keine Verkäufe im Zeitraum.
        </Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Produkt</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Menge</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Umsatz</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {props.zeilen.map((p) => (
              <Table.Row key={p.schluessel}>
                <Table.Cell>{p.titel}</Table.Cell>
                <Table.Cell className="text-right">
                  {props.nachMenge ? <b>{zahl.format(p.menge)}</b> : zahl.format(p.menge)}
                </Table.Cell>
                <Table.Cell className="text-right">
                  {props.nachMenge ? chf.format(p.umsatz) : <b>{chf.format(p.umsatz)}</b>}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- Seite

const VerkaufSeite = () => {
  const [params, setParams] = useSearchParams()
  const gewaehlt = VOREINSTELLUNGEN.some((v) => v.wert === params.get("zeitraum"))
    ? (params.get("zeitraum") as string)
    : "30"
  const heute = datumString(new Date())
  const eigenVon = params.get("von") ?? ""
  const eigenBis = params.get("bis") ?? heute
  const { von, bis } = bereich(gewaehlt, eigenVon, eigenBis)
  const bereitZumLaden = !!von && !!bis && von <= bis

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["dashboard-verkauf", von, bis],
    enabled: bereitZumLaden,
    queryFn: () =>
      sdk.client.fetch<DashboardAntwort>("/admin/dashboard/verkauf", { query: { von, bis } }),
  })

  const setze = (aenderung: Record<string, string | null>) => {
    const neu = new URLSearchParams(params)
    for (const [k, v] of Object.entries(aenderung)) {
      if (v === null) neu.delete(k)
      else neu.set(k, v)
    }
    setParams(neu, { replace: true })
  }

  const a = data?.aktuell
  const vergleich = data
    ? `gegenüber ${datum(data.vorzeitraum.von)} – ${datum(
        new Date(new Date(data.vorzeitraum.bis).getTime() - 1).toISOString()
      )}`
    : ""

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="flex flex-col items-start justify-between gap-3 px-6 py-4 md:flex-row md:items-center">
          <div>
            <Heading level="h1">Verkauf</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Nur bezahlte Bestellungen (Zahlung erfasst, nicht storniert). Beträge in CHF,
              Endpreise.
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="small"
              value={gewaehlt}
              onValueChange={(w) =>
                setze({
                  zeitraum: w,
                  von: w === "eigen" ? (eigenVon || bereich(gewaehlt, "", "").von) : null,
                  bis: w === "eigen" ? (eigenBis || heute) : null,
                })
              }
            >
              <Select.Trigger className="w-[200px]">
                <Select.Value placeholder="Zeitraum" />
              </Select.Trigger>
              <Select.Content>
                {VOREINSTELLUNGEN.map((v) => (
                  <Select.Item key={v.wert} value={v.wert}>
                    {v.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
            {gewaehlt === "eigen" ? (
              <>
                <input
                  type="date"
                  aria-label="Von"
                  value={eigenVon}
                  max={eigenBis || undefined}
                  onChange={(e) => setze({ von: e.target.value })}
                  className="bg-ui-bg-field text-ui-fg-base border-ui-border-base shadow-borders-base h-8 rounded-md border px-2 text-sm"
                />
                <span className="text-ui-fg-subtle">bis</span>
                <input
                  type="date"
                  aria-label="Bis"
                  value={eigenBis}
                  min={eigenVon || undefined}
                  onChange={(e) => setze({ bis: e.target.value })}
                  className="bg-ui-bg-field text-ui-fg-base border-ui-border-base shadow-borders-base h-8 rounded-md border px-2 text-sm"
                />
              </>
            ) : null}
          </div>
        </div>
        {!bereitZumLaden ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Bitte einen gültigen Zeitraum wählen (Von vor oder gleich Bis).
            </Text>
          </div>
        ) : isError ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" className="text-ui-fg-error">
              Die Auswertung konnte nicht geladen werden
              {error instanceof Error && error.message ? `: ${error.message}` : "."}
            </Text>
          </div>
        ) : isPending || !data || !a ? (
          <div className="px-6 py-8">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Lade Auswertung …
            </Text>
          </div>
        ) : (
          <>
            {data.abgeschnitten ? (
              <div className="px-6 py-3">
                <Badge color="orange">
                  Es wurden nur {data.geladen} Bestellungen ausgewertet (Obergrenze) — die Zahlen sind
                  unvollständig. Bitte den Zeitraum verkleinern.
                </Badge>
              </div>
            ) : null}
            <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
              <Kachel
                titel="Bestellungen"
                wert={zahl.format(a.bestellungen)}
                prozent={data.aenderung.bestellungen}
                zusatz={vergleich}
              />
              <Kachel
                titel="Umsatz (brutto)"
                wert={chf.format(a.umsatz_brutto)}
                prozent={data.aenderung.umsatz}
                zusatz={
                  a.rueckerstattungen > 0
                    ? `Rückerstattet ${chf.format(a.rueckerstattungen)}, netto ${chf.format(a.umsatz_netto)}`
                    : "keine Rückerstattungen"
                }
              />
              <Kachel
                titel="Durchschnittlicher Auftrag"
                wert={chf.format(a.durchschnitt_auftrag)}
                prozent={data.aenderung.durchschnitt_auftrag}
              />
            </div>
            <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
              <Kachel
                titel="Durchschnittliche Stückzahl pro Bestellung"
                wert={zahl.format(a.durchschnitt_stueck)}
                zusatz={`${zahl.format(a.stueck_gesamt)} Stück insgesamt`}
              />
              <Kachel
                titel="Warenwert / Versand"
                wert={`${chf.format(a.warenwert)} / ${chf.format(a.versand)}`}
              />
              <Kachel
                titel="Bestellungen mit Gratisversand"
                wert={prozentFormat.format(a.gratis_versand_anteil)}
                zusatz={`${a.gratis_versand_anzahl} von ${a.bestellungen} (inkl. Abholung)`}
              />
            </div>
          </>
        )}
      </Container>

      {data && a ? (
        <>
          <Container className="px-6 py-4">
            <Heading level="h2" className="mb-2">
              Umsatz pro Monat
            </Heading>
            <MonatsDiagramm monate={data.monate} />
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">Top-Verkaufsaufträge</Heading>
            </div>
            {data.top_bestellungen.length === 0 ? (
              <div className="px-6 py-4">
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  Keine bezahlten Bestellungen im Zeitraum.
                </Text>
              </div>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Bestellung</Table.HeaderCell>
                    <Table.HeaderCell>Kunde</Table.HeaderCell>
                    <Table.HeaderCell>Datum</Table.HeaderCell>
                    <Table.HeaderCell className="text-right">Total</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.top_bestellungen.map((b) => (
                    <Table.Row key={b.id}>
                      <Table.Cell>
                        <Link to={`/orders/${b.id}`} className="text-ui-fg-interactive hover:underline">
                          #{b.display_id ?? b.id}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>{b.kunde}</Table.Cell>
                      <Table.Cell>{datum(b.created_at)}</Table.Cell>
                      <Table.Cell className="text-right">{chf.format(b.total)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </Container>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Container className="p-0">
              <ProduktTabelle titel="Top-Produkte nach Umsatz" zeilen={data.top_produkte_umsatz} />
            </Container>
            <Container className="p-0">
              <ProduktTabelle
                titel="Top-Produkte nach Stückzahl"
                zeilen={data.top_produkte_menge}
                nachMenge
              />
            </Container>
          </div>
        </>
      ) : null}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Verkauf",
  icon: ChartBar,
})

export default VerkaufSeite
