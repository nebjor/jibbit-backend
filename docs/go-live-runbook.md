# jibbit.ch — Go-Live Runbook (Medusa)

Von "Entwicklung fertig" bis "Bestellungen laufen ein und ich kriege eine Mail".

Stand: 2026-08-19. Reihenfolge ist bewusst — jeder Schritt setzt den vorherigen voraus.

> **Kontext:** jibbit.ch läuft heute auf **Odoo**. Der Medusa-Stack ist der Umbau.
> Nichts hier fasst den Live-Shop an, bis Schritt 8.

---

## 0. Das eine harte Gate — vor allem anderen

**Kein Payrexx-Konto eröffnen und keine Live-Credentials verdrahten, bevor eine
schriftliche Compliance-Zusage vorliegt.**

Payrexx' Verbotsliste nennt Tabak, Bongs/Vaporizer und CBD/THC — Papers, Filter
und Grinder stehen *nicht* drauf. Das ist eine echte Grauzone, und die
Auffangklausel "marijuana dispensaries and related businesses" ist genau die,
die ein Underwriter zieht. Wird das Sortiment beim Onboarding beschönigt und
fliegt später auf, ist die Folge Kündigung **mit eingefrorenem Settlement** —
also mit dem Geld bereits eingegangener Bestellungen.

Vorgehen und fertige deutsche Vorab-Anfrage stehen in
[`payment-providers-setup.md`](payment-providers-setup.md). Zwei Fragen stellen:
wird das akzeptiert, und welcher MCC wird vergeben (5993 Tabak = high-risk,
5999 misc retail = unproblematisch).

**Das blockiert nur Schritt 6.** Schritte 1–5 und 7 laufen unabhängig — anfangen.

Unabhängig davon: **Vorkasse dauerhaft als zweite Zahlart aktiv lassen**, damit
eine Provider-Pause den Shop nicht stilllegt.

---

## 1. Entwicklung abschliessen — was offen ist

`main` ist **nicht** der aktuelle Stand. Fünf Branches liegen davor:

| Branch | +Commits | Inhalt |
|---|---|---|
| `feat/vps-deployment` | +15 | VPS-Bootstrap, Storefront im Compose, Caddy, Odoo-Export, Katalog-Import, Payrexx-Idempotenz |
| `feat/swiss-rounding` | +13 | Rundung auf 5 Rappen, Staffelpreise |
| `feat/tenant-hardening` | +3 | Mandanten-Härtung (SaaS-Track, für den Livegang **nicht** nötig) |
| `feat/tiered-pricing-model` | +2 | Preismodell |
| `fix/docker-workspace-build` | +1 | Docker-Build-Fix |
| `feat/order-notifications` | neu | Bestell-Mails (Schritt 7) — basiert auf `feat/vps-deployment` |

`feat/vps-deployment` hat `swiss-rounding` und `tiered-pricing-model` bereits
gemerged und ist damit der De-facto-Integrationsbranch.

**Empfohlene Reihenfolge:**

1. `fix/docker-workspace-build` → `feat/vps-deployment` (der Build-Fix gehört unter alles andere)
2. `feat/order-notifications` → `feat/vps-deployment`
3. `feat/vps-deployment` → `main`, wenn ein Testkauf lokal durchläuft (Schritt 5)

`feat/tenant-hardening` gehört zum SaaS-Vorhaben und hat mit dem Livegang von
jibbit.ch nichts zu tun — liegen lassen.

> **Achtung, war kaputt:** `feat/vps-deployment` liess sich nicht bauen —
> `src/scripts/import-price-tiers.ts:190` hatte einen Typfehler
> (`sku` ist `string | null`, war als `string` annotiert). Auf
> `feat/order-notifications` ist das mitgefixt. Wer die Branches anders
> zusammenführt, muss den Fix mitnehmen, sonst scheitert `medusa build`.

---

