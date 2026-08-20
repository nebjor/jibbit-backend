# Katalogdaten

`catalog.json` ist der Produktstamm von jibbit.ch: 26 Produkte mit Varianten
und Mengenstaffeln, aus Odoo gezogen.

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
