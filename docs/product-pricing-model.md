# Produkt- und Preismodell: Einzeln / Display + Staffelpreise

Status: Entwurf, verifiziert gegen Medusa **2.13.6** (Quellenangaben unten sind
Datei:Zeile in `node_modules/` dieses Repos, Stand 2026-08-05).

Ziel laut Anforderung:

1. In der Produkt-Detailansicht (PDP) wählt der Kunde per Radio zwischen
   **Einzeln** und **Display (x Stk.)**, der Preis wechselt automatisch.
2. Eine **Preistabelle** zeigt alle Mengenstaffeln, damit der Kunde sieht,
   dass sich die ganze Box lohnt.
3. Ändert der Kunde die Stückzahl, greift automatisch die passende Staffel.

Die gute Nachricht vorweg: Punkt 3 kann Medusa nativ. Punkt 1 ist eine
Modellierungsentscheidung. Punkt 2 braucht eine kleine eigene Store-Route.

---

## 1. Die Kernentscheidung: Display ist eine Variante, keine Menge

Es gibt zwei Wege, ein Display abzubilden:

| | A: eigene Variante | B: nur Menge × Einzelartikel |
|---|---|---|
| Lagerbestand | getrennt zählbar | falsch — ein Display im Regal ist 1 Stück, nicht 24 |
| SKU / Barcode | eigener EAN, wie beim Lieferanten | keiner |
| Einkauf | 1:1 zur Lieferantenbestellung | Umrechnung bei jeder Bestellung |
| Versandgewicht | pro Verpackungseinheit korrekt | geschätzt |
| PDP-Radio | ist die Standard-Optionsauswahl | Custom-Logik nötig |

**Entscheidung: A.** Das Display bekommt eine eigene Variante mit eigenem
SKU und eigenem Preis. Der Radio-Button ist damit nichts Exotisches, sondern
die ganz normale Medusa-Variantenauswahl — der Preiswechsel passiert von
selbst, weil eine andere Variante ein anderes Price Set hat.

### Produktstruktur

Ein Produkt, eine Option, zwei (oder mehr) Werte:

```
Produkt:  "OCB Premium Slim"
  Option: "Verpackungseinheit"
    Wert: "Einzeln"            → Variante SKU OCB-PREM-SLIM-1   (CHF 1.20)
    Wert: "Display (50 Stk.)"  → Variante SKU OCB-PREM-SLIM-D50 (CHF 49.00)
```

Wichtig: **Die Option heisst überall gleich** ("Verpackungseinheit"), und die
Werte folgen einem festen Schema `Einzeln` / `Display (N Stk.)`. Nur so kann
das Frontend die Stückzahl N zuverlässig parsen und den Grundpreis
(CHF/Stück) ausrechnen — der ist für die Transparenz entscheidend.

Sauberer als Parsen: die Stückzahl zusätzlich in `variant.metadata` ablegen.

```jsonc
// variant.metadata der Display-Variante
{
  "units_per_pack": 50,       // für Grundpreis-Anzeige "CHF 0.98 / Stk."
  "pack_type": "display"      // "single" | "display" | "carton"
}
```

`metadata` wird von der Store-API mitgeliefert, kostet keine Migration und
keine eigene Modulentwicklung. Für den Anfang reicht das. Ein eigenes
`packaging`-Modul lohnt sich erst, wenn wir darauf filtern oder rechnen wollen.

---

## 2. Staffelpreise kann Medusa nativ — verifiziert

Die Tabelle `price` hat `min_quantity` und `max_quantity`:

- `@medusajs/pricing/dist/models/price.js:16` — `min_quantity: model.bigNumber().nullable()`
- Migration `Migration20230929122253.js:70` legt beide Spalten an.

Und der Warenkorb schiebt die Menge in den Pricing-Context. Zwei Stellen,
beide nachgelesen:

- `@medusajs/core-flows/dist/cart/workflows/get-variants-and-items-with-prices.js`
  baut den Context **pro Position** und setzt darin `quantity: item.quantity`.
  Dieser Workflow wird von `addToCartWorkflow` **und** von
  `refreshCartItemsWorkflow` benutzt.
- `@medusajs/core-flows/dist/cart/workflows/update-line-item-in-cart.js`
  setzt `quantity: data.update.quantity ?? data.item.quantity` und danach
  `updateData.unit_price = variant.calculated_price.calculated_amount`.

Heisst konkret: **ändert der Kunde im Warenkorb die Menge von 5 auf 24,
rechnet Medusa den Stückpreis von selbst neu.** Dafür ist kein eigener Code
nötig — nur die Preiszeilen müssen existieren.

