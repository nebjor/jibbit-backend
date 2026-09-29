# jibbit.ch — Launch-Roadmap Medusa

Stand: 21.09.2026 · Basis: `medusa-ecom` origin/main `67e947b`, `jibbit-frontend` origin/main `52fff49`.
Ausführliche Befunde je Feature: [`audit.md`](./audit.md). SaaS-Architektur: [`multi-tenancy-architecture.md`](./multi-tenancy-architecture.md).

---

## 1. Kurzfazit

**Wir sind nah dran.** Kasse, zahls.ch (integriert, Schlüssel gesetzt), Kundenkonten, Rechtsseiten, Altersabfrage,
Cookie-Einwilligung und strukturierte Daten sind gebaut. Vieles vom Rest liegt schon als PR bereit (Liste in Abschnitt 3).
Was noch fehlt, ist überschaubar. Mit den offenen PRs sind es realistisch **1–2 Wochen** bis zum Umschalten.

**Die echten Blocker vor dem Umschalten:**

1. **Produktiv-Datenbank per Skript aufbauen.** Staging ist aus umbenannten Demo-Produkten entstanden, die echten
   Katalog-Handles fehlen dort. Die Produktiv-DB muss reproduzierbar aus den Import-Skripten entstehen, einmal auf
   Staging geprobt.
2. **Ein echter Testkauf auf Staging** (Warenkorb → Kasse → zahls.ch → Bestellung im Admin → Mail + Push → Rückerstattung).
   Noch nie End-to-End gelaufen.
3. **Betriebssicherheit:** Event-Bus läuft in-memory (bei einem Neustart kann die Zahlungsmeldung einer bezahlten Bestellung
   verloren gehen), keine Backups für DB und Bilder, kleine VPS (1.9 GB RAM) zusammen mit Odoo.
4. **Umschalt-Vorbereitung:** `api.jibbit.ch` hat noch keinen DNS-Eintrag, Prod-Konfiguration (`STORE_URL`,
   `MEDUSA_BACKEND_URL`, `STATIC_TENANTS`) steht noch nicht.

---

## 2. Status

✅ bereit · 🟡 teilweise / PR offen · ❌ fehlt

| Bereich | Status | Kurz |
|---|---|---|
| Katalog-Import | 🟡 | 28 Produkte / 35 Varianten in `data/catalog*.json`, Skripte idempotent. Fehlt: geprobter Lauf «leere DB → fertiger Katalog», Bilder für ~19 Produkte (nur 9 zugeordnet). Import-Aufräumen als PR offen. |
| Kaufpfad | 🟡 | Code vollständig (Medusa-Warenkorb, Kasse, Redirect-Zahlung, Bestellseite, Kontopflicht). Automatische Versandwahl als PR offen. Testkauf fehlt. |
| Zahlung | ✅ | zahls.ch über das offizielle Plugin, Schlüssel gesetzt. Region: `pp_zahls_zahls` zuweisen, `pp_system_default` entfernen. |
| Mails & Meldungen | 🟡 | Bestellbestätigung, Meldung an joris@jibbit.ch, ntfy-Push und Admin-Passwort-Reset als PR offen. Versandbestätigung als PR offen (`docs/e-mails.md`). SPF/DKIM prüfen. |
| Versand | 🟡 | Ein Preis: Paket CHF 4.50, gratis ab CHF 69. Passt ein Auftrag in einen Brief, schickt ihn das Team als Brief und gibt die Differenz als Gutscheincode (Medusa Promotions). Keine Gewichts- oder Brieflogik mehr. Texte als PR offen. |
| Fulfilment | 🟡 | Standard-Admin (Bestellung → Fulfillment → versendet). Etiketten manuell über die Post. Bestand wird nicht geführt (0 von 35 gezählt), also auch nicht abgebucht. Entscheid nötig. |
| Recht | 🟡 | Impressum, AGB, Datenschutz, Widerruf, Service-Seiten da. Kontakt info@jibbit.ch + Hotline Mo–Fr 9–17 und eigene Rechtsprüfung als PR offen. **Keine MWST-Pflicht:** 8.1 % entfernt Joris an der Region, der Seed wird per PR korrigiert. Firmenangaben/UID im Impressum prüfen. |
| SEO / Umzug | 🟡 | Redirects der 33 Odoo-URLs, Staging-noindex und echte 404 als PR offen. Nur Deutsch. Details zum Traffic in Abschnitt 5. |
| Hosting | 🟡 | Gleiche VPS wie Odoo, Umschalten = eine nginx-Zeile, kein DNS-Umzug. Fehlt: Redis-Event-Bus, Backups, `api.jibbit.ch`, Monitoring. |
| Admin | ✅ | Standard-Admin reicht. Preistabelle-Widget als PR offen. Kurzanleitung für Mitarbeitende = P1. |

