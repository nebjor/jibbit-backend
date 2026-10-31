# Shop-Konfiguration (White-Label)

Alles, was einen Shop vom anderen unterscheidet, steht in
`backend/src/lib/shop-config.ts` und kommt aus Umgebungsvariablen. Erster
weiterer Shop: stecklingspost.ch.

## Zwei Betriebsarten

- **Standard** (`SHOP_STRICT` nicht gesetzt): fehlende Werte fallen auf die
  bisherigen jibbit-Werte zurück. Der laufende jibbit-Server braucht deshalb
  keine Änderung an seiner `.env`. Der Rückfall ist ein Übergang; sobald jibbit
  alle Werte unten explizit setzt, kann `SHOP_STRICT=true` gesetzt und der
  Rückfall entfernt werden.
- **`SHOP_STRICT=true`** (neue Shops): kein Rückfall auf jibbit. Fehlen
  Pflichtwerte, wirft die erste Konfig-Abfrage einen Fehler, der alle fehlenden
  Variablen nennt (`ShopConfigError`). Mails und Admin-Aktionen schlagen dann
  fehl, bis die `.env` vollständig ist.

## Variablen

| Variable | Pflicht (strict) | Bedeutung | jibbit-Wert |
| --- | --- | --- | --- |
| `SHOP_STRICT` | – | `true` = keine jibbit-Defaults | leer |
| `STORE_NAME` | ja | Shopname in Betreff und Mailtext, Seed | `jibbit` |
| `STORE_URL` | ja | Storefront-URL (Reset-Links, Zahlungs-Redirects) | `https://jibbit.ch` |
| `SHOP_CONTACT_EMAIL` | ja | «Schreib uns an …» in Kundenmails | `info@jibbit.ch` |
| `ORDER_NOTIFICATION_TO` | ja | Betreiber-Mail bei neuer Bestellung, kommagetrennt | `joris@jibbit.ch` |
| `SHOP_PICKUP_ADDRESS` | nein | Abholadresse, Zeilen mit `\|` getrennt; leer = keine Abholung | `jibbit (Neber Import)\|Unterwegli 1\|8404 Winterthur` |
| `SHOP_PICKUP_HOURS` | nein | Abholzeiten | `Mo–Sa 09:00–17:00` |
| `SHOP_VAT_NOTE` | nein | MWST-Hinweis in der Bestellbestätigung; leer = keine Zeile | `keine MWST ausgewiesen (nicht mehrwertsteuerpflichtig)` |
| `SHOP_PRICE_LIST_TITLE` | nein | Titel der Preisliste für Mengenstaffeln | `Aktionspreise jibbit.ch` |
| `CLIENT_IP_HEADER` | nein | Header, in dem die Storefront die Besucher-IP mitschickt | `x-client-ip` |

Ohne strict heissen die Defaults für `SHOP_PRICE_LIST_TITLE` wie in der
Tabelle (jibbit); mit strict `Aktionspreise <STORE_NAME>`.

Weitere, schon bisher shop-neutrale Variablen (SMTP_*, `SMTP_FROM`,
`MEDUSA_BACKEND_URL`, `NTFY_URL`, Zahlungs-Provider) stehen in `.env.example`.

### Zu beachten

- **Preisliste**: Medusa sucht die Preisliste per Titel
  (`lib/preistabelle-daten.ts`, `workflows/preistabelle`). Wird
  `SHOP_PRICE_LIST_TITLE` bei einem bestehenden Shop geändert, wird die alte
  Liste nicht mehr gefunden und beim nächsten Speichern eine neue angelegt.
  Bei jibbit also nie ändern, ohne die Liste in der Datenbank umzubenennen.
- **Client-IP-Header**: Der Backend liest `CLIENT_IP_HEADER` (Default
  `x-client-ip`) und akzeptiert zusätzlich immer den alten `x-jibbit-client-ip`.
  Die jibbit-Storefront kann also unverändert weiterlaufen und später auf
  `x-client-ip` umgestellt werden; eine neue Storefront sendet `x-client-ip`.
- **Seed** (`src/scripts/seed.ts`) nimmt Shopname und Abholadresse aus der
  Konfiguration, der Katalog darin ist aber jibbit-spezifisch.
- Die Konfiguration wird bei jedem Aufruf aus `process.env` gelesen (kein Cache).

## Nicht ins Template (jibbit-spezifisch)

Beim Herauslösen eines Templates nicht mitnehmen bzw. durch Shop-eigenes
ersetzen:

- Odoo-Migration: `backend/src/scripts/odoo-*.ts`, `import-customers.ts`,
  `scripts/odoo-export-*.mjs`, `data/odoo-redirects.json`, `docs/odoo-datenmigration.md`
- Galaxus-Export: `src/scripts/galaxus-export.ts`, `nebjor/jibbit-internal (privat), galaxus-marktplatz.md`,
  `src/__tests__/galaxus.unit.spec.ts` (inkl. `provider=jibbit`)
- Produktdaten und Bilder: `data/*.json`/`*.csv`, `backend/media`, `scripts/prepare-product-images.mjs`,
  `src/scripts/import-product-images.ts`, `docs/produktbilder.md`
- Katalog, Kategorien und Versandtarife im Seed (`src/scripts/seed.ts`)
- Standort-/Marktdokumente: `docs/seo-*.md`, `docs/launch-roadmap.md`,
  `docs/buchhaltung.md`
- Deploy-Details: `Caddyfile`, `deploy/nginx`, `scripts/vps-bootstrap.sh`, `scripts/backup.sh` (Domains `api.jibbit.ch`, `api-test.jibbit.ch`)
- Der Legacy-Header `x-jibbit-client-ip` und die jibbit-Defaults in
  `lib/shop-config.ts` (`JIBBIT_DEFAULTS`) fallen im Template weg.
- Test-Fixtures mit jibbit-Namen/Domains in `src/__tests__/` (reine Testdaten).