Bestätigt auch der Typ-Doc in
`@medusajs/types/dist/pricing/common/price-set.d.ts:18`:
> passing the `quantity` property to calculate the price for that specified
> quantity, which finds a price set whose `min_quantity` and `max_quantity`
> conditions match

### So sehen die Preiszeilen aus

Für **eine** Variante (ein Price Set), Währung CHF:

| min_quantity | max_quantity | amount |
|---|---|---|
| 1 | 5 | 1.20 |
| 6 | 23 | 1.10 |
| 24 | *(null)* | 0.95 |

Regeln, die eingehalten werden müssen:

- Die Staffeln müssen **lückenlos** sein und bei 1 beginnen. Fehlt die
  Menge 1, wirft der Warenkorb `Variants with IDs … do not have a price`
  (`get-variants-and-items-with-prices.js`, `priceNotFound`).
- Die oberste Staffel hat `max_quantity: null` (nach oben offen).
- Überlappungen vermeiden — sonst hängt es von der Sortierung ab, welche
  Zeile gewinnt. Nicht darauf verlassen.

---

## 3. Was Medusa *nicht* kann — zwei echte Lücken

### Lücke 1: Das Admin-UI hat kein Feld für Staffeln

Die Admin-**API** akzeptiert `min_quantity`/`max_quantity` sehr wohl:

```js
// @medusajs/medusa/dist/api/admin/products/validators.js:62
AdminCreateVariantPrice = z.object({
  currency_code: z.string(),
  amount: z.number(),
  min_quantity: z.number().nullish(),
  max_quantity: z.number().nullish(),
  rules: z.record(z.string(), z.string()).optional(),
})
```

Aber die Preismaske im Admin zeigt nur *einen* Preis pro Währung. Wer dort
einen Preis speichert, **überschreibt die Staffeln stillschweigend** — der
`updatePriceSetsStep` ersetzt die Preisliste des Price Sets komplett.

→ Konsequenz: Staffelpreise werden per Script/Import gepflegt, nicht von
Hand im Admin. Und wer im Admin einen Preis anfasst, muss danach den Import
neu laufen lassen. Das ist eine Betriebsregel, kein Bug — aber sie muss ins
Handbuch, sonst gehen Preise verloren.

### Lücke 2: Die Store-API liefert immer den Preis für Menge 1

`@medusajs/medusa/dist/api/store/products/validators.js` kennt keinen
`quantity`-Parameter, und der Helper rechnet fest mit Menge 1:

```js
// @medusajs/medusa/dist/api/store/products/helpers.js:82
quantity: 1,
unit_price: variant.calculated_price.calculated_amount,
```

Die PDP kann also über `/store/products` **nicht** erfragen, was 24 Stück
kosten — und schon gar nicht die ganze Tabelle. Dafür brauchen wir eine
eigene Route: `GET /store/price-tiers` (siehe
`backend/src/api/store/price-tiers/route.ts`).

Sie liest die Preiszeilen direkt aus dem Pricing-Modul und liefert die
Staffeln als Liste — genau das, was die Preistabelle im Frontend braucht.
Damit ist die Tabelle *eine* Anfrage, nicht eine pro Mengenstufe.

---

## 4. Frontend: PDP

```
┌─ OCB Premium Slim ────────────────────────────┐
│                                               │
│  Verpackungseinheit                           │
│   ( ) Einzeln            CHF 1.20             │
│   (•) Display (50 Stk.)  CHF 49.00            │
│                          CHF 0.98 / Stk.  −18%│
│                                               │
│  Menge  [−]  6  [+]                           │
│                                               │
│  ┌ Mengenrabatt ─────────────────────────┐    │
│  │  1 – 5 Stk.     CHF 1.20 / Stk.       │    │
│  │  6 – 23 Stk.    CHF 1.10 / Stk.  −8 % │ ←  │
│  │  ab 24 Stk.     CHF 0.95 / Stk. −21 % │    │
│  └───────────────────────────────────────┘    │
│                                               │
│  Total  CHF 6.60         [ In den Warenkorb ] │
└───────────────────────────────────────────────┘
```

Drei Dinge, die den Unterschied machen:

- Die **aktive Staffel ist markiert** (Pfeil oben). Der Kunde sieht sofort,
  wo er steht.
- Unter der aktiven Zeile steht, was der nächste Sprung bringt:
  *„Noch 18 Stk. bis CHF 0.95 / Stk. — spare CHF 3.60"*. Das ist der Satz,
  der aus 6 Stück 24 Stück macht.
- Beim Display steht immer der **Grundpreis pro Stück** daneben. Ohne den
  wirkt CHF 49.00 einfach nur teuer.

Datenfluss:

