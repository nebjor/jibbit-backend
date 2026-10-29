/**
 * Admin-Seite «Offene Warenkörbe» — Warenkörbe, die nie zur Bestellung
 * wurden (Daten: GET /admin/offene-warenkoerbe, nur lesend).
 *
 * Erscheint als Unterpunkt von «Bestellungen». Status:
 *  - «Kasse begonnen»: es gibt eine Zahlungssitzung, der Kunde war also
 *    mindestens bis zur Zahlungsauswahl gekommen.
 *  - «Nur Warenkorb»: Artikel eingelegt, Kasse nie erreicht.
 * Gast-Warenkörbe haben erst nach dem ersten Kassenschritt eine E-Mail.
 */
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ShoppingCart } from "@medusajs/icons"
import {
  Checkbox,
  Container,
  createDataTableColumnHelper,
  DataTable,
  DataTablePaginationState,
  Drawer,
  Heading,
  Label,
  StatusBadge,
  Table,
  Text,
  useDataTable,
} from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import type { OffenerWarenkorb } from "../../../lib/offene-warenkoerbe"
import { sdk } from "../../lib/sdk"

type Antwort = { carts: OffenerWarenkorb[]; count: number }

const SEITE = 20

function geld(betrag: number, waehrung: string | null) {
  try {
    return new Intl.NumberFormat("de-CH", {
      style: "currency",
      currency: (waehrung || "chf").toUpperCase(),
    }).format(betrag)
  } catch {
    return `${betrag.toFixed(2)} ${waehrung ?? ""}`.trim()
  }
}

