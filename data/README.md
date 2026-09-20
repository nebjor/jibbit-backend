# Katalogdaten

`catalog.json` ist der Produktstamm von jibbit.ch: 26 Produkte mit Varianten
und Mengenstaffeln, aus Odoo gezogen.

`price-lists.json` sind die **regulären** Preise (und zur Kreuzprüfung die
Aktionspreise) vom öffentlichen Shop, erhoben mit
`scripts/jibbit-shop-prices.mjs`. Import und Zuordnung: siehe
`docs/preislisten.md`.

## Warum die Datei hier liegt

Sie wurde vorher von Hand auf die VPS übertragen. Das ist zweimal
gescheitert — `scp` war nicht eingerichtet, und ein Einfügen über die
Zwischenablage verliert bei dieser Grösse zuverlässig die Mitte, weil der
Eingabepuffer der Konsole überläuft. Im Repository ist sie in Sekunden auf
jeder Maschine, und der Import bleibt nachvollziehbar.

Es sind Produkt- und Preisdaten, keine Personendaten. Die Preise stehen
ohnehin im Shop.

## Einspielen

    docker compose cp ./data medusa:/app/data
    docker compose exec medusa npx medusa exec \
      ./src/scripts/import-catalog.js /app/data/catalog.json dry-run
    docker compose exec medusa npx medusa exec \
      ./src/scripts/import-catalog.js /app/data/catalog.json

Erwartet: 25 Produkte mit 32 Varianten. `OCB Bio Slim Organic Hemp Rolls`
fehlt bewusst — für die Einzelpackung gibt es in den Odoo-Daten keinen Preis
für Menge 1, nur den Gebindepreis.

Die Mengenstaffeln stecken in dieser Datei. `import-price-tiers.ts` wird für
diesen Datenstand **nicht** gebraucht: das zugehörige `tiers.json` stammt aus
einem Copy-Paste der Odoo-Listenansicht ohne Artikelnummern, alle SKUs sind
dort `null`, und das Script überspringt solche Zeilen zu Recht.

## Ergänzende Dateien (Katalog-Vervollständigung)

Alle vier stammen aus einem vollständigen Auslesen der 33 Produktseiten der
laufenden Odoo-Sitemap (Stand 2026-08-20). `catalog.json` bleibt unberührt.

- **`catalog-extra.json`** — gleiches Format wie `catalog.json`. Drei
  Einträge: die zwei Produkte, die dort ganz fehlen (Black Leaf El Humeros,
  Silikon Dose), und ein **vervollständigter** OCB-Bio-Eintrag — die
  Odoo-Produktseite zeigt CHF 2.00 als Einzelpreis, damit existiert jetzt die
  Staffel ab Menge 1. Bei `update-catalog.ts` als `extra=` mitgeben; gleiche
  Handles überschreiben dann den Stand aus `catalog.json`.
- **`product-content.json`** — Untertitel und Beschreibung je Handle.
  `source` sagt je Feld, ob der Text wörtlich von der Odoo-Seite stammt
  (`odoo`) oder aus den dort sichtbaren Fakten formuliert wurde
  (`generiert`) — Odoo hat nur für eine Handvoll Produkte echte Texte.
- **`inventory.json`** — Bestand je SKU, vom Betreiber zu pflegen.
  `quantity: null` heisst "noch nicht gezählt" und wird übersprungen; eine
  Zahl (auch 0) schaltet `manage_inventory` ein und setzt den Bestand.
  Odoo veröffentlicht keine Bestandszahlen auf den Produktseiten — die
  Werte müssen aus dem Odoo-Backend oder per Zählung kommen.
- **`odoo-redirects.json`** — Zuordnung aller 33 alten `/shop/…`-URLs auf
  die neuen `/products/…`-Pfade, inklusive der fünf Display-/Box-Seiten,
  die in Medusa Varianten sind. Einzubauen in der Next.js-Storefront
  (siehe PR); am robustesten über die Odoo-ID am Pfadende.

## GTIN je Variante

Eine Variante in `catalog.json` / `catalog-extra.json` darf ein optionales
`"gtin"` tragen — als **String** (führende Nullen), 8/12/13/14 Ziffern, je
Packung eine eigene Nummer (Einzelstück und Display sind zwei Artikel).
Import und Update prüfen die GS1-Prüfziffer und auf Doppelte und brechen bei
einem Fehler ab, bevor etwas geschrieben wird.