## 2. Infrastruktur aufsetzen

```bash
# auf einer frischen Ubuntu-VPS
curl -fsSL https://raw.githubusercontent.com/nebjor/medusa-ecom/main/scripts/vps-bootstrap.sh | bash
```

Installiert Docker aus dem offiziellen Repo, legt `/opt/jibbit` an und klont
`medusa-ecom` **und** `jibbit-frontend` nebeneinander (das Compose baut die
Storefront aus `../jibbit-frontend`). Idempotent.

Es startet bewusst **nichts** — die Secrets fehlen noch.

Der Stack: `postgres:16` · `redis:7` · `medusa` · `storefront` · `caddy`.

### Secrets setzen

```bash
cd /opt/jibbit/medusa-ecom
cp .env.example .env
openssl rand -base64 32   # zweimal: JWT_SECRET und COOKIE_SECRET
```

Pflicht, sonst startet Compose nicht: `POSTGRES_PASSWORD`, `JWT_SECRET`,
`COOKIE_SECRET`, `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS`, `MEDUSA_BACKEND_URL`,
`STORE_URL`.

### DNS und TLS

Caddy holt Let's-Encrypt-Zertifikate automatisch — aber erst, wenn die
A-Records schon zeigen. **DNS vor dem ersten Start setzen**, sonst rennt man ins
Rate-Limit von Let's Encrypt.

> Solange jibbit.ch auf Odoo zeigt: mit einer Subdomain
> (z. B. `neu.jibbit.ch`) aufsetzen und erst in Schritt 8 umschalten.

---

## 3. Daten füttern — Odoo → Medusa

**Erst Grundgerüst, dann Katalog.** Der Seed legt Region, Lager, Steuerregion,
Fulfillment-Set und Kategorien an; ohne die hat der Katalog nichts, woran er hängt.

```bash
cd backend
npx medusa db:migrate
npm run seed                      # src/scripts/seed.ts — idempotent, CHF/Schweiz
```

### Katalog aus Odoo holen

```bash
export ODOO_URL=https://<instanz>.odoo.com
export ODOO_DB=<db>
export ODOO_USER=demo@example.com
export ODOO_API_KEY=<api-key>     # Odoo: Profil → Konto-Sicherheit → Neuer API-Schlüssel
node scripts/odoo-export.mjs ../odoo-export
```

Das Script löst Odoos Preis*regeln* zu konkreten Preiszeilen auf, indem es
Odoo selbst nach `product.product.price` je Mengenstufe fragt — Medusa kennt
keine Formeln. Kein Nachbauen der Odoo-Logik, also auch keine Abweichung.

Kein API-Zugriff? Dann `scripts/parse-price-rules.mjs preisregeln.txt` aus einem
Copy-Paste, und für Produkte/Kunden der manuelle Exportweg in
`~/projects/odoo-migration-prep.md` (Windows-Seite) — dort steht auch die
wichtigste Einstellung: **"I want to update data (import-compatible export)"**
anhaken, damit die External ID als stabiler Join-Key mitkommt, und **XLSX statt
CSV** wählen, sonst zerlegt Excel die Umlaute.

### Importieren

```bash
cd backend
npx medusa exec ./src/scripts/import-catalog.ts ../odoo-export/catalog.json dry-run
npx medusa exec ./src/scripts/import-catalog.ts ../odoo-export/catalog.json stock=50
```

Argumente **ohne** `--`, sonst lehnt `medusa exec` sie ab.

- `dry-run` — erst immer. Zeigt an, ändert nichts.
- `stock=<n>` — Bestandsführung an, Startbestand n. Ohne die Option wird
  `manage_inventory=false` gesetzt und alles ist sofort bestellbar.
- Idempotent über den Handle: vorhandene Produkte werden **übersprungen**, nicht
  überschrieben. Preise nachziehen danach mit `import-price-tiers.ts`.