function zeit(iso: string | Date) {
  return new Date(iso).toLocaleString("de-CH", {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

const col = createDataTableColumnHelper<OffenerWarenkorb>()

const spalten = [
  col.accessor("updated_at", {
    header: "Zuletzt aktiv",
    cell: ({ getValue }) => zeit(getValue()),
  }),
  col.accessor("email", {
    header: "Kunde / E-Mail",
    cell: ({ row }) => {
      const c = row.original
      return (
        <div className="flex flex-col">
          <span>{c.customer?.name || c.email || "Gast (ohne E-Mail)"}</span>
          {c.customer?.name && c.email ? (
            <span className="text-ui-fg-subtle">{c.email}</span>
          ) : null}
        </div>
      )
    },
  }),
  col.accessor("item_count", {
    header: "Artikel",
    cell: ({ getValue }) => getValue(),
  }),
  col.accessor("total", {
    header: "Total",
    cell: ({ row }) => geld(Number(row.original.total) || 0, row.original.currency_code),
  }),
  col.accessor("status", {
    header: "Status",
    cell: ({ row }) =>
      row.original.checkout_started ? (
        <StatusBadge color="orange">Kasse begonnen</StatusBadge>
      ) : (
        <StatusBadge color="grey">Nur Warenkorb</StatusBadge>
      ),
  }),
]

const OffeneWarenkoerbeSeite = () => {
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageSize: SEITE,
    pageIndex: 0,
  })
  const [nurMitEmail, setNurMitEmail] = useState(false)
  const [offen, setOffen] = useState<OffenerWarenkorb | null>(null)

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["offene-warenkoerbe", pagination.pageIndex, nurMitEmail],
    queryFn: () =>
      sdk.client.fetch<Antwort>("/admin/offene-warenkoerbe", {
        query: {
          limit: SEITE,
          offset: pagination.pageIndex * SEITE,
          nur_mit_email: nurMitEmail,
        },
      }),
  })

  // Antwort defensiv lesen: fehlendes/umbenanntes Feld darf die Seite nie abstürzen lassen.
  const carts = useMemo(
    () => (Array.isArray(data?.carts) ? data.carts.filter((c) => !!c) : []),
    [data]
  )
  const columns = useMemo(() => spalten, [])
  const table = useDataTable({
    columns,
    data: carts,
    getRowId: (c) => c.id,
    rowCount: typeof data?.count === "number" ? data.count : carts.length,
    isLoading: isPending,
    pagination: { state: pagination, onPaginationChange: setPagination },
    onRowClick: (_e, row) => setOffen(row),
  })

  return (
    <Container className="divide-y p-0">
      <DataTable instance={table}>
        <DataTable.Toolbar className="flex flex-col items-start justify-between gap-2 md:flex-row md:items-center">
          <div>
            <Heading level="h1">Offene Warenkörbe</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Warenkörbe mit Artikeln, die nicht zur Bestellung wurden — der
              zuletzt bewegte zuerst.
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <Checkbox
              id="nur-mit-email"
              checked={nurMitEmail}
              onCheckedChange={(v) => {
                setNurMitEmail(v === true)
                setPagination((p) => ({ ...p, pageIndex: 0 }))
              }}
            />
            <Label htmlFor="nur-mit-email">Nur mit E-Mail</Label>
          </div>
        </DataTable.Toolbar>
        {isError ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" className="text-ui-fg-error">
              Warenkörbe konnten nicht geladen werden
              {error instanceof Error && error.message ? `: ${error.message}` : "."}
            </Text>
          </div>
        ) : !isPending && !carts.length ? (
          <div className="px-6 py-8">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Keine offenen Warenkörbe — aktuell hat niemand Artikel
              liegengelassen.
            </Text>
          </div>
        ) : (
          <>
            <DataTable.Table />
            <DataTable.Pagination />
          </>
        )}
      </DataTable>

      <Drawer open={!!offen} onOpenChange={(o) => !o && setOffen(null)}>
        <Drawer.Content>
          {offen && (
            <>
              <Drawer.Header>
                <Drawer.Title>
                  {offen.customer?.name || offen.email || "Gast (ohne E-Mail)"}
                </Drawer.Title>
                <Drawer.Description>
                  {offen.checkout_started
                    ? "Kasse begonnen"
                    : "Nur Warenkorb"}{" "}
                  · zuletzt aktiv {zeit(offen.updated_at)}
                </Drawer.Description>
              </Drawer.Header>
              <Drawer.Body className="flex flex-col gap-y-4 overflow-y-auto">
                <div className="flex flex-col gap-y-1">
                  <Text size="small" leading="compact">
                    E-Mail: {offen.email ?? "—"}
                  </Text>
                  <Text size="small" leading="compact">
                    Angelegt: {zeit(offen.created_at)}
                  </Text>
                  <Text size="small" leading="compact">
                    Region: {offen.region ?? "—"}
                  </Text>
                  <Text size="small" leading="compact">
                    Lieferort:{" "}
                    {offen.shipping_city || offen.shipping_country
                      ? [offen.shipping_city, offen.shipping_country?.toUpperCase()]
                          .filter(Boolean)
                          .join(", ")
                      : "noch nicht angegeben"}
                  </Text>
                </div>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>Artikel</Table.HeaderCell>
                      <Table.HeaderCell className="text-right">Menge</Table.HeaderCell>
                      <Table.HeaderCell className="text-right">Preis</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {(offen.items ?? []).map((i) => (
                      <Table.Row key={i.id}>
                        <Table.Cell>
                          <div className="flex items-center gap-x-3">
                            {i.thumbnail ? (
                              <img
                                src={i.thumbnail}
                                alt=""
                                className="h-8 w-8 rounded object-cover"
                              />
                            ) : null}
                            <div>
                              <Text size="small" leading="compact" weight="plus">
                                {i.title}
                              </Text>
                              <Text
                                size="small"
                                leading="compact"
                                className="text-ui-fg-subtle"
                              >
                                {[i.variant_title, i.sku].filter(Boolean).join(" · ") ||
                                  "ohne SKU"}
                              </Text>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="text-right">{i.quantity}</Table.Cell>
                        <Table.Cell className="text-right">
                          {geld(Number(i.unit_price) || 0, offen.currency_code)}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
                <div className="flex justify-between">
                  <Text size="small" leading="compact" weight="plus">
                    Total
                  </Text>
                  <Text size="small" leading="compact" weight="plus">
                    {geld(Number(offen.total) || 0, offen.currency_code)}
                  </Text>
                </div>
              </Drawer.Body>
            </>
          )}
        </Drawer.Content>
      </Drawer>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Offene Warenkörbe",
  icon: ShoppingCart,
  nested: "/orders",
})

export default OffeneWarenkoerbeSeite