Abgelegt wird **jede** gültige GTIN — 8, 12, 13 oder 14 Ziffern — in Medusas
nativer Varianten-Spalte `ean`, nicht in `metadata`. Das ist dieselbe Spalte,
die der Galaxus-Export liest (`galaxus-common.ts` kennt nur `variants.ean`
und nimmt dort 8–14 Ziffern): eine UPC-A von RAW oder die EAN-8 von Greengo
steht damit genauso im Feed wie eine EAN-13. `upc` und `barcode` schreiben
die Katalog-Scripts nicht; die Felder bleiben frei für das, was im Admin
dort gepflegt wird (z. B. ein hauseigener Lagercode). Die Storefront liest
`ean` zuerst, prüft selbst nach und gibt die Nummer je nach Länge im
Produkt-Schema als `gtin8`/`gtin12`/`gtin13`/`gtin14` aus. Ohne `gtin` (und
ohne `ean`) im Katalog fasst `update-catalog.ts` die Spalte nicht an.

Nur an der Ware geprüfte Nummern eintragen — `gtin-candidates.json` sind
Vorschläge, keine Daten.

**`gtin` oder `ean`?** Beide Katalogfelder landen in derselben Spalte
`variant.ean` und werden gleich geprüft (Länge 8/12/13/14, GS1-Prüfziffer,
keine Doppelten). `gtin` ist der Weg, eine Nummer einzutragen — neue Nummern
gehören dorthin. Das Galaxus-Feld `ean` (nächster Abschnitt) bleibt für
bestehende Einträge gültig und bedeutet dasselbe. Stehen beide an derselben
Variante, müssen sie gleich lauten — sonst bricht der Lauf ab.

## Galaxus-Felder: `ean`, `weight_g`, `brand`

Für die Anbindung ans Digitec-Galaxus-Händlerprogramm (siehe
`docs/galaxus-marktplatz.md`) kennt das Katalogformat drei zusätzliche,
optionale Felder — je Variante `ean` (GTIN, 8/12/13/14 Ziffern mit gültiger
GS1-Prüfziffer, als String, damit führende Nullen überleben; gleichbedeutend
mit `gtin`, siehe oben) und `weight_g` (Verpackungsgewicht in Gramm), je
Produkt `brand` (Marke):

    {
      "product": "Gizeh DW Extra Fine",
      "ref": null,
      "brand": "Gizeh",
      "variants": [
        {
          "label": "Einzeln",
          "pack_type": "single",
          "units_per_pack": 1,
          "ean": "4012345678901",
          "weight_g": 25,
          "tiers": [ … ]
        }
      ]
    }

`import-catalog.ts` und `update-catalog.ts` prüfen die EANs (8/12/13/14 Ziffern,
GS1-Prüfziffer, keine Duplikate) und brechen bei Fehlern ab, bevor etwas geschrieben wird.
Fehlende Felder sind erlaubt und löschen nie einen Wert in Medusa. Das
Gewicht schaltet nebenbei den Brieftarif (CHF 3.75) des
swiss-shipping-Moduls frei, der ohne Varianten-Gewichte nie greift.

Was noch fehlt, zeigt der Bereitschaftsbericht:

    cd backend
    npx medusa exec ./src/scripts/galaxus-report.ts

## Nachschub: Meldebestand und Lieferanten — NICHT hier

Meldebestand (`reorder_point`) und Lieferanten (`suppliers`) der
Nachschubsteuerung sind **keine Katalogfelder mehr**. Der Betreiber pflegt
sie laufend — im Admin, im Widget «Nachschub» an der Produktseite.
Gespeichert wird über die Admin-API in die `metadata` der Variante (gleiche
Schlüssel, keine Datenbankmigration); `import-catalog.ts` und
`update-catalog.ts` fassen die Varianten-Metadaten nicht an. So verlangt
eine Änderung keinen Build und kein `git pull` — und ein `git pull` kann
die Eingaben nicht überschreiben.

Die Lieferanten-`url` muss eine absolute `http(s)`-Adresse sein — geprüft
beim Speichern im Formular, beim Schreiben über die Admin-API
(`src/api/middlewares.ts`) und beim Rendern
(`backend/src/lib/nachschub.ts`), denn die Adresse wird im Admin als Link
gerendert, und dort sitzt jemand mit vollen Rechten.

Der Bericht fürs Terminal (Konsole, optional CSV zum Ausdrucken) liest nur:

    cd backend
    npx medusa exec ./src/scripts/nachschub-report.ts
    npx medusa exec ./src/scripts/nachschub-report.ts csv=../export/nachschub.csv

## Nachziehen bestehender Produkte

    cd backend
    npx medusa exec ./src/scripts/update-catalog.ts ../data/catalog.json \
      extra=../data/catalog-extra.json \
      content=../data/product-content.json \
      inventory=../data/inventory.json \
      dry-run

`dry-run` zeigt jede Änderung Feld für Feld; ohne die Option wird
geschrieben. Das Script ist idempotent und legt nichts an — neue Produkte
zuerst mit `import-catalog.ts` (auch mit `catalog-extra.json`) anlegen.
`extra=` immer mitgeben: ohne die Datei würde der unvollständige
OCB-Bio-Eintrag greifen (das Script sperrt das und warnt nur).
