# Buchhaltung («Buchhaltung» im Admin)

Zwei Berichte für Steuerberater und Steuererklärung (Einzelfirma, CHF, nicht
MwSt-pflichtig, daher keine MwSt-Zeilen):

1. **Lagerbestand per Stichtag**, bewertet zum Einstandspreis
2. **Umsatz pro Jahr** mit Monatstabelle und zwei CSV-Exporten

Seite `backend/src/admin/routes/buchhaltung/page.tsx` (Seitenleiste
«Buchhaltung»). Alle Berichte sind rein lesend und nur mit Admin-Login
erreichbar. Rechenlogik: `backend/src/lib/buchhaltung.ts` (mit Unit-Tests in
`backend/src/__tests__/buchhaltung.unit.spec.ts`).

| Route | Zweck |
| --- | --- |
| `GET /admin/buchhaltung/lagerbestand?stichtag=JJJJ-MM-TT[&format=csv]` | Bestand per Stichtag (JSON oder CSV) |
| `POST /admin/buchhaltung/lagerbestand/snapshot` | heutigen Bestand als Stichtag speichern |
| `GET /admin/buchhaltung/lagerbestand/snapshots[?id=…&format=csv]` | gespeicherte Stichtage auflisten / als CSV laden |
| `GET /admin/buchhaltung/umsatz?jahr=JJJJ[&format=csv\|zahlungen-csv]` | Umsatz (JSON) / Bestellungen-CSV / Zahlungen-CSV |

## CSV-Format (alle Dateien)

UTF-8 **mit BOM**, Trennzeichen **Semikolon**, Dezimaltrenner **Punkt** ohne
Tausendertrenner (`1234.50`), Zeilenende CRLF, Datum `JJJJ-MM-TT`. Excel
öffnet die Dateien per Doppelklick richtig (Umlaute, Spalten). Text mit
Semikolon, Anführungszeichen oder Zeilenumbruch steht in Anführungszeichen;
Text, der mit `=`, `+`, `-`, `@` beginnt, bekommt ein `'` vorangestellt (Schutz
vor Excel-Formeln). In einem Excel mit deutschem Dezimalkomma werden die Beträge
mit Punkt als Text erkannt: dann beim Import «Dezimaltrennzeichen: Punkt»
wählen (Daten → Aus Text/CSV).

## 1. Lagerbestand per Stichtag

Tabelle je Variante: Produkt, Variante/SKU, GTIN, Menge, Einstandspreis pro
Stück, Wert (Menge × Einstandspreis), dazu Totale. Die Mengen aller Lagerorte
werden summiert (heute gibt es «Lager Zürich»). Gezählt wird der **physische
Bestand** (`stocked_quantity`); reservierte, aber noch nicht versandte Ware
liegt noch im Lager und zählt mit.

### Wie der Bestand zum Stichtag entsteht

Medusa 2.13 führt **kein Bewegungsjournal**: Ein Inventory-Level kennt nur den
heutigen Stand, keine Historie (geprüft: die Inventory-Tabellen enthalten nur
Artikel, Level und Reservierungen). Deshalb:

- **Stichtag = heute:** Live-Bestand.
- **Stichtag in der Vergangenheit:** Rückrechnung vom heutigen Stand.
  Medusa verringert den Bestand, sobald eine Lieferung (Fulfillment) erstellt
  wird, und erhöht ihn, wenn die Lieferung storniert wird. Also gilt
  Bestand(Stichtag) = Bestand(heute) + Mengen aus Lieferungen, die **nach**
  dem Stichtag erstellt (und nicht storniert) wurden − Mengen aus Lieferungen,
  die vor dem Stichtag erstellt, aber erst nach dem Stichtag storniert wurden.
  «Nach dem Stichtag» heisst: ab Mitternacht (Europe/Zurich) des Folgetags.

### Grenzen (bitte kennen)

