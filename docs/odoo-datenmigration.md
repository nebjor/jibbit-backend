# Odoo → Medusa: Kunden und Bestellungen

Anleitung für den Betreiber. Was hier steht, betrifft **Personendaten** —
bitte den Abschnitt [Datenschutz](#datenschutz-dsg) vor dem ersten Lauf lesen.

Der Produktteil der Migration steht in
[`product-pricing-model.md`](./product-pricing-model.md); diese Anleitung setzt
darauf auf.

---

## Überblick

| Schritt | Script | Ergebnis |
|---|---|---|
| Kunden aus Odoo holen | `scripts/odoo-export-customers.mjs` | `partners.json` |
| Bestellungen aus Odoo holen | `scripts/odoo-export-orders.mjs` | `orders.json` |
| Kunden nach Medusa spielen | `backend/src/scripts/import-customers.ts` | Kunden + Adressen in Medusa |
| Anmeldung vorbereiten (Pflicht) | `backend/src/scripts/prepare-odoo-logins.ts` | Identitäten, damit „Passwort vergessen" greift |
| Bestellungen nach Medusa spielen | — | **entfällt mit Absicht**, siehe [unten](#warum-bestellungen-nicht-importiert-werden) |

Die Export-Scripte brauchen kein npm-Paket, nur Node 20 oder neuer.
Sie reden über Odoos JSON-RPC-Schnittstelle (`/jsonrpc`) mit der Instanz —
dieselbe Schnittstelle, die schon der Preis-Export benutzt.

---

## 1. Zugang einrichten

In Odoo: **Profilbild → Mein Profil → Konto-Sicherheit → Neuer API-Schlüssel**.
Der Schlüssel wird genau einmal angezeigt.

> Das normale Passwort funktioniert bei Odoo Online nicht mehr. Auch bei einer
> selbst gehosteten Instanz ist der API-Schlüssel die bessere Wahl: er lässt
> sich einzeln zurückziehen.

Der Benutzer, dem der Schlüssel gehört, braucht Leserechte auf
*Verkauf* und *Kontakte*.

## 2. Ablageort wählen

Die Exportdateien enthalten Namen, Anschriften, Telefonnummern,
E-Mail-Adressen und die vollständige Kaufhistorie. Sie gehören **nicht** ins
Repository.

```bash
mkdir -p ~/odoo-export-$(date +%F)
chmod 700 ~/odoo-export-$(date +%F)
```

Ein Verzeichnis mit Datum im Namen macht später sichtbar, welcher Stand
gelöscht werden muss. `chmod 700` sorgt dafür, dass nur der eigene Benutzer
hineinsehen kann; die Dateien selbst schreiben die Scripte mit `0600`.

Falls doch im Repository-Verzeichnis exportiert wird: `/odoo-export/`,
`/partners.json` und `/orders.json` stehen in `.gitignore` — verankert auf das
Wurzelverzeichnis. Das ist ein Sicherheitsnetz, kein Freibrief: in einem
Unterverzeichnis abgelegt greift es nicht.

## 3. Export ausführen

```bash
cd /pfad/zum/repo

export ODOO_URL=https://jibbit.ch
export ODOO_DB=<datenbankname>
export ODOO_USER=<odoo-login>
export ODOO_API_KEY=<api-schlüssel>

OUT=~/odoo-export-$(date +%F)

node scripts/odoo-export.mjs           "$OUT"   # Produkte und Preise
node scripts/odoo-export-customers.mjs "$OUT"   # Kunden
node scripts/odoo-export-orders.mjs    "$OUT"   # Bestellungen
```

`ODOO_DB` ist der Datenbankname, nicht die Domain. Wenn er unbekannt ist:
in Odoo unter **Einstellungen → Entwicklerwerkzeuge → Über** nachsehen. Auf
`jibbit.ch` ist `list_db = False` gesetzt, die Datenbankliste lässt sich also
nicht mehr abfragen.

### Optionen

**`odoo-export-customers.mjs`**

| Option | Wirkung |
|---|---|
| *(keine)* | Partner mit `customer_rank > 0` plus deren Unterkontakte |
| `all-partners` | **alle** Partner, also auch Lieferanten und Mitarbeiter. Normalerweise unerwünscht — mehr Personendaten als nötig. |
| `skip-archived` | archivierte Partner gar nicht erst holen |

**`odoo-export-orders.mjs`**

| Option | Wirkung |
|---|---|
| *(keine)* | alle Bestellungen und Angebote |
| `confirmed-only` | nur `state` = `sale` oder `done` |
| `states=sale,done,cancel` | frei gewählte Zustände |
| `from=2020-01-01` | erst ab diesem Bestelldatum |

## 4. Was dabei herauskommt

| Datei | Inhalt | Personendaten |
|---|---|---|
| `partners.json` | eine Zeile je `res.partner`, mit aufgelösten ISO-Ländercodes | **ja** (0600) |
| `partners-summary.json` | nur Zahlen und Odoo-IDs | nein |
| `orders.json` | `sale.order` mit eingebetteten `sale.order.line` | **ja** (0600) |
| `orders-summary.json` | nur Zahlen und Odoo-IDs | nein |
| `pricelists.json`, `pricelist-items.json`, `products.json`, `tiers.json`, `price-rules.csv` | Produkt- und Preisdaten | nein |

### Welche Odoo-Felder gelesen werden

`res.partner`: `id`, `name`, `display_name`, `is_company`, `company_type`,
`parent_id`, `type`, `email`, `phone`, `mobile`, `street`, `street2`, `city`,
`zip`, `state_id`, `country_id`, `vat`, `lang`, `ref`, `function`, `title`,
`customer_rank`, `supplier_rank`, `active`, `commercial_partner_id`,
`property_product_pricelist`, `create_date`, `write_date`.

`sale.order`: `id`, `name`, `state`, `date_order`, `partner_id`,
`partner_invoice_id`, `partner_shipping_id`, `pricelist_id`, `currency_id`,
`amount_untaxed`, `amount_tax`, `amount_total`, `client_order_ref`, `origin`,
`invoice_status`, `delivery_status`, `payment_term_id`, `user_id`, `team_id`,
`company_id`, `create_date`, `write_date`.

`sale.order.line`: `id`, `order_id`, `sequence`, `display_type`, `product_id`,
`product_template_id`, `name`, `product_uom_qty`, `qty_delivered`,
`qty_invoiced`, `product_uom`, `price_unit`, `discount`, `price_subtotal`,
`price_total`, `tax_id`, `currency_id`.

Dazu `res.country` und `res.country.state`, nur um `country_id`/`state_id` in
ISO-Codes zu übersetzen.

**Bewusst nicht gelesen:** `res.partner.comment` (interne Notizen zum Kunden),
`sale.order.note` (Kundenbemerkung), `sale.order.access_token` (Geheimnis für
das Kundenportal), Bilder, Bankverbindungen, Anhänge. Freitextfelder enthalten
erfahrungsgemäss Angaben, die Medusa nicht braucht und die nach DSG besonders
heikel sind. Wer sie braucht, findet sie weiterhin in Odoo.

Fehlt ein Feld in der eigenen Odoo-Version, meldet das Script das als Warnung
und exportiert ohne dieses Feld weiter. Der Export bricht deswegen nicht ab.

## 5. Daten prüfen

Die beiden `*-summary.json` sind dafür gemacht: sie enthalten keine
Personendaten und dürfen offen herumliegen.

```bash
cat $OUT/partners-summary.json
cat $OUT/orders-summary.json
```

Checkliste:

- **`total`** — passt die Zahl grob zur Kundenliste in Odoo?
- **`without_email`** — diese Partner lassen sich in Medusa **nicht** anlegen.
  Medusa identifiziert Kunden über die E-Mail. Ist die Zahl hoch, lohnt sich
  ein Blick in Odoo, bevor importiert wird.
- **`duplicate_email_groups`** — so viele E-Mail-Adressen kommen mehrfach vor.
  Der Import führt diese Partner zu einem Kunden zusammen. Bei einer
  auffällig hohen Zahl vorher in Odoo aufräumen.
- **`without_country`** — Adressen ohne Land. Ohne Ländercode kann Medusa nicht
  versenden. `country=ch` beim Import unterstellt die Schweiz.
- **`by_type`** — grobe Plausibilität: viel mehr `delivery`/`invoice`-Zeilen als
  eigenständige Partner deutet auf B2B-Kunden mit vielen Filialen hin.
- **`archived`** — archivierte Partner werden standardmässig **nicht**
  importiert.
- In `orders-summary.json`: **`by_state`** und **`confirmed_revenue`**. Der
  Umsatz zählt nur `sale` und `done`. Weicht er stark von der Auswertung in
  Odoo ab, stimmt der Zeitraum (`from=`) nicht.

Wer einzelne Fälle nachsehen will, sucht die Odoo-ID aus dem Import-Bericht in
Odoo unter `.../web#id=<ID>&model=res.partner&view_type=form`.

---

## 6. Import nach Medusa — Reihenfolge beim Umzug

> Der Import muss **auf der Zielinstanz** laufen, mit derselben Datenbank, die
> nachher produktiv ist.

```bash
cd backend

# 1) Grundgerüst: Region, Sales Channel, Lager, Versandprofil
npx medusa exec ./src/scripts/seed.ts

# 2) Produkte und Preise
npx medusa exec ./src/scripts/import-catalog.ts     "$OUT/catalog.json" dry-run
npx medusa exec ./src/scripts/import-catalog.ts     "$OUT/catalog.json"
npx medusa exec ./src/scripts/import-price-tiers.ts "$OUT/tiers.json" "pricelist=Public Pricelist"

# 3) Kunden — erst der Probelauf
npx medusa exec ./src/scripts/import-customers.ts "$OUT/partners.json" country=ch dry-run

# 4) Kunden — echt
npx medusa exec ./src/scripts/import-customers.ts "$OUT/partners.json" country=ch

# 5) Anmeldung vorbereiten — PFLICHT, und zwar VOR der DNS-Umstellung.
#    Ohne diesen Schritt kommt kein importierter Kunde je wieder in sein
#    Konto: "Passwort vergessen" antwortet mit 201 und verschickt nichts.
#    Siehe Abschnitt 7.
npx medusa exec ./src/scripts/prepare-odoo-logins.ts dry-run
#    -> Zusammenfassung lesen, besonders die Zeile "Konflikte".
#       Konflikte zuerst im Admin zusammenfuehren.
npx medusa exec ./src/scripts/prepare-odoo-logins.ts

# 6) Optional: alle einladen, ihr Passwort zu setzen. Ohne das fuehrt der
#    Weg ueber "Passwort vergessen" auf der Anmeldeseite — auch gut.
npx medusa exec ./src/scripts/prepare-odoo-logins.ts invite
```

**Argumente ohne führende Bindestriche** — `medusa exec` lehnt unbekannte
Optionen ab. Warum, steht in `backend/src/scripts/script-args.ts`.

### Optionen von `import-customers.ts`

| Option | Wirkung |
|---|---|
| `dry-run` | rechnet den Plan und berichtet, schreibt nichts |
| `country=ch` | Ländercode für Adressen, denen Odoo keines mitgibt |
| `limit=25` | nur die ersten 25 Kunden — für einen ersten echten Lauf |
| `include-inactive` | archivierte Odoo-Partner ebenfalls anlegen |
| `include-non-customers` | auch Partner mit `customer_rank = 0` (Lieferanten) |

Der Import ist **idempotent**: abgeglichen wird über die E-Mail-Adresse
(getrimmt, kleingeschrieben). Ein zweiter Lauf legt nichts doppelt an.
Bestehende Kunden werden **nicht** überschrieben — Korrekturen im Medusa-Admin
bleiben also erhalten. Nur wenn ein bereits importierter Kunde gar keine
Adresse hat (abgebrochener Lauf), werden die Adressen nachgetragen.

### Wie aus Odoo-Partnern Medusa-Kunden werden

Odoo kennt nur ein Modell für alles mit einer Adresse: `res.partner`. Eine
Firma, ihr Einkäufer, ihre Rechnungsadresse und ihr Lager sind vier Zeilen
derselben Tabelle. Medusa kennt einen `customer` (die E-Mail ist die Identität)
mit mehreren `customer_address`.

Die Regeln, ausführlich kommentiert in
`backend/src/scripts/odoo-customer-mapping.ts`:

1. Nur Partner mit brauchbarer E-Mail werden Kunden.
2. Unterkontakte mit `type` ≠ `contact` (also `invoice`, `delivery`, `other`, …)
   sind **Adressen**, keine Kunden. Unbekannte `type`-Werte gelten ebenfalls als
   Adresse, damit ein neuer Odoo-Wert den Import nicht abbricht.
3. Unterkontakte mit `type = contact` und eigener E-Mail werden ein eigener
   Kunde — mit dem Firmennamen des Elternteils.
4. Hat die Firma keine E-Mail, ihre Ansprechperson aber schon, erbt die
   Ansprechperson die Firmenadressen.
5. Mehrere Partner mit derselben E-Mail werden zu einem Kunden zusammengeführt.
   Wer gewinnt, entscheidet eine feste Reihenfolge (aktiv vor archiviert →
   höherer `customer_rank` → eigenständig vor Unterkontakt → vollständigerer
   Datensatz → jüngeres `write_date` → kleinere ID). Fehlende Felder werden von
   den unterlegenen Datensätzen nachgefüllt.
6. `type = invoice` wird zur Standard-Rechnungsadresse, `type = delivery` zur
   Standard-Lieferadresse. Fehlt eine davon, übernimmt die Adresse des Kunden
   selbst beide Rollen.
7. Adressen ohne Ländercode werden verworfen (mit `country=ch` unterstellt der
   Import die Schweiz). Ohne Land bricht sonst später der Checkout ab.

In `metadata` landen `odoo_partner_id`, `odoo_partner_ids` (alle
zusammengeführten), `odoo_commercial_partner_id`, `odoo_pricelist`, `odoo_vat`,
`odoo_lang` und `odoo_ref`. Medusa hat für UID und Sprache keine eigenen Felder.

**Was der Import nicht kann** und auch nicht können soll: Odoo-Preislisten in
Medusa-Kundengruppen übersetzen (die Preisliste steht als
`metadata.odoo_pricelist` bereit, die Gruppen legt man im Admin an), Kunden
löschen oder deaktivieren, bestehende Kunden aktualisieren.

---

## 7. Passwörter

**Passwörter lassen sich nicht migrieren.** Odoo hasht mit PBKDF2 (passlib),
Medusas `emailpass`-Provider mit scrypt. Ein Hash lässt sich nicht in den
anderen umrechnen — das ist der Zweck eines Hashes.

Importierte Kunden bekommen deshalb:

- `has_account = false`
- **keine** `auth_identity` und **keine** `provider_identity`
- `metadata.imported_without_account = true`

### Was das für den Login bedeutet

> **Gelöst durch `backend/src/scripts/prepare-odoo-logins.ts`** (siehe Schritt 5
> oben). Der Import selbst legt bewusst keine Identitäten an; das ist ein
> eigener Schritt, damit er wiederholbar und prüfbar bleibt. **Er ist nicht
> optional.**

Der Standardablauf von Medusa reicht **nicht**. `POST
/auth/customer/emailpass/reset-password` ruft
`generateResetPasswordTokenWorkflow` auf, und dieser Workflow sucht zuerst eine
`provider_identity` zur E-Mail-Adresse. Findet er keine, wirft er — und die
Route fängt den Fehler ab (`throwOnError: false`) und antwortet trotzdem mit
`201`, damit sie keine Konten verrät. Für einen importierten Kunden passiert
also: **nichts**, ohne sichtbaren Fehler.

`prepare-odoo-logins.ts` legt deshalb zu jeder importierten Adresse eine
echte `emailpass`-Identität mit einem zufälligen 32-Byte-Passwort an — eines,
das niemand kennt und das nirgends gespeichert wird. Damit gilt danach:

- Anmeldung schlägt fehl wie bei jedem falschen Passwort, ununterscheidbar.
- „Passwort vergessen" findet eine Identität und verschickt die E-Mail.
- Nach dem Zurücksetzen ist das Konto normal nutzbar.

Die Identität wird über `app_metadata.customer_id` mit dem **bestehenden**
Kundendatensatz verknüpft — nicht mit einem neuen. Das ist zugleich der Wert,
aus dem das Anmelde-Token seine `actor_id` zieht: fehlt er, gelingt die
Anmeldung zwar, führt aber auf kein Konto, und `/store/customers/me` antwortet
mit 401.

### Die Falle mit der zweiten Kundenzeile

Medusas Unique-Index auf `customer` geht über **(`email`, `has_account`)**, nicht
über `email` allein. Registriert sich ein importierter Kunde ganz normal neu,
entsteht daher eine **zweite** Kundenzeile mit `has_account = true` — die
importierten Adressen und die Bestellhistorie hängen an der ersten.

Deshalb:

- **`prepare-odoo-logins.ts` läuft vor der DNS-Umstellung.** Danach kann keine
  Dublette mehr entstehen: eine Registrierung mit einer importierten Adresse
  scheitert an Medusas eigenem „Identity with email already exists".
- Kunden vor dem Umzug anschreiben: Konto ist da, Passwort einmal neu setzen,
  **nicht** neu registrieren. `prepare-odoo-logins.ts invite` erledigt das.
- Falls doch Doppelzeilen entstehen: `prepare-odoo-logins.ts` zählt sie als
  „Konflikte" und nennt die `odoo_partner_id`; zusätzlich warnt ein Subscriber
  auf `customer.created` im Log. Zusammengeführt wird **von Hand** im Admin —
  welcher Datensatz gilt, hängt an Bestellungen und Adressen und ist eine
  kaufmännische Entscheidung.

---

## 8. Warum Bestellungen nicht importiert werden

Die historischen Bestellungen bleiben in Odoo. Odoo ist damit die
Archivinstanz für Buchhaltung (OR 958f: zehn Jahre) und Gewährleistung.

Der technische Grund: Medusa v2 legt Bestellungen nicht als Datensatz an,
sondern als Ergebnis von Workflows. `createOrderWorkflow` reserviert Bestand,
erzeugt Payment Collections und Fulfillments und sendet Events. Ein Massenimport
alter Bestellungen würde Lagerbestände verschieben, Zahlungsaufträge für längst
bezahlte Rechnungen anlegen und Bestätigungsmails auslösen. Schreibt man
stattdessen direkt in die Tabellen, entstehen Bestellungen ohne Payment
Collection und ohne Fulfillment: der Admin zeigt sie an, jede Aktion darauf
läuft ins Leere. Einen unterstützten Massenimport gibt es nicht.

`orders.json` ist trotzdem sinnvoll — als Sicherungskopie und als
Datengrundlage für Auswertungen: Wer hat wie oft gekauft (Kundengruppen,
B2B-Preise)? Welche Artikel tragen den Umsatz (Sortiment)? Was war der
durchschnittliche Warenkorb (Versandkostenschwelle)?

Zwei Details, die jede Auswertung sonst verfälschen:

- **Angebote sind kein Umsatz.** Nur `state` = `sale` oder `done` zählt. Jede
  Bestellung im Export trägt dafür `is_confirmed`, `is_quotation` und
  `is_cancelled`.
- **Abschnitts- und Notizzeilen** (`display_type` = `line_section` / `line_note`)
  sind keine Positionen. Sie werden verworfen und in `orders-summary.json` als
  `dropped_layout_lines` gezählt.

---

## Datenschutz (DSG)

Die Exportdateien sind eine vollständige Kopie der Kundendatenbank. Nach
Schweizer DSG gilt: nur so lange aufbewahren, wie es der Zweck verlangt — und
der Zweck ist der Umzug, nicht das Archiv.

**Aufbewahrung**

| Datei | Frist |
|---|---|
| `partners.json` | löschen, sobald der Import geprüft ist — **spätestens 30 Tage** nach dem Umzug |
| `orders.json` | löschen, sobald die Auswertungen gemacht sind — **spätestens 90 Tage** |
| `*-summary.json` | dürfen bleiben, enthalten keine Personendaten |

Odoo bleibt die Archivinstanz. Es braucht keine zweite Kopie der
Bestellhistorie auf einem Laptop.

**Löschen**

```bash
# Wenn `shred` verfügbar ist (überschreibt vor dem Löschen):
shred -u ~/odoo-export-*/partners.json ~/odoo-export-*/orders.json
rm -rf ~/odoo-export-*

# Sonst:
rm -rf ~/odoo-export-*
```

Zusätzlich prüfen:

- Kopien in `~/Downloads`, in Backups des Laptops, in Cloud-Sync-Ordnern
  (Dropbox, OneDrive, iCloud) und auf USB-Sticks
- Terminal-Mitschnitte und Log-Dateien. Export- und Import-Scripte geben
  **keine** Namen, E-Mail-Adressen oder Anschriften aus — berichtet werden nur
  Zahlen und Odoo-IDs. Trotzdem: `~/.bash_history` enthält den API-Schlüssel,
  wenn er per `export` gesetzt wurde.
- Der API-Schlüssel gehört nach dem Umzug in Odoo zurückgezogen
  (Profil → Konto-Sicherheit → Entwickler-API-Schlüssel).

**Nie ins Repository.** `/odoo-export/`, `/partners.json` und `/orders.json`
stehen in `.gitignore`. Ein einmal gepushter Commit lässt sich nicht mehr sauber
entfernen, ohne die Historie umzuschreiben. Testdaten in diesem Repository
verwenden ausschliesslich erfundene Namen.

---

## Fehlerbilder

| Meldung | Ursache |
|---|---|
| `Login abgelehnt` | Passwort statt API-Schlüssel, falscher `ODOO_DB`, oder der Benutzer darf nicht per RPC zugreifen |
| `Odoo: … (odoo.exceptions.AccessError)` | Dem Benutzer fehlen Leserechte auf *Verkauf* oder *Kontakte* |
| `! res.partner: Felder nicht vorhanden` | Odoo-Version kennt ein Feld nicht — der Export läuft ohne dieses Feld weiter |
| `Feld customer_rank fehlt — es werden ALLE Partner exportiert` | sehr alte Odoo-Version. Ausgabe vor dem Import durchsehen |
| `Keine Bestellungen gefunden` | `states=` oder `from=` zu eng gefasst |
| `Pfad zu partners.json fehlt` | `medusa exec` braucht den Dateipfad als Positionsargument, ohne `--` |
| `error: Unknown arguments: dry-run` | Bindestriche am Argument. Ohne schreiben: `dry-run`, nicht `--dry-run` |