---

## 3. Bereits in Arbeit (PRs)

- Preistabelle + eine Staffelquelle mit Streichpreis + Aufräumen der Import-Skripte
- Bestellbestätigung + Meldung an joris@jibbit.ch + ntfy-Push + Admin-Passwort-Reset
- Redirects Odoo → Medusa + Staging-noindex + echte 404
- Automatischer Versand in der Kasse (keine Auswahl für Kunden)
- Mock-Katalog in Produktion aus
- Vereinfachung Bildformat
- Preisdarstellung (Rot nur bei Ersparnis)
- Footer-, Rechts- und Versandtexte
- MWST-Korrektur im Seed
- Nachschub im Admin abschalten (`chore/disable-nachbestellungen`)

---

## 4. Roadmap

Aufwand: S ≤ 2 h · M 2–6 h · L > 6 h. ∥ = parallel möglich.

### P0 — vor dem Umschalten

| ID | Aufgabe | Owner | Aufwand | Abhängig von |
|---|---|---|---|---|
| 1 | Offene PRs (Abschnitt 3) reviewen und mergen | Code + Joris | M | – |
| 2 ∥ | Redis-Event-Bus + Workflow-Engine in `medusa-config.ts` | Code | M (3 h) | – |
| 3 | Produktiv-DB per Skript aufbauen, auf Staging proben (migrate → seed → Demo weg → Katalog → Texte → Bilder → Preise, Region: zahls rein, System-Provider raus) | Code | L (6–8 h) | 1 |
| 4 | Testkauf auf Staging bestätigen, inkl. Mail, Push und Rückerstattung | Code + Joris | S (2 h) | 1, 3 |
| 5 ∥ | Prod-Konfiguration: `STORE_URL`, `MEDUSA_BACKEND_URL=https://api.jibbit.ch` (vor jedem Bild-Upload), `STATIC_TENANTS` mit jibbit.ch + www, CORS. nginx-vhost `api.jibbit.ch` + Zertifikat, www → Apex | Code (+ Joris DNS-Eintrag `api`) | M (3 h) | – |
| 6 ∥ | Backups: täglich DB Medusa + Odoo und das Bilder-Volume, Restore einmal testen | Code (+ Joris Speicherziel) | M (2–3 h) | – |
| 7 ∥ | Entscheide: Bestandsführung ja/nein, Kontopflicht ja/nein, Kunden aus Odoo übernehmen ja/nein | Joris | S | – |
| 8 ∥ | 8.1 % MWST an der Region entfernen | Joris | S | – |
| 9 ∥ | Bilder für ~19 Produkte hochladen | Joris/Code | M | 5 |
| 10 | Kundenmigration inkl. `prepare-odoo-logins.ts` **vor** dem Umschalten (falls 7 = ja) | Code | M (2–3 h) | 3 |

### P1 — erste Woche

- Versandbestätigung per Mail (Code, M): als PR offen, auf Staging testen (`docs/e-mails.md`)
- Uptime-Monitor auf `jibbit.ch/healthz` und `api.jibbit.ch/health` (Code, S)
- Error-Tracking (Sentry/GlitchTip) (Code, M)
- RAM beobachten, VPS bei Bedarf vergrössern (Joris, S)
- Kurzanleitung Admin für Mitarbeitende: Bestellung, Brief-Gutschrift, Rückerstattung (Code, M)
- Search Console und Plan «Organischer Google-Traffic» starten (Abschnitt 5)