Nicht rekonstruierbar sind alle Änderungen **nach dem Stichtag**, die nicht
über eine Lieferung laufen:

- manuelle Bestandskorrekturen und Inventuren im Admin
- Wareneingänge (Nachschub), Retouren, Bruch/Schwund

Ein Stichtag weit in der Vergangenheit ist deshalb nur eine Näherung. Ergibt
die Rückrechnung für eine Position einen negativen Bestand, zeigt der Bericht
einen Hinweis und bewertet sie mit 0. Varianten mit ausgeschaltetem «Bestand
verwalten» werden ausgewiesen, aber ihre Menge sinkt beim Verkauf nicht von
selbst (dann ist es nur der zuletzt gezählte Stand). Varianten ohne
Lagerartikel erscheinen nicht.

**Empfehlung:** Jedes Jahr am 31.12. (oder am ersten Arbeitstag danach, nach
der Inventur) auf «Bestand jetzt als Stichtag speichern» klicken. Der
Schnappschuss ist der belastbare Beleg, die Rückrechnung nur ein Notbehelf.

### Schnappschüsse

Der Button speichert eine JSON-Datei mit Stichtag (= heutiges Datum), Zeitpunkt,
Benutzer und je Variante SKU, Titel, GTIN, Menge, Einstandspreis, Wert. Die
Liste «Gespeicherte Stichtage» zeigt alle und lädt jeden als CSV.

- **Ablage:** Verzeichnis `BUCHHALTUNG_DIR/lagerbestand/` (Compose:
  `/app/buchhaltung`, eigenes Docker-Volume `medusa_buchhaltung`; ohne die
  Variable `<Arbeitsverzeichnis>/buchhaltung`). Das Repo hat kein eigenes
  Datenmodul mit Migrationen, eine Datenbanktabelle wäre für ein paar Dateien
  pro Jahr übertrieben; Dateien auf einem Volume überstehen Neustarts und
  Deployments. Bewusst **nicht** unter `/app/static`: Das wird öffentlich
  ausgeliefert, die Dateien enthalten Einstandspreise.
- Dateien werden **nie überschrieben oder gelöscht** (Name
  `bestand-JJJJ-MM-TT-HHMMSS.json`, Zeit in UTC). Mehrfaches Speichern am
  selben Tag ergibt mehrere Dateien; massgeblich ist die zuletzt gespeicherte.
- **Beim ersten Deployment** muss das Volume neu angelegt werden
  (`docker compose up -d` erledigt das). Das Volume `medusa_buchhaltung` gehört
  in die Datensicherung (wie `postgres_data`).

### Einstandspreis pflegen

Medusa hat kein Kostenfeld an Varianten. Konvention: **`variant.metadata.einstandspreis`**
= Einstandspreis pro Stück in CHF (Zahl, z. B. `1.85`; ein Text wie `"1,85"`
oder `"CHF 1.85"` wird ebenfalls gelesen). Im Admin: Produkt → Variante →
Metadaten → Schlüssel `einstandspreis`. Einstandspreis = Kaufpreis beim
Lieferanten inkl. Transport/Zoll bis ins Lager, ohne MwSt; Rabatte abgezogen.
Preisänderungen gelten rückwirkend für alle Berichte (es gibt keine
Preishistorie) — der Schnappschuss friert den Preis zum Speichern ein.

Fehlt der Wert (oder ist er ungültig/negativ), zeigt der Bericht die Menge,
markiert die Zeile mit «Einstandspreis fehlt», lässt Preis und Wert leer
(CSV: leere Zellen, Hinweis in der letzten Spalte) und weist im Kopf aus, wie
viele Positionen und Stück im Gesamtwert fehlen.

## 2. Umsatz pro Jahr