1. PDP lädt Produkt über die Standard-Store-API (Varianten + Preis für Menge 1).
2. PDP lädt parallel `GET /store/price-tiers?variant_id=…&variant_id=…`.
3. Radio-Wechsel → andere Variante → andere Tabelle, alles clientseitig.
4. Mengenänderung → clientseitig die passende Staffel markieren und den
   Total anzeigen.
5. „In den Warenkorb" → Medusa rechnet serverseitig **erneut**. Der clientseitig
   angezeigte Preis ist reine Anzeige und nie die Grundlage der Abrechnung.

Punkt 5 ist wichtig: der Client darf nie einen Preis an den Server schicken.
Tut er es über `unit_price`, behandelt Medusa das als Custom Price
(`isCustomPrice`) und übernimmt ihn ungeprüft.

---

## 5. Odoo → Medusa

Quelle der Preisregeln ist Odoo (`product.pricelist.item`). Das Mapping:

| Odoo | Medusa |
|---|---|
| `product.product` (Variante) | `product_variant` |
| `default_code` | `variant.sku` ← **der Schlüssel für den Abgleich** |
| `product.pricelist` | Währung / Region bzw. Price List |
| `product.pricelist.item.min_quantity` | `price.min_quantity` |
| berechneter Preis bei Menge N | `price.amount` |
| `applied_on = 2_product_category` | muss auf Varianten aufgelöst werden |
| `compute_price = formula/percentage` | muss ausgerechnet werden |

Die letzten beiden Zeilen sind der Grund, warum ein reiner CSV-Export der
Regeln nicht reicht: eine Odoo-Regel „−15 % auf Kategorie *Papers* ab 24 Stk."
ist in Medusa keine Regel, sondern **eine Preiszeile pro betroffener
Variante**. Medusa hat keine Formel-Engine im Pricing-Modul.

→ Deshalb löst `scripts/odoo-export.mjs` die Preise auf, indem es Odoo selbst
rechnen lässt (siehe unten), statt die Formeln nachzubauen.

`max_quantity` gibt es in Odoo nicht — es ergibt sich aus der jeweils nächsten
`min_quantity` minus 1. Das macht der Export.

---

## 6. Entscheidungen

### Rundung: CHF 0.05 — entschieden

Odoo liefert Preise wie 0.9833. Alles wird auf **5 Rappen** gerundet, weil das
in der Schweiz die kleinste Münze ist und Preise dazwischen fremd wirken.
Default im Importer (`ROUND_DEFAULT`), mit `--round 0.01` überschreibbar.

Zwei Nebenwirkungen, die der Importer deshalb selbst behandelt:

- **Stufen fallen zusammen.** 1.12 und 1.08 werden beide zu 1.10. In der
  Preistabelle stünde dann zweimal derselbe Betrag, und es sähe aus, als
  lohne sich die grössere Menge nicht. `collapseEqual()` verschmilzt solche
  Stufen zu einer.
- **Der Rabatt verschwindet ganz.** Bleibt nach dem Verschmelzen nur eine
  einzige Stufe übrig, war der ganze Mengenrabatt kleiner als 5 Rappen. Der
  Importer meldet diese Artikel namentlich — bei billigen Einzelartikeln ist
  das der Normalfall und kein Fehler, aber man will es wissen.

Beim Runden wird zusätzlich auf zwei Nachkommastellen festgeklopft. Ohne das
liefert `Math.round(1.175 / 0.05) * 0.05` den Wert `1.2000000000000002` — und
genau der landete sonst als Preis in der Datenbank.

### Display-Staffeln: später, vorerst Hinweistext

Displays bekommen ebenfalls Staffelpreise (3 Displays billiger als 1 — der
Wiederverkäuferfall). Das wird **separat** gemacht.

Bis dahin steht auf der Display-Variante statt einer Preistabelle:

> **Kontaktiere uns für Händlerpreise**

Technisch ist daran nichts Besonderes: dieselbe Struktur, nur mehr
Preiszeilen. Die PDP zeigt die Preistabelle ohnehin nur, wenn die Variante
mehr als eine Staffel hat — solange das Display nur einen Preis hat, greift
automatisch der Hinweistext. Es braucht also keine Sonderbehandlung, die
später wieder rausmuss.

## 7. Noch offen

- **MwSt.** Odoo-Listenpreise sind normalerweise *exkl.* Steuer. Medusas
  `is_tax_inclusive` hängt an der Region. Vor dem Import einmal an einem
  Artikel gegenrechnen.
- **Mehrere Preislisten.** Wenn es in Odoo B2C und B2B gibt: B2C → normale
  Variantenpreise, B2B → Medusa Price List mit Customer-Group-Regel. Der
  Export trennt sie bereits, der Importer verlangt dann `--pricelist`.
- **Admin-Betriebsregel** aus §3 Lücke 1 ins Handbuch übernehmen.
