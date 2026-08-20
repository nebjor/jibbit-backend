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
