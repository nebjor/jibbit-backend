# Verkaufs-Dashboard («Verkauf» im Admin)

Seite `backend/src/admin/routes/dashboard-verkauf/page.tsx`, Daten von
`GET /admin/dashboard/verkauf?von=&bis=` (nur lesend, Admin-Login nötig).
Auswertung: `backend/src/lib/dashboard-verkauf.ts` (mit Unit-Tests).
Zusätzlich zeigt ein Widget über der Bestellliste die drei Kennzahlen der
letzten 30 Tage.

## Was als «bezahlt» zählt

Eine Bestellung zählt, wenn

- ihr Status nicht `canceled` ist, **und**
- die Zahlung erfasst ist: Summe aller Captures > 0 **oder** eine
  Payment-Collection hat den Status `captured`/`completed`.

Offene, nur autorisierte, unbezahlte und stornierte Bestellungen zählen nicht.
Die Zuordnung zu Zeitraum und Monat erfolgt über das Bestelldatum
(`created_at`), nicht über das Zahlungsdatum.

## Berechnung

- Beträge sind Endpreise in CHF (Shop nicht MwSt-pflichtig).
- **Umsatz (brutto)** = Summe `total` der bezahlten Bestellungen.
  **Rückerstattungen** werden getrennt ausgewiesen, **netto** = brutto minus
  Rückerstattungen (der Bestellung, nicht dem Rückerstattungsdatum zugeordnet).
- **Durchschnittlicher Auftrag** = Brutto-Umsatz / Anzahl bezahlter Bestellungen.
- **Stück pro Bestellung** = Summe der Positionsmengen / Anzahl.
- **Warenwert / Versand**: Versand = `shipping_total`, Warenwert = brutto minus Versand.
- **Gratisversand** = Bestellungen mit Versandkosten 0 (Abholung im Laden
  zählt mit, weil sie ebenfalls 0 kostet).
- **Vergleich**: gleich langer Zeitraum unmittelbar davor; ohne Bestellungen
  im Vorzeitraum erscheint «kein Vergleich».
- **Monate**: Kalendermonate in Zeitzone Europe/Zurich, leere Monate werden
  mit 0 gefüllt. Reine Daten (`2026-01-31`) gelten als ganze Tage, «bis» inklusive.
- Top-Listen: 10 grösste Bestellungen, 10 Produkte nach Umsatz bzw. Stückzahl
  (Produkt-Umsatz aus den Positionssummen).
- Standardzeitraum der API: letzte 30 Tage.

## Grenzen

- Nur Bestellungen in Medusa; die alten Odoo-Bestellungen sind nicht enthalten.
- Es werden höchstens 5000 Bestellungen (Zeitraum plus Vorzeitraum, in
  Seiten zu 100) geladen. Wird das erreicht, zeigt die Seite einen Hinweis
  und die Zahlen sind unvollständig; dann den Zeitraum verkleinern.
- Das Diagramm ist ein eigenes SVG (keine Diagramm-Bibliothek); Werte
  erscheinen beim Darüberfahren.
- Der Zeitraum steht in der URL (`?zeitraum=90`, `?zeitraum=eigen&von=…&bis=…`).
