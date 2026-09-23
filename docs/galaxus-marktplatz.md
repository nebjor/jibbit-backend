# Digitec Galaxus: Händler werden

Wie jibbit.ch ans Galaxus-Händlerprogramm angebunden wird — was das Repo
schon kann, und was nur der Betreiber beschaffen kann.

## Was Galaxus verlangt

- Eingetragenes Unternehmen mit UID, Lager in der Schweiz oder EU,
  deutschsprachiger Kundendienst — alles vorhanden.
- **Eine technische Anbindung ist zwingend**, manuelle Prozesse werden nicht
  unterstützt. Der Weg: Galaxus stellt nach der Aufnahme ein
  **FTP-Verzeichnis** (FTPS/SFTP) bereit, dorthin werden regelmässig
  **CSV-Dateien** hochgeladen. Die Dateien müssen bei jeder Übermittlung
  exakt gleich heissen.
- **Ohne GTIN/EAN geht gar nichts.** Galaxus ordnet Artikel über die GTIN
  seiner Produktdatenbank zu; gültig sind 8–14 Ziffern. Ohne GTIN keine
  Aufnahme des Artikels.
- Provision 7–20 % je nach Kategorie, keine Grundgebühr. Lieferung in 1–3
  Tagen erwartet.
- Zigarettenpapier führt Galaxus bereits — das Sortiment (Papers, Filter,
  Tips, Hülsen, Grinder, Aschenbecher; kein Tabak, kein Nikotin, kein
  CBD/THC) ist nicht ausgeschlossen.

