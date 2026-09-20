# Produktinventar jibbit.ch — GTIN-Arbeitsliste

Stand: 2026-09-20 · generiert aus `data/product-inventory.json` (dort alle Felder maschinenlesbar).

## Überblick

| Kennzahl | Wert |
|---|---|
| Odoo-Produktseiten live (jibbit.ch) | 33 |
| davon Display-/Box-Seiten, die in Medusa Varianten sind | 5 |
| logische Produkte live | 28 |
| Produkte in `catalog.json` | 26 |
| zusätzlich nur in `catalog-extra.json` | 2 (Black Leaf El Humeros Konische Hülsen KS 100x, Silikon Dose ø 22mm hellgrün) |
| Varianten gesamt | 35 |
| GTIN **vorhanden** | 3 |
| GTIN **vorschlag** (unverifiziert) | 22 — Vertrauen: hoch 9, niedrig 8, mittel 5 |
| GTIN **fehlt** | 10 |

Einzelpackung und Display/Box tragen normalerweise **verschiedene** GTINs — jede Zeile unten braucht ihre eigene Nummer. Vorschläge sind Kandidaten aus fremden Shops bzw. vom Grosshändler und gehören erst nach einem Scan an der Ware in den Katalog.

Live ↔ Katalog: alle 28 live verkauften Produkte sind im Katalog (26 in `catalog.json`, 2 nur in `catalog-extra.json`); kein Katalogprodukt fehlt live. Spalte «Katalog»: K = `catalog.json`, X = `catalog-extra.json`; «Test» = auf test.jibbit.ch vorhanden.