### P2 — später

- Post-Etiketten aus dem Admin, Medusa 2.18, Fremdsprachen FR/IT, Kontaktformular

---

## 5. Organischer Google-Traffic

**Ausgangslage:** Search Console zeigt z. B. für «kailar» 8 Impressionen und 0 Klicks. Google kennt uns kaum, und wo es
uns zeigt, klickt niemand. Werbung fällt weg (Google/Meta verbieten Rolling Papers), also zählt nur organischer Traffic.
Der Vorteil: Die Nischen-Suchen (Marke + Modell) haben wenig Konkurrenz aus der Schweiz.

Reihenfolge nach Wirkung pro Aufwand:

| # | Massnahme | Was konkret | Owner | Aufwand |
|---|---|---|---|---|
| 1 | **Umzug ohne Verlust** | 301-Redirects aller Odoo-URLs (PR offen), neue Sitemap in der Search Console einreichen, Domain-Property `jibbit.ch` anlegen, 404-Bericht in der ersten Woche täglich prüfen. | Code + Joris | S |
| 2 | **Keyword-Recherche je Marke/Produkt** | Je Produkt 1 Hauptbegriff + 2–3 Varianten: «Marke Modell» («kailar filter 5.9mm»), «Marke Modell kaufen schweiz», «Marke online bestellen», Grössen/Mengen («ocb slim filter 120»). Quellen: Search Console (Abfragen), Google-Autovervollständigung, «Ähnliche Suchanfragen», Galaxus/Konkurrenz-Titel. Ergebnis: eine Tabelle Produkt → Keywords. | Code (Entwurf) + Joris (Freigabe) | M (4 h) |
| 3 | **Titel und Meta-Description je Produkt** | Titel nach Muster «Kailar Filter 5.9 mm schwarz, 65 Stk. kaufen | jibbit.ch». Description mit Preis ab, Versand gratis ab CHF 69, Lieferung Schweiz. Heute kommt die Description einfach aus den ersten 160 Zeichen des Produkttexts. | Code (Feld/Vorlage) + Joris (Texte im Admin) | M |
| 4 | **Eigene Produkttexte** | 80–150 Wörter je Produkt, nicht vom Hersteller kopiert: Material, Grösse, Menge, wofür geeignet, passende Produkte. Heute sind viele Texte generiert oder sehr kurz. Sachlich bleiben (keine Cannabis-Sprache, Zahlungsanbieter lesen mit). | Joris (Claude kann Entwürfe liefern) | M (1 h pro 5 Produkte) |
| 5 | **Kategorie- und Markenseiten mit Text** | Eigene URLs statt `/?kategorie=…`: `/papers`, `/filter`, `/aschenbecher` und Markenseiten (`/marken/kailar`, `/marken/purize`, `/marken/ocb`, `/marken/raw`). Je 100–200 Wörter Einleitung, Produktliste, Canonical, Eintrag in der Sitemap. Text im Admin pflegbar (Kategoriebeschreibung). | Code | L (1 Tag) |
| 6 | **Interne Links** | Produkt → Marke und Kategorie, «passt dazu» (Papers ↔ Filter), Breadcrumbs mit `BreadcrumbList`-Daten, Footer-Links auf die Kategorien. | Code | M |
| 7 | **Strukturierte Daten prüfen** | Vorhanden: `ProductGroup` mit Variante je Packung, GTIN, Versand, Rückgabe, Mengenrabatte als `UnitPriceSpecification` mit `eligibleQuantity` (bewusst kein `AggregateOffer`, Google rät davon ab). Nach dem Umbau «eine Staffelquelle» im Rich-Results-Test und in der Search Console (Händlereinträge) prüfen, ob Preis und Staffeln stimmen. | Code | S |
| 8 | **Bilder** | Dateinamen mit Produktname (`kailar-filter-5-9mm-schwarz.avif` statt `IMG_1234`), Alt-Text = Produktname + Variante. Alt-Attribute werden schon gesetzt, der Inhalt muss aus dem Produkt kommen. Bilder für alle Produkte (heute ~19 ohne). | Code + Joris | M |
| 9 | **Tempo mobil (Core Web Vitals)** | PageSpeed Insights mobil für Startseite, eine Kategorie, eine PDP. Ziele: LCP < 2.5 s, CLS < 0.1, INP < 200 ms. Verdächtig: Intro-Animation und Altersabfrage auf der Startseite, grosse Bilder. | Code | M |
| 10 | **Search Console monitoren** | Wöchentlich: Leistung → Abfragen (welche Begriffe bringen Impressionen, wo ist die Klickrate tief → Titel verbessern), Seiten-Bericht (nicht indexiert, warum), Händlereinträge. 15 Minuten pro Woche. | Joris | S/Woche |
| 11 | **Backlinks und lokale Einträge** | Google-Unternehmensprofil (falls Adresse vorhanden), local.ch/search.ch, Hersteller- und Händlerlisten («Wo kaufen?» bei Kailar, dubi, Purize), Schweizer Foren/Blogs zum Thema Drehen. Keine gekauften Links. | Joris | M, laufend |
| 12 | **Google Merchant Center** | Kostenlose Produkteinträge wären wertvoll, aber Googles Richtlinie zählt Rolling Papers voraussichtlich zu den verbotenen Tabak-Artikeln. Vor dem Aufwand prüfen: ein Testprodukt einreichen und die Ablehnung abwarten. Nicht darauf bauen. | Joris | S |