**Was der Import nicht liefert:** Bilder, Beschreibungen, Gewichte. Die gehören
ins Admin. Ohne Gewicht ist der Versand nicht betroffen — jibbit rechnet pauschal.

**Zeilen zählen.** Produktzahl in Odoo vs. Produktzahl in Medusa, vor und nach
jedem Import. Sonst merkt man stillschweigend verlorene Zeilen nie.

---

## 4. Benutzer anlegen

**Admin** (das bist du):

```bash
npx medusa user -e demo@example.com -p <passwort>
```

Für weitere Personen der Einladungsweg — Achtung: **Invites verfallen nach einer
Woche**, also erst bei der Übergabe erzeugen, nicht auf Vorrat:

```bash
npx medusa user --invite <email>     # angenommen unter /app/invite?token=…
```

**Kunden** aus Odoo zu migrieren ist optional und meist nicht die Mühe wert:
Passwörter lassen sich ohnehin nicht übernehmen, alle müssten zurücksetzen. Der
Shop funktioniert für Gäste. Wenn doch, dann nur Adressbestand — Exportfelder in
`odoo-migration-prep.md`.

---

## 5. Lokaler Testkauf — bevor irgendetwas live geht

```bash
cd backend && npm run dev          # Admin: http://localhost:9000/app
```

Einmal komplett durchklicken, in dieser Reihenfolge:

- [ ] Produkt erscheint im Storefront, richtiger Preis, richtige Währung (CHF)
- [ ] Staffelpreis greift ab der richtigen Menge
- [ ] In den Warenkorb, Warenkorb überlebt einen Reload
- [ ] Checkout bis zur Adresse
- [ ] Versandmethode erscheint und rechnet (siehe Warnung Schritt 9)
- [ ] Zahlart **Vorkasse** — Bestellung geht durch
- [ ] Bestellung erscheint im Admin
- [ ] **Mail kommt an** (Schritt 7)
- [ ] Bestand sinkt, falls `manage_inventory` an ist

Erst wenn das steht, an Payrexx gehen.

---

## 6. Zahlung scharf schalten — erst nach Schritt 0

Liegt die schriftliche Zusage vor:

1. Payrexx-Konto eröffnen, Sortiment so beschreiben wie in der Anfrage
2. `PAYREXX_INSTANCE`, `PAYREXX_API_SECRET`, `PAYREXX_WEBHOOK_SECRET` in `.env`
3. `PAYREXX_ENABLED_PSPS` — PSP-IDs für TWINT und Powerpay, siehe
   <https://developers.payrexx.com/reference/retrieve-all-payment-providers>
4. Webhook-URL in Payrexx auf die öffentliche Domain zeigen lassen —
   **nicht** auf localhost, sonst bleibt jede Zahlung "pending"
5. Eine echte Zahlung über den kleinsten Artikel, dann **rückerstatten**.
   Sandbox ist nicht dasselbe wie ein echter Rappen.

Der Provider ist fertig implementiert (Gateway-API, TWINT + Powerpay, HMAC-
Webhook-Validierung, Capture/Refund, Idempotenz). Was fehlt, ist ausschliesslich
das Konto — nicht Code.

---

## 7. "Ich will eine Mail bei jeder Bestellung" — fertig

Auf `feat/order-notifications` gebaut:

- `backend/src/modules/smtp/` — SMTP-Versand via nodemailer
- `backend/src/subscribers/order-placed.ts` — hängt an `order.placed`
- `backend/medusa-config.ts` — Notification-Modul registriert

`.env`:

```
SMTP_HOST=mail.infomaniak.com
SMTP_PORT=587
SMTP_USER=<postfach>
SMTP_PASS=<passwort>
SMTP_FROM=jibbit.ch <noreply@jibbit.ch>

ORDER_NOTIFICATION_TO=demo@example.com     # ← hier landet die Bestellmail
ORDER_CONFIRMATION_TO_CUSTOMER=false
```

