# Referenzdaten

Produkte, Preise, Bestand, EAN, Gewicht und Marke werden im Admin gepflegt —
Preise im Widget «Preistabelle» auf der Produktseite. Die früheren
Katalogdateien und Import-Scripts sind entfernt (Git-Historie).

Was hier noch liegt, ist Recherche- und Übergangsmaterial:

- **`odoo-redirects.json`** — alte `/shop/…`-URLs von jibbit.ch → neue
  `/products/…`-Pfade, für die Weiterleitungen in der Storefront.
- **`gtin-*.json`, `gtin-scan-sheet.csv`, `product-inventory.json`** —
  GTIN-Kandidaten aus Lieferantenshops und die Scan-Arbeitsliste (siehe
  `docs/product-inventory.md`). Nur an der Ware geprüfte Nummern gehören ins
  Admin (Variante → EAN).