**Messbar machen:** Nach 4 und 8 Wochen in der Search Console vergleichen: Impressionen und Klicks für die Markenbegriffe
(kailar, purize, dubi, ocb, raw, elements) sowie die Zahl indexierter Produktseiten.

---

## 6. Umschalttag (Kurzfassung)

1. T-2: `api.jibbit.ch` live, Prod-Stack läuft neben Odoo, Prod-DB aufgebaut, Webhook bei zahls.ch auf `api.jibbit.ch`, Backup getestet.
2. T-1: Katalog-Delta aus Odoo nachziehen, Kunden importieren + `prepare-odoo-logins.ts`, Redirects lokal mit `Host: jibbit.ch` testen, nginx-Config sichern.
3. Tag X: offene Odoo-Bestellungen abarbeiten, nginx `proxy_pass` von `127.0.0.1:8069` auf `127.0.0.1:3000` umstellen, `nginx -t && reload`.
4. Smoke-Test: Startseite, PDP, alte Odoo-URLs → 301, robots/Sitemap, echter Kauf mit TWINT → Mail + Push → Rückerstattung.
5. Sitemap in der Search Console einreichen, 48 h Logs und `docker stats` beobachten.

**Rollback (< 5 min):** gesicherte nginx-Config zurück (bzw. `proxy_pass` wieder auf `:8069`), reload, `curl -I https://jibbit.ch`
zeigt Odoo. Medusa weiterlaufen lassen, Bestellungen aus dem Fenster im Medusa-Admin (`api.jibbit.ch/app`) abwickeln.

---

## 7. Offene Fragen an Joris

1. Bestandsführung zum Start ja oder nein?
2. Kontopflicht an der Kasse beibehalten?
3. Kunden aus Odoo übernehmen (mit Einladungsmail) oder frisch starten?
4. Wohin sollen die Backups (Infomaniak S3 oder anderes)?
5. Darf die Staging-DB für den Probelauf komplett neu aufgebaut werden?
6. Gibt es Fotos für die Produkte ohne Bild?
7. Ist das Impressum mit Firmenangaben vollständig (Name, Adresse, ggf. UID)?
8. Gibt es einen Wunschtermin für das Umschalten?