Die Mail enthält Bestellnummer, Positionen mit Mengen, Zwischensumme, Versand,
MwSt., Total und Lieferadresse — als HTML und als Text.

**Zwei Dinge bewusst so gebaut:**

- **Ohne `SMTP_HOST` wird nur geloggt statt versendet.** Lokale Tests und CI
  laufen so ohne Mailserver durch, ohne dass jemand Post bekommt.
- **`ORDER_CONFIRMATION_TO_CUSTOMER` steht auf `false`.** Damit schreibt eine
  Testbestellung keine echte Kundin an. **Vor dem Livegang bewusst auf `true`
  setzen** — ein Shop ohne Bestellbestätigung ist eine Support-Anfrage pro
  Bestellung. Das ist eine Entscheidung, keine Restarbeit.

Mailfehler werden geloggt, aber nicht geworfen: eine unzustellbare Mail darf
eine bereits bezahlte Bestellung nicht scheitern lassen.

**SPF/DKIM setzen**, bevor die erste echte Bestellmail rausgeht — sonst landet
sie im Spam, und zwar genau dann, wenn es zählt.

---

## 8. Umschalten

1. Bestellstopp in Odoo (oder eine ruhige Stunde wählen)
2. Katalog-Delta nachziehen, falls in Odoo seit dem Export etwas geändert wurde
3. DNS von Odoo auf die VPS umhängen, TTL vorher runtersetzen
4. Sofort danach: eine echte Bestellung über die Live-Domain, mit echter
   Zahlung, dann rückerstatten
5. Odoo eine Weile erreichbar lassen — für alte Bestellungen und Belege

**Vor dem Umschalten prüfen:** Impressum, AGB, Datenschutz, Widerruf und die
**18+-Alterskontrolle** stehen auf dem neuen Storefront. Die Altersschranke ist
auf jibbit.ch heute vorhanden und darf beim Umzug nicht verloren gehen.

---

## 9. Bekannter Defekt — vor dem Livegang entscheiden

`medusa-config.ts` steht weiterhin auf **CHF 9 pauschal, gratis ab CHF 100**:

```ts
fixedPrice: 9,
freeShippingThreshold: 100,
```

Laut `jibbit-todo.md` §1 ist genau das der Punkt, der den Preisvorteil am
Checkout auffrisst: eine gemessene Realsendung (5 Rollen Papers + 2× dubi
Filter) kostete als Brief **CHF 3.70**, nicht 9. Bei einem Warenkorb um CHF 25
sind das 36 % Versandanteil statt 15 %.

Das ist **nicht** repariert — es war nicht Teil des Auftrags, und die
Entscheidung (gestaffelter Brieftarif? B-Post als Default? Freigrenze von 100
auf 40–50?) gehört dir, nicht mir. Aber live zu gehen heisst, mit diesem
bekannten Defekt live zu gehen. Der Todo hat auch den offenen Punkt, ob der Fix
überhaupt nach Medusa portiert werden muss oder Odoo das einzige Ziel war.

Ebenfalls offen und billig: **kein Analytics**. Ohne Instrumentierung ist nach
dem Livegang nicht unterscheidbar, ob niemand kommt oder alle am Versandschritt
abspringen — und §1 sagt, es ist der Versandschritt.

---

## Reihenfolge auf einen Blick

```
0. Compliance-Anfrage raus          ← blockiert nur Schritt 6, sofort starten
1. Branches mergen (Build-Fix zuerst)
2. VPS + Secrets + DNS/TLS
3. db:migrate → seed → Odoo-Export → Katalog-Import
4. Admin-User
5. Lokaler Testkauf, komplett
6. Payrexx live  ← braucht Schritt 0
7. SMTP + ORDER_NOTIFICATION_TO, Testmail
8. DNS umschalten, echte Bestellung, rückerstatten
9. Versandkosten entscheiden
```