## Angel

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Angel Slim Filters 6mm 120stk | Einzeln | `ANG-SLI-FIL-6MM-120-EA` | [/shop/angel-slim-filters-6mm-120stk-13](https://jibbit.ch/shop/angel-slim-filters-6mm-120stk-13) | K | ja | **fehlt** | — |
| Angel Slim Filters 6mm 120stk | Display (34 Stk.) | `ANG-SLI-FIL-6MM-120-D34` | [/shop/angel-slim-filters-6mm-120stk-13](https://jibbit.ch/shop/angel-slim-filters-6mm-120stk-13) | K | ja | **fehlt** | — |

## Black Leaf

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Black Leaf El Humeros Konische Hülsen KS 100x | Einzeln | `BLA-LEA-EL-HUM-KON-HUE-EA` | [/shop/black-leaf-el-humeros-konische-hulsen-ks-100x-47](https://jibbit.ch/shop/black-leaf-el-humeros-konische-hulsen-ks-100x-47) | X | nein | **fehlt** | — |

## dubi

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| dubi Aktivkohlefilter ø7mm | Einzeln | `DUB-AKT-O7M-EA` | [/shop/dubi-aktivkohlefilter-7mm-49](https://jibbit.ch/shop/dubi-aktivkohlefilter-7mm-49) | K | ja | vorschlag `9120089700019` · hoch · sunvi · 2 Quellen einig: 9120089700019 | Knistermann |

## Elements

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Elements BLUE Rolls SW | Einzeln | `ELE-BLU-ROL-SW-EA` | [/shop/elements-blue-rolls-sw-58](https://jibbit.ch/shop/elements-blue-rolls-sw-58) | K | ja | **fehlt** | Knistermann |
| Elements BLUE Rolls SW | Box (24 Stk.) | `ELE-BLU-ROL-SW-BX24` | [/shop/box-24x-elements-blue-rolls-sw-59](https://jibbit.ch/shop/box-24x-elements-blue-rolls-sw-59) | K | ja | vorschlag `716165251200` · niedrig · knistermann | Knistermann |
| Elements King Slim Size Ultra Thin | Einzeln | `ELE-KIN-SLI-SIZ-ULT-THI-EA` | [/shop/elements-king-slim-size-ultra-thin-56](https://jibbit.ch/shop/elements-king-slim-size-ultra-thin-56) | K | nein | **fehlt** | Knistermann |
| Elements King Slim Size Ultra Thin | Box (50 Stk.) | `ELE-KIN-SLI-SIZ-ULT-THI-BX50` | [/shop/box-50x-elements-king-slim-size-ultra-thin-57](https://jibbit.ch/shop/box-50x-elements-king-slim-size-ultra-thin-57) | K | nein | vorschlag `716165177821` · niedrig · knistermann | Knistermann |

## Gizeh

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Gizeh DW Extra Fine | Einzeln | `GIZ-DW-EXT-FIN-EA` | [/shop/gizeh-dw-extra-fine-61](https://jibbit.ch/shop/gizeh-dw-extra-fine-61) | K | ja | vorschlag `4002604291101` · niedrig · hemagnova | Hemag Nova |

## Greengo

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Greengo Unbleached Slim Rolls | Einzeln | `GRE-UNB-SLI-ROL-EA` | [/shop/greengo-unbleached-slim-rolls-24](https://jibbit.ch/shop/greengo-unbleached-slim-rolls-24) | K | ja | vorhanden `85966789` (= Vorschlag candidates; Scan an der Ware nicht dokumentiert) | — |
| Greengo Unbleached Slim Rolls | Display (24 Stk.) | `GRE-UNB-SLI-ROL-D24` | [/shop/display-24x-greengo-unbleached-slim-rolls-31](https://jibbit.ch/shop/display-24x-greengo-unbleached-slim-rolls-31) | K | ja | vorhanden `8595134501285` (= Vorschlag candidates; Scan an der Ware nicht dokumentiert) | — |

## Kailar

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Kailar Filter 5.9mm 65stk pink | Einzeln | `KAI-FIL-5-9MM-65S-PIN-EA` | [/shop/kailar-filter-5-9mm-65stk-pink-27](https://jibbit.ch/shop/kailar-filter-5-9mm-65stk-pink-27) | K | ja | vorschlag `4270000724510` · niedrig · sunvi | Knistermann (vermutet) |
| Kailar Filter 5.9mm 65stk schwarz | Einzeln | `KAI-FIL-5-9MM-65S-SCH-EA` | [/shop/kailar-filter-5-9mm-65stk-schwarz-26](https://jibbit.ch/shop/kailar-filter-5-9mm-65stk-schwarz-26) | K | ja | vorschlag `4270000724510` · niedrig · knistermann · 2 Quellen einig: 4270000724510 | Knistermann |
| Kailar Filter 5.9mm 65stk weiss | Einzeln | `KAI-FIL-5-9MM-65S-WEI-EA` | [/shop/kailar-filter-5-9mm-65stk-weiss-11](https://jibbit.ch/shop/kailar-filter-5-9mm-65stk-weiss-11) | K | ja | vorschlag `4270000724510` · niedrig · knistermann · 2 Quellen einig: 4270000724510 | Knistermann |
| Kailar Filter 9mm BIG 100 stk schwarz | Einzeln | `KAI-FIL-9MM-BIG-100-STK-EA` | [/shop/kailar-filter-9mm-big-100-stk-schwarz-29](https://jibbit.ch/shop/kailar-filter-9mm-big-100-stk-schwarz-29) | K | ja | vorschlag `4262430130191` · hoch · sunvi | Knistermann (vermutet) |

## No-Name (Silikon)

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Silikon Dose ø 22mm hellgrün | Einzeln | `SIL-DOS-O-22M-HEL-EA` | [/shop/silikon-dose-22mm-55](https://jibbit.ch/shop/silikon-dose-22mm-55) | X | ja (`silikon-dose-22-mm`) | vorschlag `0725844729039` · mittel · knistermann | Knistermann |

## OCB

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| OCB Bio Slim Organic Hemp Rolls | Einzeln | `OCB-BIO-SLI-ORG-HEM-ROL-EA` | [/shop/ocb-bio-slim-organic-hemp-rolls-40](https://jibbit.ch/shop/ocb-bio-slim-organic-hemp-rolls-40) | K | nein | vorschlag `3057067323242` · niedrig · hemagnova | Hemag Nova |
| OCB Premium KSS Papers mit Filter | Einzeln | `OCB-PRE-KSS-PAP-MIT-FIL-EA` | [/shop/3-ocb-premium-kss-papers-mit-filter-7](https://jibbit.ch/shop/3-ocb-premium-kss-papers-mit-filter-7) | K | nein | **fehlt** (nur Gebinde-Code bekannt: `3057067331322` sunvi) | — |
| OCB Premium kurz | Einzeln | `OCB-PRE-KUR-EA` | [/shop/5-ocb-premium-kurz-9](https://jibbit.ch/shop/5-ocb-premium-kurz-9) | K | ja | **fehlt** (nur Gebinde-Code bekannt: `3057067096252` sunvi) | — |
| OCB Premium Rolls Slim | Einzeln | `OCB-PRE-ROL-SLI-EA` | [/shop/7-ocb-premium-rolls-slim-3](https://jibbit.ch/shop/7-ocb-premium-rolls-slim-3) | K | ja (`ocb-black-premium-rolls-slim`) | vorschlag `30062092` · mittel · candidates | — |
| OCB Slim Filter Bio (120 Tips) | Einzeln | `OCB-SLI-FIL-BIO-120-TIP-EA` | [/shop/ocb-slim-filter-bio-120-tips-41](https://jibbit.ch/shop/ocb-slim-filter-bio-120-tips-41) | K | ja | vorschlag `3057068104109` · niedrig · hemagnova | Hemag Nova |

## PURIZE

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| PURIZE Aktivkohlefilter ø 9mm | Einzeln | `PUR-AKT-O-9MM-EA` | [/shop/purize-aktivkohlefilter-9mm-60](https://jibbit.ch/shop/purize-aktivkohlefilter-9mm-60) | K | ja | vorschlag `42660748410653` (Prüfziffer ungültig!) → korrigiert `4260748410653` · mittel · knistermann · **KONFLIKT — Quellen nennen verschiedene Nummern: 42660748410653 (knistermann) vs. 4260748410653 (sunvi) vs. 4260748411384 (sunvi)** | Knistermann |
| Purize SUPER SLIM White ø5mm | Einzeln | `PUR-SUP-SLI-WHI-O5M-EA` | [/shop/purize-super-slim-white-5mm-48](https://jibbit.ch/shop/purize-super-slim-white-5mm-48) | K | ja | vorschlag `4260748413173` · hoch · sunvi · **KONFLIKT — Quellen nennen verschiedene Nummern: 4260748413173 (sunvi) vs. 4260748413166 (knistermann)** | Knistermann |
| Purize Xtra SLIM White, 50er Pack, 5.9mm | Einzeln | `PUR-XTR-SLI-WHI-50E-PAC-EA` | [/shop/6-purize-xtra-slim-white-50er-pack-5-9mm-10](https://jibbit.ch/shop/6-purize-xtra-slim-white-50er-pack-5-9mm-10) | K | ja | vorschlag `4260748410363` · hoch · sunvi | Knistermann (vermutet) |
| PURIZE XTRA Slim XMAS ø 6mm | Einzeln | `PUR-XTR-SLI-XMA-O-6MM-EA` | [/shop/purize-xtra-slim-xmas-6mm-54](https://jibbit.ch/shop/purize-xtra-slim-xmas-6mm-54) | K | nein | vorschlag `4260748412169` · hoch · knistermann · 2 Quellen einig: 4260748412169 | Knistermann |

## RAW

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| RAW Black KSS Papers | Einzeln | `RAW-BLA-KSS-PAP-EA` | [/shop/raw-black-kss-papers-2](https://jibbit.ch/shop/raw-black-kss-papers-2) | K | ja | **fehlt** | — |
| RAW Black KSS Papers | Display (50 Stk.) | `RAW-BLA-KSS-PAP-D50` | [/shop/raw-black-kss-papers-2](https://jibbit.ch/shop/raw-black-kss-papers-2) | K | ja | vorschlag `716165250326` · mittel · sunvi | — |
| RAW Classic Rolls Slim | Einzeln | `RAW-CLA-ROL-SLI-EA` | [/shop/4-raw-classic-rolls-slim-8](https://jibbit.ch/shop/4-raw-classic-rolls-slim-8) | K | ja | vorhanden `716165280293` (= Vorschlag candidates; Scan an der Ware nicht dokumentiert) | — |
| RAW Kristallglas Aschenbecher Darkside | Einzeln | `RAW-KRI-ASC-DAR-EA` | [/shop/raw-kristallglas-aschenbecher-darkside-52](https://jibbit.ch/shop/raw-kristallglas-aschenbecher-darkside-52) | K | ja | vorschlag `716165299530` · hoch · knistermann | Knistermann |
| RAW Kristallglas Aschenbecher Rainbow | Einzeln | `RAW-KRI-ASC-RAI-EA` | [/shop/raw-kristallglas-aschenbecher-rainbow-50](https://jibbit.ch/shop/raw-kristallglas-aschenbecher-rainbow-50) | K | ja | vorschlag `716165299523` · hoch · knistermann | Knistermann |
| RAW Kristallglas Aschenbecher Ruby | Einzeln | `RAW-KRI-ASC-RUB-EA` | [/shop/raw-kristallglas-aschenbecher-ruby-51](https://jibbit.ch/shop/raw-kristallglas-aschenbecher-ruby-51) | K | ja | vorschlag `716165310556` · hoch · knistermann | Knistermann |

## Smoking

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Smoking Brown kurz (double window) | Einzeln | `SMO-BRO-KUR-DOU-WIN-EA` | [/shop/smoking-brown-kurz-double-window-28](https://jibbit.ch/shop/smoking-brown-kurz-double-window-28) | K | ja | **fehlt** | — |
| Smoking Brown kurz (double window) | Display (25 Stk.) | `SMO-BRO-KUR-DOU-WIN-D25` | [/shop/display-25x-smoking-brown-kurz-double-window-34](https://jibbit.ch/shop/display-25x-smoking-brown-kurz-double-window-34) | K | ja | vorschlag `8414775014698` · hoch · sunvi | — |

## Zig-Zag

| Produkt | Variante | SKU | Live-URL | Katalog | Test | GTIN-Status | Lieferant |
|---|---|---|---|---|---|---|---|
| Zig Zag Slim Filter 6mm 120stk | Einzeln | `ZIG-ZAG-SLI-FIL-6MM-120-EA` | [/shop/zig-zag-slim-filter-6mm-120stk-32](https://jibbit.ch/shop/zig-zag-slim-filter-6mm-120stk-32) | K | ja | **fehlt** | — |
| Zig Zag Slim Filter 6mm 120stk | Display (34 Stk.) | `ZIG-ZAG-SLI-FIL-6MM-120-D34` | [/shop/display-34x-zig-zag-slim-filter-6mm-120stk-33](https://jibbit.ch/shop/display-34x-zig-zag-slim-filter-6mm-120stk-33) | K | ja | vorschlag `3057068011346` · mittel · sunvi | — |

## Nur auf test.jibbit.ch (nicht live, nicht im Katalog)

| Handle | Titel | Varianten |
|---|---|---|
| `elements-ultra-thin-king-size-slim-kss` | Elements Ultra Thin King Size Slim | 5er Pack = CHF 13.5; 1 Heftchen = CHF 2.9 |
| `raw-classic-king-size-slim` | RAW Classic King Size Slim | 1 Heftchen = CHF 2.5; Box (50 Heftchen) = CHF 99 |
| `purize-xtra-slim-6mm` | PURIZE XTRA Slim Aktivkohlefilter 6 mm | 50 Stück = CHF 6.5; 100 Stück = CHF 10.9 |
| `purize-aktivkohlefilter-6mm` | PURIZE Aktivkohlefilter 9 mm | 50 Stück = CHF 5.9; 100 Stück = CHF 9.9; 250 Stück = CHF 21.9 |

Vermutlich Seed-/Demo-Reste oder Handanlagen im Admin — vor dem Go-live klären; GTIN hier nicht bewertet.

## GTIN-Vorschläge ohne passendes jibbit-Produkt

- shop.knistermann.de ZU-SI-24 — Silikon Schüssel, ø ca. 65mm: `4014663817505` — Kein passendes Produkt in catalog.json / catalog-extra.json gefunden (Silikon Schüssel ø65mm ist bei jibbit nicht gelistet).
- shop.hemagnova.ch RB8294 — Parisienne Authentique 6x25 gr. Beutel: `7612800211185` — Kein Tabak in catalog.json / product-content.json — kein passendes jibbit-Produkt. Nur der Vollständigkeit halber erfasst.

## Namensabweichungen je Produkt

- **Angel Slim Filters 6mm 120stk** (Odoo-ID 13): EN/FR/IT-Seiten zeigen «Angel Slim Filters» statt «Angel Slim Filters 6mm 120stk»
- **Elements King Slim Size Ultra Thin** (Odoo-ID 56): EN/FR/IT-Seiten zeigen «Elements King Size Ultra Thin» statt «Elements King Slim Size Ultra Thin»
- **Gizeh DW Extra Fine** (Odoo-ID 61): EN/FR/IT-Seiten zeigen «Gizeh DW Extra Fine (Kopie)» statt «Gizeh DW Extra Fine»
- **Kailar Filter 5.9mm 65stk schwarz** (Odoo-ID 26): EN/FR/IT-Seiten zeigen «Kailar Filer 5.9mm 65stk schwarz» statt «Kailar Filter 5.9mm 65stk schwarz»
- **Kailar Filter 5.9mm 65stk weiss** (Odoo-ID 11): EN/FR/IT-Seiten zeigen «(COMING SOON)» statt «Kailar Filter 5.9mm 65stk weiss»
- **OCB Bio Slim Organic Hemp Rolls** (Odoo-ID 40): EN/FR/IT-Seiten zeigen «OCB Bio Slim Organic Hemp Rolls (24)» statt «OCB Bio Slim Organic Hemp Rolls»
- **OCB Slim Filter Bio (120 Tips)** (Odoo-ID 41): EN/FR/IT-Seiten zeigen «OCB Slim Filter Bio (10x120 Tips)» statt «OCB Slim Filter Bio (120 Tips)»
- **Purize SUPER SLIM White ø5mm** (Odoo-ID 48): EN/FR/IT-Seiten zeigen «Purize Super SLIM White, 50er Pack, 5mm (Kopie)» statt «Purize SUPER SLIM White ø5mm»
- **Purize Xtra SLIM White, 50er Pack, 5.9mm** (Odoo-ID 10): EN/FR/IT-Seiten zeigen «PURIZE White, 50er Pack» statt «Purize Xtra SLIM White, 50er Pack, 5.9mm»
- **PURIZE XTRA Slim XMAS ø 6mm** (Odoo-ID 54): EN/FR/IT-Seiten zeigen «PURIZE XTRA Slim XMAS ø 5,9mm» statt «PURIZE XTRA Slim XMAS ø 6mm»
- **Smoking Brown kurz (double window)** (Odoo-ID 28): EN/FR/IT-Seiten zeigen «Smoking Brown Double Window» statt «Smoking Brown kurz (double window)»
- **Black Leaf El Humeros Konische Hülsen KS 100x** (Odoo-ID 47): Katalog «Black Leaf El Humeros Konische Hülsen KS 100x» vs. live (DE) «Black Leaf El Humeros Konische Hülsen KS 100X»; EN/FR/IT-Seiten zeigen «Black Leaf El Humeros Konische Hülsen KS 100X (Kopie)» statt «Black Leaf El Humeros Konische Hülsen KS 100X»
- **Silikon Dose ø 22mm hellgrün** (Odoo-ID 55): Katalog «Silikon Dose ø 22mm hellgrün» vs. live (DE) «Silikon Dose ø 22mm»; EN/FR/IT-Seiten zeigen «Silikon Dose ø 22mm, hellgrün» statt «Silikon Dose ø 22mm»

## Auffälligkeiten

- jibbit.ch liefert KEIN JSON-LD. Einzige strukturierte Daten: Microdata schema.org/Product (name, url, image) + Offer (price, priceCurrency, dazu das nicht standardisierte «listPrice»). Kein brand, sku, gtin, availability, description.
- test.jibbit.ch liefert je Produkt einen JSON-LD-Product-Block mit name, description, image, offers (ein Offer, nur erste Variante) — ohne sku, gtin, brand; «brand» ist im Seiten-Payload überall leer.
- Odoo-Produktseiten zeigen keine interne Referenz; sie steckt nur im display_name des öffentlichen Endpunkts /website_sale/get_combination_info. Nur 5 Produkte haben eine: [7] OCB Premium Rolls Slim, [3] OCB Premium KSS Papers mit Filter, [4] RAW Classic Rolls Slim, [5] OCB Premium kurz, [6] Purize Xtra SLIM White — deckungsgleich mit «ref» in catalog.json.
- Die EN/FR/IT-Sprachversionen sind unübersetzt und tragen alte Arbeitsnamen: «(COMING SOON)» (ID 11 = Kailar weiss), «Kailar Filer …» (ID 26, Tippfehler), «(Kopie)» an ID 47, 48, 61, «PURIZE White, 50er Pack» (ID 10), «Angel Slim Filters» (13), «Smoking Brown Double Window» (28), «OCB Bio Slim Organic Hemp Rolls (24)» (40), «OCB Slim Filter Bio (10x120 Tips)» (41), «Silikon Dose ø 22mm, hellgrün» (55), «Elements King Size Ultra Thin» (56), «PURIZE XTRA Slim XMAS ø 5,9mm» (54). Die DE-Seiten sind sauber. Echte COMING-SOON-Platzhalter ohne Produkt gibt es keine.
- Widerspruch Durchmesser: PURIZE XMAS heisst DE «ø 6mm», EN/FR/IT «ø 5,9mm»; Knistermann führt den Artikel als ø 5,9mm.
- Widerspruch Format: DE «Elements King Slim Size Ultra Thin», EN/FR/IT «Elements King Size Ultra Thin»; die Knistermann-Bestellung war King Size (nicht Slim) — vor GTIN-Übernahme am Heftchen klären.
- Odoo-Anzeigename ID 29 hat ein doppeltes Leerzeichen («Kailar Filter 9mm BIG  100 stk schwarz»). Katalog schreibt «KS 100x», live «KS 100X» (Black Leaf).
- Black Leaf (ID 47): Microdata-Preis ist «17.900000000000002» (Float-Artefakt); die Staffeltabelle im Seitentext nennt dagegen «1 CHF 15.20». dubi (ID 49): Preis 7.50, Staffeltext «1 CHF 7.90».
- Streichpreise auf live teils unplausibel: RAW Black KSS Einzeln zeigt CHF 55 durchgestrichen (= Display-Listenpreis), Display Smoking Brown CHF 50.
- Odoo führt Display/Box uneinheitlich: 5× als eigenes Produkt (ID 31, 33, 34, 57, 59), 2× als Variante per Attribut «Menge» (RAW Black KSS: product.product 64/65; Angel: 72/73). Zusammen 33 Templates = 35 verkaufbare Einheiten = exakt die 35 Katalogvarianten.
- Verfügbarkeit: alle 35 Einheiten sind kaufbar (Warenkorb-Button, allow_out_of_stock_order=true überall, Bestandsanzeige aus). free_qty laut Endpunkt ist kein verlässlicher Bestand (Verbrauchsartikel = 0, mehrere lagergeführte negativ: Gizeh −20, PURIZE XMAS −3, PURIZE 9mm −1, Box Elements BLUE −1).
- catalog.json trägt an 3 Varianten ein «gtin» (uncommitted, während dieser Erhebung am 2026-09-20 eingetragen; zu Beginn der Erhebung hatte keine Variante eines): Greengo Unbleached Slim Rolls Einzeln 85966789, Greengo Unbleached Slim Rolls Display (24 Stk.) 8595134501285, RAW Classic Rolls Slim Einzeln 716165280293 — identisch mit den «hoch»-Vorschlägen aus gtin-candidates.json, dessen _geprueft_am weiterhin null ist. SKUs stehen nur in inventory.json (deterministisch aus skuFor in import-catalog.ts).
- Quellenkonflikt PURIZE Super Slim White ø5mm: Knistermann (ohne Farbangabe) 4260748413166 vs. Sunvi («Weiß») 4260748413173 — am Beutel scannen. Übereinstimmungen: PURIZE XMAS 4260748412169 (Knistermann + Sunvi); dubi 9120089700019 und PURIZE 9mm 4260748410653 — Sunvi bestätigt jeweils die KORRIGIERTE Nummer, nicht den bei Knistermann falsch erfassten Code. Für PURIZE 9mm nennt Sunvi zwei Farben (White 4260748410653, Organic 4260748411384) — Farbe klären.
- Hemag Nova und Sunvi führen für Gizeh, OCB (Rolls, kurz, KSS+Tips, Bio Rolls, Bio Filter) und RAW Classic Rolls nur Gebinde-Codes; jibbit verkauft dort nur «Einzeln» — auch wo gtin-hemagnova.json formal auf «Einzeln» zeigt (Vertrauen niedrig), fehlt die Einzelpackungs-GTIN faktisch weiter. Der in gtin-candidates.json als Falle markierte Code 3057067096252 ist laut Sunvi die 25er-Box «OCB kurz Schwarz Premium».
- gtin-candidates.json: Liste «kein_kandidat» benutzt Handles, die es so nicht gibt (z. B. «kailar-filter-5.9mm-65stk-pink», «purize-aktivkohlefilter-9mm», «purize-xtra-slim-white-50er-5.9mm», «kailar-filter-9mm-big-100stk-schwarz»); die 4 Einträge unter «uebernehmen» stimmen. Auf test.jibbit.ch heisst «ocb-premium-rolls-slim» aber «ocb-black-premium-rolls-slim» (vermutlich im Admin umbenannt) — beim Einspielen per Handle beachten.
- gtin-knistermann.json / gtin-sunvi.json: Kailar weiss, schwarz und (bei Sunvi) pink teilen sich dieselbe GTIN 4270000724510 (nicht farbspezifisch, höchstens eine stimmt); dubi- und PURIZE-9mm-Code sind bei Knistermann falsch erfasst (korrigierte Vorschläge stammen aus Websuche); Elements-Codes gehören vermutlich zur Box, nicht zum Einzelstück; «Silikon Schüssel ø 65mm» (4014663817505) wurde bestellt, ist aber weder live noch im Katalog.
- test.jibbit.ch weicht vom Katalog ab: es fehlen dort elements-king-slim-size-ultra-thin, ocb-bio-slim-organic-hemp-rolls, ocb-premium-kss-papers-mit-filter, purize-xtra-slim-xmas-o-6mm, black-leaf-el-humeros-konische-huelsen-ks-100x; «silikon-dose-22-mm» hat nur «Default variant» zu CHF 0; zusätzlich 4 Produkte, die es sonst nirgends gibt (elements-ultra-thin-king-size-slim-kss, raw-classic-king-size-slim, purize-xtra-slim-6mm, purize-aktivkohlefilter-6mm), darunter «purize-aktivkohlefilter-6mm» mit Titel «PURIZE Aktivkohlefilter 9 mm».
- Preis live ≠ test.jibbit.ch: OCB Premium kurz / Einzeln: live CHF 1.79 vs. test.jibbit.ch CHF 1.8; RAW Black KSS Papers / Einzeln: live CHF 1.89 vs. test.jibbit.ch CHF 1.9

## Quellen

- https://jibbit.ch — sitemap.xml (33 Produkt-URLs) + /shop, /shop/page/2 (20 + 13 Karten; Seite 3 wiederholt Seite 2) in de_CH, en, fr_CH, it; alle 33 Produktseiten (DE) einzeln per GET; Varianten-/Verfügbarkeitsinfo über den öffentlichen Endpunkt /website_sale/get_combination_info (35 Aufrufe).
- https://test.jibbit.ch/sitemap.xml (27 Produkt-URLs), alle 27 Produktseiten per GET (JSON-LD + Varianten aus dem Seiten-Payload).
- Repo: data/catalog.json, data/catalog-extra.json, data/inventory.json (SKUs), data/odoo-redirects.json (Handles), data/gtin-candidates.json, data/gtin-knistermann.json, data/gtin-hemagnova.json, data/gtin-sunvi.json
