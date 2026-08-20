# Reguläre Preise und Aktions-Preisliste (Durchstreichpreise)

Auf jibbit.ch steht bei jedem Artikel ein durchgestrichener regulärer Preis
neben dem Aktionspreis. In Medusa waren bisher nur die Aktionspreise da (als
Standardpreise der Varianten, importiert aus `data/catalog.json`). Dieser
Import stellt die Datenlage her, die die Storefront für den Durchstreicher
braucht — sie zeigt ihn von selbst, sobald `original_amount >
calculated_amount` ist (`lib/adapters.ts`, `compareAt`).

## Das Modell

Medusa berechnet Preise so: Standardpreis der Variante = `original_amount`;
greift eine aktive **Price List** (Typ `sale`), liefert deren Preis den
`calculated_amount`. Price-List-Preise tragen dieselben
`min_quantity`/`max_quantity`-Spalten wie Standardpreise — **Mengenstaffeln
können also vollständig in der Preisliste leben** (verifiziert an
`CreatePriceListPriceWorkflowDTO`, `@medusajs/types/dist/pricing/workflows.d.ts`,
und am Modell `@medusajs/pricing/dist/models/price.js`).

Deshalb:

| | vorher | nachher |
|---|---|---|
| Standardpreis der Variante | Aktions-Staffeln | **ein** regulärer Preis |
| Price List „Aktionspreise jibbit.ch" | — | Aktions-Staffeln (`min`/`max_quantity`) |

Der Warenkorb rechnet Mengenrabatte weiter automatisch: die Staffel greift
jetzt aus der Preisliste statt aus dem Standardpreis.

## Die drei Bausteine

1. **`scripts/jibbit-shop-prices.mjs`** — erhebt die regulären Preise vom
   öffentlichen Shop (jibbit.ch, Odoo). Keine Zugangsdaten nötig: die
   öffentliche JSON-Route `/website_sale/get_combination_info` liefert
   `list_price` (regulär) und `price` (Aktion) strukturiert; aus dem HTML
   werden nur die Produkt-IDs der Links gelesen. Ergebnis:
   `data/price-lists.json` — versioniert, damit der Import nachvollziehbar
   ist und Zahlen von Hand korrigierbar sind, ohne neu zu erheben.
2. **`backend/src/scripts/price-list-mapping.ts`** — ordnet die
   Odoo-Produktnamen den Medusa-Produkten und -Varianten zu (reine Logik,
   unit-getestet). Gebinde wie „Display: 25x Smoking Brown kurz" sind in
   Odoo eigene Produkte, in Medusa Varianten — die Stückzahl aus dem Namen
   bestimmt die Variante. Unsichere Zuordnungen werden gemeldet, nie geraten.
3. **`backend/src/scripts/import-price-lists.ts`** — schreibt beides nach
   Medusa: Standardpreis ← regulär, Preisliste ← Staffeln. Idempotent: die
   Liste wird über ihren Titel wiedergefunden und aktualisiert, nie doppelt
   angelegt; ein Lauf ohne Datenänderung schreibt nichts.

## Ablauf auf der VPS

Reihenfolge einhalten — die Preisliste setzt voraus, dass die Produkte
existieren (Katalogimport, siehe `data/README.md`).

```bash
cd ~/medusa-ecom

# 1. (nur bei Neuerhebung) reguläre Preise vom Live-Shop ziehen.
#    Läuft auf jeder Maschine mit Node 20 — auch lokal, dann committen.
node scripts/jibbit-shop-prices.mjs

# 2. Daten in den Container bringen (wie beim Katalog):
docker compose cp ./data medusa:/app/data

# 3. Probelauf — zeigt Zuordnung, Preise und was fehlt:
docker compose exec medusa npx medusa exec \
  ./src/scripts/import-price-lists.js /app/data/price-lists.json dry-run

# 4. Ernstfall:
docker compose exec medusa npx medusa exec \
  ./src/scripts/import-price-lists.js /app/data/price-lists.json
```

Erwartung bei diesem Datenstand (August 2026): 20 Odoo-Preise, alle 20
zugeordnet (3 über die Artikelnummer, 4 unscharf — sie werden im Log
namentlich zum Gegenlesen aufgeführt), 13 Katalog-Varianten ohne Gegenstück
auf jibbit.ch (Kailar, OCB KSS/Rolls/Bio, RAW Black, Gizeh, Purize SUPER
SLIM, Angel- und Zig-Zag-Display …) — die behalten ihre bisherigen Preise
und zeigen keinen Durchstreicher.

Der zweite Lauf meldet „Preisliste … ist aktuell" und schreibt nichts.

## Prüfen

```bash
# Publishable Key und Region-ID besorgen (einmalig):
docker compose exec postgres psql -U medusa -c \
  "select token from api_key where type='publishable';"
docker compose exec postgres psql -U medusa -c "select id from region;"

curl -s "http://127.0.0.1:9000/store/products?region_id=<REGION>&fields=title,*variants.calculated_price" \
  -H "x-publishable-api-key: <TOKEN>" \
  | python3 -m json.tool | grep -A2 -E "original_amount|calculated_amount" | head
```

`original_amount` muss über `calculated_amount` liegen, z.B. Greengo
Unbleached Slim Rolls 2.50 / 1.95 (−22 %) wie auf jibbit.ch.

## Betriebsregeln

- **Die Preisliste gehört dem Import.** Von Hand im Admin ergänzte Preise in
  „Aktionspreise jibbit.ch" ersetzt der nächste Lauf. Preisänderungen in
  `data/price-lists.json` bzw. `data/catalog.json` machen, committen,
  importieren.
- **Staffelpreise nie im Admin anfassen** — die Preismaske kennt keine
  Staffeln und überschreibt sie stillschweigend (siehe
  `docs/product-pricing-model.md`, §3).
- Odoo-Preise geändert? `node scripts/jibbit-shop-prices.mjs` neu laufen
  lassen. Weicht der Aktionspreis der Website von `catalog.json` ab, warnt
  der Import — dann ist der Katalog veraltet und muss zuerst neu erhoben
  werden.
- Es wird auf CHF 0.05 gerundet (`round=0.01` für rappengenau), wie überall
  im Projekt.

## Grenzen der Erhebung — und der Weg über JSON-RPC

Der Shop-Weg sieht nur **veröffentlichte** Produkte und nur den Preis für
**Menge 1**; die MwSt.-Sicht ist die der Website. Für die fehlenden 13
Varianten gibt es auf jibbit.ch schlicht keinen regulären Preis. Wer die
Odoo-Zugangsdaten hat (`ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY`),
kann die Listenpreise stattdessen über `product.template.list_price` per
JSON-RPC ziehen — `scripts/odoo-export.mjs` exportiert das Feld bereits
(`PRODUCT_FIELDS`), auch für unveröffentlichte Produkte. Die Ausgabe müsste
dann nur nach `data/price-lists.json` überführt werden (gleiches Format);
Zuordnung und Import bleiben identisch.