Grundlage sind **bezahlte Bestellungen**, genau wie im Verkaufs-Dashboard
(`docs/admin-dashboard.md`): nicht storniert **und** Zahlung erfasst (Summe der
Captures > 0 oder Payment-Collection `captured`/`completed`). Das Jahr ist das
Kalenderjahr nach **Bestelldatum in Europe/Zurich** (eine Bestellung am
31.12. um 23:30 Uhr zählt noch ins alte Jahr, auch wenn die Server-Zeit UTC
schon den 1.1. zeigt).

**Monatstabelle** (12 Monate, auch leere) und Jahrestotal: Bestellungen, Waren
(= Total minus Versand), Versand, Brutto (= Summe `total`), Rückerstattungen,
Netto (= Brutto − Rückerstattungen). Rückerstattungen stehen im Monat der
**Bestellung**, nicht der Rückerstattung (wie im Dashboard).

**CSV «Bestellungen»** (`format=csv`): alle bezahlten Bestellungen des Jahres,
eine Zeile je Bestellung (Nummer, Datum, Kunde, E-Mail, Waren, Versand, Total,
Rückerstattet, Netto, Zahlungsanbieter, Zahlungs-ID) plus Summenzeile.

**CSV «Zahlungen»** (`format=zahlungen-csv`): Geldeingänge (Captures) und
Rückerstattungen nach **ihrem eigenen Datum** (Zürcher Zeit, mit Uhrzeit),
Rückerstattungen negativ, Bestellnummer, Anbieter, Zahlungs-ID,
Bestellstatus, am Ende der Saldo. Bestellstatus gehört dazu, weil auch bei
stornierten Bestellungen eingegangenes Geld und die Rückzahlung in der Liste
stehen müssen. Hat eine Zahlung kein Datum, gilt das Bestelldatum. Berücksichtigt werden
Bestellungen des Jahres und des Vorjahres (Zahlungen im Januar zu
Dezember-Bestellungen); Rückerstattungen zu noch älteren Bestellungen fehlen.

### Bestelldatum oder Zahlungsdatum?

- **Nach Bestelldatum** (Monatstabelle, CSV «Bestellungen»): Umsatz, wie er
  verkauft wurde. Passt zur Buchführung nach vereinbarten Entgelten und zum
  Dashboard.
- **Nach Zahlungsdatum** (CSV «Zahlungen»): Geldeingang. Das fragt das
  Steueramt, wenn nach vereinnahmten Entgelten gerechnet wird (Ist-Methode).

Beide Summen stimmen nur überein, wenn Bestellung und Zahlung im selben Jahr
liegen und nichts nachträglich zurückerstattet wurde. Typische Abweichung:
Bestellung am 30.12., Zahlung am 2.1. (Bestellumsatz im alten Jahr,
Geldeingang im neuen).

### Grenzen

- Nur Bestellungen in diesem Shop. Frühere Verkäufe aus Odoo sind nicht
  enthalten (Shop live seit Oktober 2026) und kommen aus der Odoo-Buchhaltung.
- Beträge sind Endpreise; es gibt keine MwSt.
- Obergrenze 20 000 Bestellungen je Abfrage; wird sie erreicht, warnt die
  Seite, dass die Zahlen unvollständig sind.

## Jahresroutine

1. **31.12.** (spätestens erster Arbeitstag im Januar, nach der Inventur): im
   Admin die Bestände prüfen, fehlende Einstandspreise nachtragen, dann
   «Bestand jetzt als Stichtag speichern».
2. **Anfang Januar**: Buchhaltung → «Umsatz pro Jahr», Vorjahr wählen, beide
   CSV (Bestellungen, Zahlungen) herunterladen; unter «Lagerbestand per
   Stichtag» den gespeicherten 31.12. als CSV herunterladen.
3. Die drei CSV-Dateien dem Steuerberater geben und selbst ablegen.
4. **10 Jahre aufbewahren** (Art. 958f OR): die CSV-Dateien, ausserdem das
   Volume `medusa_buchhaltung` in der Datensicherung behalten.