Quellen: [Händler werden](https://www.galaxus.ch/de/page/werden-sie-haendler-12462)
und das PDF-Handbuch «Provider Data Interface User Guide» v3.0.4 —
massgeblich für alle Spaltennamen in diesem Repo. Achtung: Das Handbuch ist
von 2019; ob das Händlerprogramm inzwischen zusätzliche Felder verlangt,
klärt der Ansprechpartner bei Galaxus (haendlerprogramm@digitecgalaxus.ch)
bzw. das Partner-Wiki (confdg.atlassian.net, Login nötig).

## Die Werkzeuge in diesem Repo

| Schritt | Werkzeug |
|---|---|
| Was fehlt noch? | `npx medusa exec ./src/scripts/galaxus-report.ts` |
| Daten pflegen | Admin: Variante (EAN, Gewicht), Produkt-Metadaten (`brand`), Lager (Bestand) |
| CSV-Exporte erzeugen | `npx medusa exec ./src/scripts/galaxus-export.ts` |
| Hochladen | **bewusst nicht gebaut** — FTP-Zugang gibt es erst nach der Aufnahme |

### 1. Bereitschaftsbericht

    cd backend
    npx medusa exec ./src/scripts/galaxus-report.ts
    # zusätzlich als Arbeitsliste (CSV, Semikolon, UTF-8):
    npx medusa exec ./src/scripts/galaxus-report.ts csv=../export/galaxus-bereitschaft.csv

Prüft jede Variante in der **Datenbank** gegen die Pflichtangaben (EAN,
Gewicht, Marke, Kategorie, Beschreibung, Preis, Bestand, Bild) und sagt am
Ende, wie viele Varianten heute lieferfähig wären. Auf der Produktions-VPS
läuft dasselbe über `docker compose exec medusa npx medusa exec
./src/scripts/galaxus-report.js` (kompilierte `.js`-Endung).

### 2. Daten beschaffen und pflegen — das kann nur der Betreiber

- **EAN/GTIN je Variante.** Steht auf der Verpackung (Strichcode) oder kommt
  vom Lieferanten/Grossisten. Wichtig: Die Display-/Box-Variante hat eine
  **eigene** EAN (die der Umverpackung), nicht die der Einzelpackung. Im
  Admin an der Variante im Feld EAN eintragen.
  Eigene EANs kaufen (GS1 Schweiz) ist nur nötig, falls ein Artikel wirklich
  keine hat — dann vorher mit Galaxus klären, ob ein `ManufacturerKey`
  reicht.
- **Gewicht in Gramm je Variante** (Admin, Feld Gewicht): Produkt **inklusive
  Verpackung** wiegen (Galaxus-Pflichtfeld `WeightG`). Der Shop selbst
  rechnet einen einheitlichen Versandpreis, unabhängig vom Gewicht.
- **Marke je Produkt** (Admin, Produkt-Metadaten `brand`): Gizeh, OCB, RAW, Elements, PURIZE … —
  Galaxus legt Produkte nur mit Marke an.
- **Bestand**: im Admin unter Lager erfassen.
- **Bilder**: mindestens ein Bild pro Produkt, längste Kante ≥ 600 px,
  JPEG/PNG, frei zugängliche URL — die Medusa-Bilder unter
  `https://…/static/…` erfüllen das (siehe `docs/produktbilder.md`,
  `import-product-images.ts`).

### 3. Exporte erzeugen

    cd backend
    npx medusa exec ./src/scripts/galaxus-export.ts
    # Optionen: out=../export/galaxus  provider=jibbit  mit-luecken

Erzeugt aus den echten Medusa-Daten vier Dateien (Datenaufteilung «Option 2»
des Handbuchs: Stammdaten und Medien in einer Datei):

| Datei | Inhalt | Übermittlung laut Handbuch |
|---|---|---|
| `ProductData_jibbit.csv` | Stammdaten + Bild-URLs | min. alle 24 h |
| `PriceData_jibbit.csv` | Preise | min. alle 24 h |
| `StockData_jibbit.csv` | Bestand/Verfügbarkeit (= Assortment-File) | min. alle 12 h |
| `SpecificationData_jibbit.csv` | Eigenschaften | min. alle 48 h |

Format: UTF-8, Semikolon, Texte in doppelten Anführungszeichen, Kopfzeile,
CRLF. Der `ProviderKey` (erste Spalte in allen Dateien; im
Spezifikationsfile heisst sie `ProductKey`) ist die Medusa-SKU der Variante.

Varianten mit fehlenden Pflichtangaben werden **nicht stillschweigend
weggelassen**: Das Skript meldet jede einzelne mit Begründung; die
Arbeitsliste liefert `galaxus-report.ts`. `mit-luecken` nimmt sie mit leeren
Zellen auf — nur zum Sichten, nie hochladen.

### 4. Bewerben und hochladen

1. Bewerbung über <https://www.galaxus.ch/de/page/werden-sie-haendler-12462>
   (UID, Sortiment, Lager, Kundendienst angeben).
2. Nach der Zusage teilt Galaxus die FTP-Zugangsdaten mit. **Nicht ins Repo
   und nicht in `.env`-Dateien committen**; auf der VPS als
   Umgebungsvariablen/Secrets ablegen.
3. Die vier Dateien aus `export/galaxus/` hochladen — bei jeder Übermittlung
   mit identischen Dateinamen. Ein automatischer Upload (Cron auf der VPS)
   ist bewusst noch nicht gebaut und wird ergänzt, sobald der Zugang da ist.
4. Danach mit dem Integration Management von Galaxus die Zuordnung von
   Marken, Kategorien und Spezifikationen abstimmen (teilautomatisierter
   Schritt auf Galaxus-Seite).

## Entscheidungen und offene Punkte

- **Mehrwertsteuer:** Der Betreiber ist **nicht MwSt-pflichtig**. Die
  Exporte schreiben deshalb `VatRatePercentage` = `0.0` und denselben
  Endpreis in `SalesPriceExcludingVat` und `SalesPriceIncludingVat`.
  `VatRatePercentage` ist für Händler laut Handbuch ein Pflichtfeld — **vor
  dem ersten Upload schriftlich mit Galaxus klären**, ob 0.0 für einen nicht
  MwSt-pflichtigen Händler so akzeptiert wird.
- **ShipmentType** (Bestandesdaten): 1 = Brief bis 1000 g, sonst 2 = Paket —
  dieselbe Grenze wie `letterMaxWeight` im swiss-shipping-Modul. Ohne
  Gewicht: Paket.
- **Artikelname:** Laut Handbuch darf `ProductTitle` weder Marke noch
  Spezifikationen enthalten («Model X», nicht «Tesla Model X blue
  metallic»). Unsere Titel enthalten die Marke («Gizeh DW Extra Fine»).
  Automatisch bereinigen wäre riskant; falls Galaxus das moniert, Titel im
  Admin anpassen.
- **Kategorien:** `ProductCategory` liefert die Shop-Kategorie (Papers,
  Filter, Aschenbecher, Zubehör). Die Zuordnung auf den Galaxus-Kategoriebaum
  macht Galaxus beim Onboarding.
- **Preise:** Es geht der reguläre Menge-1-Basispreis (CHF) hinaus.
  Mengenstaffeln und Preislisten-Aktionen kennt das Galaxus-Format nicht.
- **Bestand:** `QuantityOnStock` = verfügbarer Bestand (eingelagert minus
  reserviert) über alle Lagerorte. Varianten ohne Bestandsführung gelten als
  «Bestand unbekannt» und werden nicht exportiert.
- **Nicht verifiziert:** Das Partner-Wiki (confdg.atlassian.net) war ohne
  Login nicht lesbar; Grundlage ist ausschliesslich das PDF-Handbuch v3.0.4
  von 2019. Ob es neuere Pflichtfelder gibt, beim Onboarding erfragen.
