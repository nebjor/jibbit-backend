# Audit jibbit: Eigenbau über Medusa v2 und Next.js-Starter

Stand: 2026-09-21 · nur gelesen, nichts geändert · Autor: Claude (Audit im Auftrag von Joris)

> **Welcher Stand wurde geprüft?** `origin/main`, nicht die lokalen Checkouts.
> Frontend `52fff49`, Backend `67e947b` (beide per `git ls-remote` bestätigt).
> Grund: Die lokalen `main`-Checkouts sind 91 bzw. 94 Commits hinter
> `origin/main` und enthalten uncommittete Altstände vom 1.–3. August (siehe
> Punkt 1 in §4). Wer den Checkout auf der Platte liest, sieht fast
> nichts von dem, was hier beschrieben ist.
> Gelesen wurde aus einem `git archive origin/main`-Abzug in einem
> Scratch-Ordner. Es wurde weder ein Worktree angelegt noch etwas am Index
> oder Arbeitsbaum der Checkouts verändert.
> Alle Pfade unten sind Repo-Pfade (`/home/jneber/projects/jibbit-frontend/…`
> bzw. `/home/jneber/projects/medusa-ecom/…`), Zeilennummern beziehen sich auf
> `origin/main`.
>
> **Parallel laufende Arbeiten (nicht Gegenstand dieses Audits):**
> `_wt-frontend-footer` (Footer-/Kundenservice-Seiten), `_wt-frontend-packsizes`
> und `_wt-medusa-packsizes` (Umbau Gebinde → Staffelpreise),
> `_wt-medusa-noreorder` (Nachbestellungen/Nachschub abschalten, Zweig
`chore/disable-nachbestellungen`: Dateien in `_`-Ordner verschoben, noch
nicht gemergt). Wo ein
> Befund davon betroffen ist, steht es dabei.

---

## 1. Kurzfazit

- **Die lokalen Checkouts sind nicht der aktuelle Stand.** Beide `main` liegen
  über 90 Commits hinter `origin/main` und tragen uncommittete Altstände vom
  August. Die SaaS-Architektur-Doku existiert nur als untracked Datei (Punkt 1).
- **Das Gebinde-Durcheinander im Admin ist selbst gebaut, nicht Medusa.**
  `import-catalog.ts` macht aus jedem Gebinde (Einzeln/Display/Box) eine eigene
  Variante mit eigenem Price Set, eigenen Staffeln und später eigenem
  Inventory-Item. Die Stückzahl steckt in unsichtbaren `variant.metadata` (§5).
- **Staffelpreise leben an zwei Orten** (Basispreis und Preisliste
  „Aktionspreise“), und zwei Scripts schreiben sie abwechselnd hin und her.
  Das ist ein echter Bug (Punkt 2).
- **Die Kit-Einträge „1 Heftchen“, „50 Stück“ stammen aus den Seed-Demo-Produkten.**
  Medusa benennt Inventory-Items nach dem Variantentitel; auf test.jibbit.ch
  stehen noch Demo-Reste, die `remove-seed-demo.ts` nicht kennt (Punkte 4–6).
- **Die Admin-Regel wird beim Katalog systematisch verletzt:** Preise, Staffeln,
  Bestand, EAN, Gewicht und Marke werden laut Doku in `data/*.json` gepflegt und
  per CLI importiert; der Admin-Preiseditor zerstört Staffeln (Punkt 3). Das
  bleibt auch im Zielmodell das Kernproblem, solange es keine Staffel-Maske
  im Admin gibt.
- **Weitere Betriebsdaten im Code:** Versandtarif doppelt (Backend-Config und
  Frontend), Rechtstexte und Betreiberdaten, Markenliste, Kontopflicht-Schalter
  (Punkte 7–10).
- **Zwei Frontend-Bugs mit Produktionsfolgen:** Der Region-Cache speichert einen
  Fehlschlag für immer, und dann zeigt der Shop einen Mock-Katalog mit echten
  Namen (Punkte 11/12).
- **Vor dem Go-live fehlen:** Odoo-Weiterleitungen (33 URLs), noindex für
  Staging, Bestellbestätigungs-Mails, Admin-Passwort-Reset per Mail; die CSP
  blockiert vermutlich PostHog (Punkte 13–18).
- **Solide gebaut:** zahls.ch-Anbindung, Warenkorb-Umgehung des
  Staffelpreis-Fehlers, Bild-Optimierung, Odoo-Kundenmigration,
  Thumbnail-Automatik. Keine eigenen DB-Modelle, also upgradefreundlich.
- **32 Entscheidungspunkte** in §4.

---

## 2. Frontend (`jibbit-frontend`)

**Vorbemerkung:** Diese Storefront ist **nicht** der Medusa-Next.js-Starter
(`nextjs-starter-medusa`). Es gibt kein `src/modules`, kein
`[countryCode]`-Routing und keine Starter-Komponenten. Es ist ein eigenes
Next.js-16-Gerüst (App Router, CSS Modules) mit eigener Datenschicht
(`lib/data.ts`, `lib/adapters.ts`) und `@medusajs/js-sdk` 2.18.0. **Praktisch
alles ist Eigenbau.** Ein Datei-für-Datei-Vergleich mit dem Starter ergibt
deshalb keinen Sinn.

Pfade relativ zu `/home/jneber/projects/jibbit-frontend/`.

### 2.1 Katalog, Produktseite, Preise

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Datenschicht mit Mock-Rückfall | Produkt- und Kategorieabfragen über das SDK; ist das Backend weg oder leer, kommt ein fest einprogrammierter Mock-Katalog | `lib/data.ts`, `lib/mock-catalog.ts` | funktioniert, riskant | Der Rückfall greift **auch in Produktion** (`data.ts:181,202,214,272,294`). Siehe Punkte 11 und 12. |
| Adapter Medusa → View | macht aus `StoreProduct` ein `ProductView`; liest `variant.metadata.units_per_pack/pack_type`, `metadata.brand`, Tag `featured`, GTIN aus `ean/upc/barcode`, `variant.thumbnail` | `lib/adapters.ts`, `lib/types.ts`, `lib/gtin.ts` | funktioniert | Details in 2.14. |
| Staffeltabelle | ruft `GET /store/price-tiers` auf, klickbare Tabelle „Mengenrabatt“ mit „Noch X Stk. bis …“ | `lib/data.ts:231-263`, `components/PriceTable.tsx`, `lib/pricing.ts` | funktioniert | Nur Anzeige, den Preis rechnet Medusa. Eine Staffel mit nur einer Stufe wird verworfen (`adapters.ts:120-122`). |
| Variantenwahl „Verpackungseinheit“ | ein Knopf je Variante (Beschriftung = `variant.title`), Badge „Bestes Angebot −x %“, Stepper bis 999, Preis pro Stück bei Displays | `components/AddToCart.tsx`, `lib/pricing.ts:121-196` | funktioniert | Vorauswahl: günstigste Einzelstück-Variante (`pricing.ts:121-127`). Wird durch `_wt-frontend-packsizes` umgebaut. |
| `?variant=` in der URL | Auswahl steht in der Adresszeile und wird serverseitig vorausgewählt | `components/VariantSelection.tsx`, `lib/pricing.ts:140-156`, `app/products/[handle]/page.tsx:75` | funktioniert | – |
| Bild je Variante | Hauptbild wechselt mit der Variante (über `variant.thumbnail`) | `lib/variant-image.ts`, `components/VariantHero.tsx` | funktioniert | Fällt im Zielmodell (eine Variante) weg. |
| Platzhalter-Kacheln | typografische Kachel aus Marke und Warenart für Produkte ohne Foto | `lib/placeholder.ts`, `components/ProductImage.tsx`, `components/MediaImage.tsx` | funktioniert | Markenliste fest im Code (`placeholder.ts:27-39`), Punkt 9. |
| Startseite = Katalog | `/` zeigt das Sortiment mit `?kategorie=`, `/shop` leitet dauerhaft (308) auf `/` um, leere Kategorie zeigt „bald verfügbar“ | `app/page.tsx`, `app/shop/page.tsx`, `app/CategoryComingSoon.tsx`, `components/CategoryNav.tsx`, `lib/nav.ts` | funktioniert | Kategorien kommen aus dem Admin. |
| „Passt dazu“ | Produkte derselben Kategorie | `lib/data.ts:311-320` | funktioniert | – |
| Lade- und Fehlerzustand | Pixel-Joint als Loader, ausgedrückter Joint als Fehlerbild | `components/PixelJoint.tsx`, `app/loading.tsx`, `app/error.tsx`, `public/loader/*`, `tools/pixel-art/*` | funktioniert | Auf `origin/main` **eingebaut**. Die Notiz „noch nicht eingebaut“ stimmt nur für den veralteten lokalen Checkout. |

### 2.2 Suche

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Sofortsuche im Header | eigene unscharfe, gewichtete Suche in TypeScript; der ganze Katalog geht als Index mit dem Layout mit | `components/search/*`, `lib/search/*` | funktioniert | Der Index wird bei jedem vollen Seitenaufruf gebaut und wächst mit dem Katalog. Bei 28 Produkten kein Problem. |
| Trefferseite `/suche` | dieselbe Suche serverseitig, ohne JS nutzbar, `noindex` | `app/suche/page.tsx` | funktioniert | – |

### 2.3 Warenkorb

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Medusa-Warenkorb | Cart-ID im httpOnly-Cookie, Änderungen per Server Action, der Reihe nach | `components/CartProvider.tsx`, `app/actions/cart.ts`, `lib/cart/*` | funktioniert | – |
| Umgehung des Staffelpreis-Fehlers | eine vorhandene Variante wird nie doppelt hinzugefügt, sondern auf die neue Gesamtmenge gesetzt, danach Kontrolle | `lib/cart/plan.ts`, `lib/cart/server.ts:242-254` | funktioniert | Umgeht einen gemessenen Medusa-Fehler (CHF 60.00 statt 33.60). Getestet und wichtig, bleibt auch im Zielmodell nötig. |
| Versandschätzung, Gratisversand-Balken | Pakettarif als Schätzung, Fortschritt bis zur Gratisgrenze | `lib/cart/shipping.ts`, `components/FreeShippingMeter.tsx` | funktioniert | Tarif doppelt gepflegt (Punkt 7). |
| Warenkorb-Schublade | seitlich, alle Beträge von Medusa | `components/CartDrawer.tsx` | funktioniert | – |

### 2.4 Kasse und Zahlung

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Kasse in zwei Schritten | Adresse, dann Versand + Kauf; einzige Versandart automatisch; Liefergebiet CH+LI | `app/checkout/page.tsx`, `components/checkout/CheckoutFlow.tsx`, `lib/checkout/server.ts`, `lib/checkout/address.ts` | funktioniert | Kommentar `CheckoutFlow.tsx:3-8` spricht noch von 3 Schritten. |
| zahls.ch | bevorzugt `pp_zahls_zahls`, leitet auf `session.data.link` weiter; `pp_system_default` in Produktion gesperrt, ausser `CHECKOUT_ALLOW_SYSTEM_PROVIDER=true` | `lib/checkout/payment.ts` | funktioniert (laut Code) | Payrexx entfernt. |
| Rückkehr nach Zahlung | `/checkout/success` fragt wiederholt nach (erst dicht, dann langsamer), dazu „abgebrochen“/„fehlgeschlagen“ | `components/checkout/PaymentReturnStatus.tsx`, `lib/checkout/return.ts`, `lib/checkout/poll-schedule.ts`, `app/checkout/{success,cancel,failed}` | funktioniert | – |
| Bestellbestätigung | `/checkout/bestellung/[id]` ohne Login, zeigt E-Mail, Adresse, Telefon | `app/checkout/bestellung/[id]/page.tsx`, `lib/checkout/order.ts` | funktioniert | Einziger Schutz ist die Bestell-ID (Punkt 21). Das Versprechen einer WhatsApp-Nachricht steht fest im Code (`page.tsx:63-70`). |
| Kontopflicht | ohne Login Umleitung auf `/konto/anmelden?next=/checkout`, Vorausfüllen, Adresse ins Adressbuch | `lib/checkout/account-requirement.ts`, `prefill.ts`, `customer.ts` | funktioniert | Schalter nur per Env `CHECKOUT_REQUIRE_ACCOUNT` (Punkt 10). |

### 2.5 Konto

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Kundenkonten | Registrieren, Anmelden, Passwort vergessen/neu, Profil, Adressbuch, Bestellübersicht; JWT im Cookie `jb_session` | `app/konto/**`, `components/account/*`, `lib/auth/*` | funktioniert | Erkennt Odoo-Importe an `customer.metadata.source/imported_from` (`lib/auth/adapters.ts:25-30`). Typ `OrderView` doppelt (`lib/auth/adapters.ts:52`, `lib/checkout/order.ts:21`). |

### 2.6 Einwilligung und Altersabfrage

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Altersabfrage 18+ | deckendes Overlay, serverseitig per Cookie, Sperrseite bei „nein“ | `components/consent/AgeGate.tsx`, `ConsentGate.tsx`, `lib/consent/*` | funktioniert | Begründet mit AGB Ziff. 3. |
| Cookie-Hinweis | widerrufbar, Link im Footer | `components/consent/ConsentBanner.tsx`, `CookieSettingsLink.tsx`, `useDialogFocus.ts` | funktioniert | Reihenfolge Altersabfrage → Intro → Cookie-Hinweis. |

### 2.7 Intro und Animation

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Intro beim Erstbesuch | Joint fliegt ein, Rauchwolke, Logo fliegt in den Header; nur Startseite, nach der Altersabfrage, mit Anti-Flacker-Inline-Script und Notbremse | `components/intro/*`, `lib/intro/*` | funktioniert | „Erstbesuch“ = einmal pro Browser-Sitzung (`lib/intro/timings.ts:50-51`), Punkt 29. Viel Code für die Abstimmung (`starter`/`decision`/`machine`). Burn-Animation gemergt und wieder zurückgenommen (#28/#29). |

### 2.8 Analytics

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| PostHog (EU) hinter Einwilligung | Events Produktansicht, Warenkorb, Kasse, Bestellung; keine Personendaten; Key zur Laufzeit | `lib/analytics/*`, `components/analytics/*` | funktioniert, wenn `POSTHOG_KEY` gesetzt | Ein Key für alle Mandanten (`lib/analytics/server.ts:18-24`). `api_host` = `eu.i.posthog.com` direkt (`lib/analytics/client.ts:72-75`); die CSP im Caddyfile lässt das nicht zu (Punkt 14). Der Umami-Zweig ist verwaist. |

### 2.9 SEO

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| JSON-LD | Organization, WebSite, `ProductGroup` mit `hasVariant` je Packung (GTIN, Offer, Staffel-`priceSpecification`, Versand, Rückgabe), ItemList, BreadcrumbList | `lib/seo/jsonld.ts` (31 KB), `components/JsonLd.tsx`, `docs/seo/jsonld-format.md`, `tools/seo/probe-jsonld.mjs` | funktioniert | `sku` = Varianten-ID statt echter SKU (`jsonld.ts:680`). Versand/Firma aus `lib/config.ts`. Das „Variante je Gebinde“-Schema wird mit dem Zielmodell hinfällig. |
| Sitemap, robots | pro Mandant | `app/sitemap.ts`, `app/robots.ts` | funktioniert | Kein noindex für Staging (Punkt 16). |
| Odoo-Weiterleitungen | – | – | **fehlt** | `data/odoo-redirects.json` im Backend-Repo (33 alte `/shop/…`-URLs) wird im Frontend nirgends verwendet (Punkt 15). |

### 2.10 Bild-Proxy

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| `/media/<host>/<key>` | holt Bilder serverseitig vom `/static` des Mandanten-Backends, kein offener Proxy, AVIF erkannt | `app/media/[...path]/route.ts`, `lib/media.ts` | funktioniert | Hängt am lokalen File-Provider; bei S3/CDN neu zu denken. |

### 2.11 Mandantenfähigkeit (SaaS)

| Feature | Was es tut | Dateien | Status | Bemerkung |
|---|---|---|---|---|
| Mandant aus dem Host | `proxy.ts` löst auf (Dev-Fallback → `STATIC_TENANTS` → Control Plane), unbekannter Host = 404 | `proxy.ts`, `lib/tenant/*` | funktioniert für `STATIC_TENANTS` | Control-Plane-Client und Cache (`lib/tenant/config-cache.ts`, `control-plane-client.ts`) sind gebaut, aber **nicht in Betrieb** (Punkt 27). |
| SDK-Client je Mandant | ein Medusa-Client pro Mandant | `lib/medusa.ts` | funktioniert | – |

### 2.12 Rechtstexte und Service-Seiten

| Feature | Dateien | Status | Bemerkung |
|---|---|---|---|
| Impressum, AGB, Datenschutz, Widerrufsrecht | `app/impressum`, `app/agb`, `app/datenschutz`, `app/widerrufsrecht` | funktioniert | Betreiberdaten fest im Code und doppelt zu `lib/config.ts:57-68` (Punkt 8). |
| Kontakt, Versand, Zahlungsarten, Rückgabe, FAQ | `app/service/*` | funktioniert | Texte fest im Code. Wird in `_wt-frontend-footer` überarbeitet. |

### 2.13 Infrastruktur, Build, Tests

| Teil | Dateien | Status | Bemerkung |
|---|---|---|---|
| Docker standalone, Build-Heap für 2-GB-VPS, `/healthz` | `Dockerfile`, `app/healthz/route.ts`, `next.config.ts` | funktioniert | – |
| `@medusajs/js-sdk`/`types` als Tarball-URL 2.18.0 | `package.json:16-17` | Workaround | Backend ist 2.13.6 (Punkt 22). |
| Logo | `components/Logo.tsx` | halbfertig | Textplatzhalter „jibbit“, das Graffiti-SVG fehlt. |
| Tests | ≈45 Vitest-Dateien (`lib/**/*.test.ts`, `app/**/page.test.ts`, `proxy.test.ts`) | vorhanden | Nicht ausgeführt (Lese-Audit). Ob sie grün sind: unklar. |

### 2.14 Was das Frontend vom Produktmodell erwartet (Bezug zu §5)

- **Produktoptionen werden gar nicht gelesen.** Angezeigt wird `variant.title`
  (`adapters.ts:100`, `AddToCart.tsx:92`). Was im Admin als Option steht, sieht
  die Kundschaft nie. Sie sieht den Variantentitel.
- **Gebindelogik in `variant.metadata`:** `units_per_pack` (≥ 1, sonst 1) und
  `pack_type` (`single|display|box`, sonst `single`), `adapters.ts:41-55`.
  Daran hängen Vorauswahl, Stückpreis, Badge „Bestes Angebot“ und
  `includesObject` im JSON-LD. Im Admin nur als rohes Schlüssel/Wert-Paar
  pflegbar, Tippfehler fallen still auf `single`/1 zurück.
- **Preis:** `calculated_price.calculated_amount` und `original_amount`
  (Streichpreis); Staffeln aus `/store/price-tiers`.
- **Dieselbe Information doppelt:** Das Badge vergleicht den Displaypreis mit der
  Staffel des Einzelstücks bei gleicher Menge. Der Code sagt selbst, dass ein
  Display meist genau `units_per_pack × Staffelpreis` kostet (`pricing.ts:159-165`).
  Staffel des Einzelstücks und Displaypreis beschreiben also denselben
  Sachverhalt und müssen von Hand gleich gehalten werden.
- **Bestand:** `inStock = !manage_inventory || allow_backorder || inventory_quantity > 0`
  (`adapters.ts:109-112`). Die Felder müssen ausdrücklich angefordert werden
  (`data.ts:152-164`).
- Weitere Felder: `variant.thumbnail`, `variant.ean/upc/barcode`,
  `product.metadata.brand` (der Import setzt sie nur aus `catalog.json`),
  `product.categories[0].handle`.

---

## 3. Backend (`medusa-ecom`)

Basis: Medusa **2.13.6** (`backend/package.json:25-29`), Paketname `jibbit-backend`.
Vergleich mit Stock: Der Medusa-Starter bringt nur `src/*/README.md`,
Beispiel-Routen `api/admin/custom` und `api/store/custom`, einen Demo-Seed
und eine minimale `medusa-config.ts`. Alles andere unten ist Eigenbau.

**Wichtig vorweg:** Es gibt **kein einziges eigenes Datenmodell, keine
Migration, keinen Workflow und keinen Modul-Link**. Alle Zusatzdaten liegen in
`metadata`-JSON-Feldern (Produkt, Variante, Kunde). Das hält Upgrades billig,
heisst aber auch: Nichts davon ist im Admin als eigenes Feld sichtbar, ausser
dort, wo ein Widget es explizit darstellt.

### 3.1 medusa-config.ts

| Anpassung | Was sie tut | Ort | Status | Bemerkung |
|---|---|---|---|---|
| Plugin `@zahls/medusa-plugin` | offizielles zahls.ch-Plugin laden | `backend/medusa-config.ts:78-86` | funktioniert (laut Tests/Doku) | Version **0.0.1** (`package.json:30`), also sehr früh. |
| Payment-Provider zahls | nur registriert, wenn `ZAHLS_INSTANCE/API_KEY/WEBHOOK_SECRET` gesetzt sind | `medusa-config.ts:66-75, 158-175`, `src/lib/zahls-plugin.ts` | funktioniert | Ohne Werte startet der Shop ohne Zahlart, nur mit Log-Warnung. |
| DB-SSL-Schalter | `DATABASE_SSL=true` oder SSL explizit aus | `medusa-config.ts:105-108` | funktioniert | Nötig für Postgres im Compose-Netz. |
| File-Provider `optimized-file` | ersetzt `file-local`, verkleinert/konvertiert Uploads (AVIF) | `medusa-config.ts:123-157`, `src/modules/optimized-file/` | funktioniert | Siehe 3.2. |
| Fulfillment `swiss-shipping` | Versandtarif Brief/Paket/gratis | `medusa-config.ts:176-195` | funktioniert | **Tarif hart im Code:** 3.75 / 9 / 69 / 1000 g (`:187-190`). Verstoss gegen die Admin-Regel, siehe Punkt 7. |
| Notification `smtp-notification` | E-Mail über SMTP (nodemailer) | `medusa-config.ts:196-230` | funktioniert | Einziger Versand ist die Kunden-Passwort-Mail. |
| `jwtSecret`/`cookieSecret` Fallback `"supersecret"` | Stock-Verhalten | `medusa-config.ts:114-115` | – | Compose erzwingt die Werte (`docker-compose.yml:86-87`), lokal nicht. |
| Redis nur als `redisUrl` | Session-Store | `medusa-config.ts:109` | unklar | Event-Bus, Cache, Workflow-Engine und Locking laufen weiter **in-memory**. Subscriber-Events gehen bei Neustart verloren (der Thumbnail-Job sagt das selbst, `src/jobs/product-thumbnail-backfill.ts:222-224`). Stock-Starter macht es genauso, für Produktion aber zu prüfen. |

### 3.2 Module / Provider

| Modul | Was es tut | Ort | Status | Bemerkung |
|---|---|---|---|---|
| `optimized-file` | erbt von `LocalFileService`, verkleinert Bilder auf max. 2000 px, AVIF, Original bei Fehler | `backend/src/modules/optimized-file/service.ts` (356 Z.) | funktioniert (Unit-Test `optimized-file.unit.spec.ts`) | Sauber gebaut. AVIF-Encode dauert laut `.env.example:21-23` mehrere Sekunden pro Foto auf der 2-GB-VPS. |
| `swiss-shipping` | Fulfillment-Provider: gratis ab 69, sonst Brief/Paket nach Summengewicht, ohne Gewicht immer Paket | `backend/src/modules/swiss-shipping/service.ts` | funktioniert | Das Gewicht kommt aus `variant.weight`, Variante vor Produkt (`:146-148`). Rücksendung: gleicher Preis wie Paket. `getFulfillmentOptions` hat einen Beschreibungstext mit Preisen (`:255-258`); der Seed schreibt bewusst keinen (`seed.ts:345-352`). |
| `smtp-notification` | Notification-Provider SMTP, rendert nichts, nimmt `content` | `backend/src/modules/smtp-notification/service.ts` | funktioniert | Es gibt **keine** Bestellbestätigung, Versandmail usw. (Branch `feat/order-notifications` liegt unmerged). |
| Payrexx-Eigenbau | – | – | entfernt | Auf `origin/main` komplett entfernt (Commit `6385a4f`). Übrig: `axios` und `ioredis` in `backend/package.json:31-32`, die nirgends mehr importiert werden (Punkt 23). |

### 3.3 API-Routen und Middlewares

| Route | Was sie tut | Ort | Status | Bemerkung |
|---|---|---|---|---|
| `GET /store/price-tiers` | liefert Mengenstaffeln je Variante: Sprungstellen aus Rohpreisen, Beträge über `calculatePrices` pro Sprungstelle, eingeschränkte Preislisten gesperrt | `backend/src/api/store/price-tiers/route.ts`, `tiers.ts` | funktioniert (umfangreiche Unit-Tests) | Nötig, weil `/store/products` nur Menge 1 liefert. Pro Sprungstelle ein `calculatePrices`-Aufruf (max. 30). Existiert **nur**, weil Staffeln in zwei Preisquellen liegen (Deep-Dive §5). |
| `GET /` | 302 auf `/app` (Admin) | `backend/src/api/route.ts` | funktioniert | Kosmetik. |
| `GET /hooks/payment/zahls_zahls` | beantwortet die GET-Probe von zahls.ch | `backend/src/api/hooks/payment/zahls_zahls/route.ts` | funktioniert | Zusammen mit `preserveRawBody` in `middlewares.ts:87-91`. Fragil: Die statische Route zwingt den Raw-Body-Eintrag. Wenn jemand eines von beidem löscht, scheitert jede Webhook-Signatur still. |
| `GET /admin/custom`, `GET /store/custom` | Stock-Beispielrouten, geben 200 | `backend/src/api/admin/custom/route.ts`, `store/custom/route.ts` | toter Code | aus dem Starter übrig (Punkt 23). |
| Middleware `validateNachschubBody` | prüft bei jedem `POST /admin/products*` den Body rekursiv auf Nachschub-Metadaten (nur http(s)-URLs) | `backend/src/api/middlewares.ts:46-66` | funktioniert | Läuft auf **jedem** Produkt-POST, auch bei Bild-Uploads. Fällt weg, wenn Nachschub abgeschaltet wird (`_wt-medusa-noreorder`). |
| Middleware `validateAddress` | verlangt PLZ ≥ 4 Zeichen und Ort bei Adress-POSTs | `middlewares.ts:7-30, 92-101` | halbfertig | Greift nur auf `POST /admin/customers/:id/addresses` und `POST /store/customers/me/addresses`, **nicht** auf Adress-Updates (`…/addresses/:address_id`) und nicht auf Checkout-Adressen am Warenkorb. Herkunft laut Git: erster Commit „Project Setup“. |

### 3.4 Subscriber und Jobs

| Name | Auslöser | Ort | Status | Bemerkung |
|---|---|---|---|---|
| `customer-password-reset` | `auth.password_reset` | `backend/src/subscribers/customer-password-reset.ts` | funktioniert | **Nur Kunden** (`:294`). Admin-Benutzer bekommen beim Passwort-Reset keine E-Mail, deshalb gibt es das CLI-Script `set-admin-password.ts` (Punkt 13). |
| `duplicate-odoo-customer-warning` | `customer.created` | `backend/src/subscribers/duplicate-odoo-customer-warning.ts` | funktioniert | Schreibt nur eine Log-Warnung, die niemand sieht, solange keiner das Log liest. |
| `product-thumbnail` | `product.created/updated` | `backend/src/subscribers/product-thumbnail.ts`, `src/lib/product-thumbnail.ts` | funktioniert | Setzt das Vorschaubild aus dem ersten Galeriebild, wenn es leer ist. Gut für die Admin-Regel. |
| Job `product-thumbnail-backfill` | stündlich (`0 * * * *`) | `backend/src/jobs/product-thumbnail-backfill.ts:51-52` | funktioniert | Doppelt zum Subscriber, als Auffangnetz gedacht. Bei ~30 Produkten billig; ein stündlicher Vollscan auf Dauer ist aber überdimensioniert (Punkt 25). |

### 3.5 Admin-Erweiterungen

| Erweiterung | Was sie tut | Ort | Status | Bemerkung |
|---|---|---|---|---|
| Widget „Nachschub“ (Produktseite, `product.details.after`) | Lieferanten je Produkt (`product.metadata.suppliers`), Meldebestand je Variante (`variant.metadata.reorder_point`), Ist-Bestand anzeigen | `backend/src/admin/widgets/nachschub-widget.tsx` (643 Z.), `src/admin/lib/nachschub-daten.ts`, `src/admin/components/lieferant-link.tsx`, `src/lib/nachschub.ts` (≈700 Z.) | funktioniert | Grosser Umfang für eine Metadaten-Maske. Enthält Alt-Daten-Migration (Lieferanten früher je Variante). **Wird gerade abgeschaltet** (`_wt-medusa-noreorder`). |
| Admin-Seite „Nachschub“ (Sidebar) | Einkaufsliste aller Varianten ≤ Meldebestand | `backend/src/admin/routes/nachschub/page.tsx` | funktioniert | Lädt alle Produkte clientseitig. Auch von der Abschaltung betroffen. |
| Admin-Favicon | patcht nach `medusa build` die gebaute `index.html` | `backend/scripts/admin-favicon.mjs`, `backend/assets/admin-favicon.png`, `package.json:16` | funktioniert | Bricht den Build absichtlich, wenn Medusa den Platzhalter ändert. Kosmetik mit Upgrade-Risiko. |
| i18n | leeres `admin/i18n/index.ts` | `backend/src/admin/i18n/index.ts` (17 Bytes) | toter Code/Platzhalter | – |
| zahls-Plugin Admin-Teil | laut Kommentar „Admin-Erweiterungen“ des Plugins | `medusa-config.ts:79-81` | unklar | Was das Plugin im Admin zeigt, wurde nicht geprüft. |

### 3.6 Scripts (`medusa exec`) und Hilfsskripte

Alle `medusa exec`-Scripts nutzen die eigene Argument-Syntax `name=wert`
(`src/scripts/script-args.ts`), weil die Medusa-CLI `--flags` ablehnt.

| Script | Zweck | Ort | Status | Bemerkung |
|---|---|---|---|---|
| `seed.ts` | Store CHF, Region Schweiz (inkl. MwSt.), Steuer 8.1 %, Lager „Lager Zürich“, Fulfillment, API-Key, Kategorien **und 13 Demo-Produkte** | `backend/src/scripts/seed.ts` | funktioniert, aber problematisch | Demo-Produkte mit Variantentiteln „1 Heftchen“, „5er Pack“, „50 Stück“ (`:479-636`), Kategorie „Kräutermischungen“ inkl. „Greengo Kräutermischung“ als Tabakersatz (`:431, 604-614`). Lageradresse „Hardturmstrasse 1“ wirkt erfunden (`:228`). Setzt **jedem** Inventory-Item ohne Level 1000 Stück (`:699-727`), auch echten Artikeln (Punkt 4). |
| `remove-seed-demo.ts` | löscht die Demo-Produkte per fester Handle-Liste, danach leere Kategorien | `backend/src/scripts/remove-seed-demo.ts` | halbfertig | Die Liste deckt **nicht** alle Demo-Reste auf test.jibbit.ch ab (`elements-ultra-thin-king-size-slim-kss`, `purize-xtra-slim-6mm` fehlen, vgl. `docs/product-inventory.md:123-132`). Löscht zudem **jede** leere Kategorie, auch absichtlich leere (Punkt 5). |
| `import-catalog.ts` | legt Produkte aus `data/catalog.json` an: Option „Verpackungseinheit“, eine Variante je Gebinde, Staffelpreise als Basispreise, SKU aus Wortkürzeln, Kategorie per Regex aus dem Namen | `backend/src/scripts/import-catalog.ts` | funktioniert | Kern des Gebinde-Problems (§5). `stock=<n>` legt Levels für **alle** Inventory-Items der DB an, nicht nur für neue (`:491-519`). |
| `update-catalog.ts` | zieht bestehende Produkte aus `catalog.json`/`catalog-extra.json`/`product-content.json`/`inventory.json` nach: Texte, EAN, Gewicht, Marke, **Basispreise**, Bestand | `backend/src/scripts/update-catalog.ts` (818 Z.) | funktioniert, **kollidiert** mit `import-price-lists.ts` | Schreibt die Staffeln zurück in die Basispreise (`:412-434`), obwohl `import-price-lists.ts` sie in die Preisliste verschoben hat (Punkt 2). Legt Inventory-Items **nur mit SKU, ohne Titel** an (`:762-766`). |
| `import-price-tiers.ts` | Staffeln aus einem Odoo-`tiers.json` in Basispreise | `backend/src/scripts/import-price-tiers.ts` | toter Code (für den aktuellen Datenstand) | Laut `data/README.md:34-37` nicht gebraucht (alle SKUs `null`). Lebt nur noch als Re-Export von `roundTo` (`:45-48`), den `import-catalog.ts:58` und `update-catalog.ts:75` von dort holen (Punkt 23). |
| `import-price-lists.ts` + `price-list-mapping.ts` | Basispreis ← regulärer Preis (von jibbit.ch gescrapt), Preisliste „Aktionspreise jibbit.ch“ ← Staffeln aus `catalog.json`; unscharfer Namensabgleich Odoo↔Medusa | `backend/src/scripts/import-price-lists.ts`, `price-list-mapping.ts`, `docs/preislisten.md` | funktioniert | „Die Preisliste gehört dem Import“: Handeingaben im Admin werden beim nächsten Lauf überschrieben (`docs/preislisten.md:100-103`). Verstoss gegen die Admin-Regel (Punkt 3). |
| `pricing-helpers.ts` | `roundTo` (5 Rappen), `collapseEqual`, `samePriceRows` | `backend/src/scripts/pricing-helpers.ts` | funktioniert | – |
| `gtin.ts` | GS1-Prüfziffer, GTIN nach `variant.ean` | `backend/src/scripts/gtin.ts` | funktioniert | Zwei Katalogfelder `gtin` **und** `ean` für dieselbe Spalte (`data/README.md:86-91`), redundant (Punkt 24). |
| `import-product-images.ts` | lädt aufbereitete Bilder aus `backend/media/` hoch und ordnet sie zu (Idempotenz über `metadata.image_sources`) | `backend/src/scripts/import-product-images.ts`, `backend/media/product-images.json`, `scripts/prepare-product-images.mjs` | funktioniert | Einmaliger Migrationsweg; Bilder liegen zusätzlich als JPG+WebP im Repo (≈1.5 MB). |
| `import-customers.ts` + `odoo-customer-mapping.ts` | Odoo-Kunden (`partners.json`) → Medusa-Kunden + Adressen | `backend/src/scripts/import-customers.ts`, `odoo-customer-mapping.ts` | funktioniert (laut Tests) | Einmalige Migration. |
| `prepare-odoo-logins.ts` + `lib/odoo-login-claim.ts` | importierte Kunden anmeldefähig machen (Auth-Identity, optional Einladungsmail) | `backend/src/scripts/prepare-odoo-logins.ts` | funktioniert (laut Tests) | Einmalige Migration. Zwei Metadaten-Schlüssel für dieselbe Sache (`source` vs. `imported_from`, Odoo-ID als Zahl vs. String), `lib/odoo-login-claim.ts:387-409`, (Punkt 24). |
| `galaxus-export.ts`, `galaxus-report.ts`, `galaxus-common.ts` | CSV-Export fürs Galaxus-Händlerprogramm, Bereitschaftsbericht | `backend/src/scripts/galaxus-*.ts`, `docs/galaxus-marktplatz.md` | halbfertig | Kein Upload, keine Aufnahme bei Galaxus. Report verweist fürs Nachpflegen auf `catalog.json` (`galaxus-report.ts:680-682`), Verstoss gegen die Admin-Regel. |
| `nachschub-report.ts` | Terminal-/CSV-Version der Nachschub-Seite | `backend/src/scripts/nachschub-report.ts` | funktioniert | Doppelt zur Admin-Seite; fällt mit der Abschaltung weg. |
| `set-admin-password.ts` | Admin-Passwort per CLI setzen | `backend/src/scripts/set-admin-password.ts` | funktioniert | Workaround, siehe Punkt 13. |
| Root-Scripts (Node, ausserhalb Medusa) | `odoo-export.mjs`, `odoo-export-customers.mjs`, `odoo-export-orders.mjs`, `lib/odoo-rpc.mjs`, `parse-price-rules.mjs`, `jibbit-shop-prices.mjs`, `prepare-product-images.mjs`, `backup.sh`, `vps-bootstrap.sh` | `/home/jneber/projects/medusa-ecom/scripts/` | gemischt | Bestellexport ohne Import (bewusst, `docs/odoo-datenmigration.md:334-348`). `parse-price-rules.mjs` (Copy-Paste-Parser) ist durch `catalog.json` überholt. |

### 3.7 Daten und Doku im Repo

| Datei | Inhalt | Bemerkung |
|---|---|---|
| `data/catalog.json`, `catalog-extra.json` | Produktstamm mit Gebinde-Varianten und Staffeln | Laut Doku der Ort, an dem Preise geändert werden (`docs/preislisten.md:100-103`). Verstoss gegen die Admin-Regel. |
| `data/inventory.json` | Bestand je SKU, „vom Betreiber zu pflegen“ (`data/README.md:54-58`) | Verstoss gegen die Admin-Regel (Punkt 3). |
| `data/price-lists.json` | reguläre Preise, gescrapt von jibbit.ch | Einmalquelle. |
| `data/product-content.json` | Texte, teils „generiert“ | Einmalquelle. |
| `data/product-inventory.json` (133 KB), `gtin-*.json`, `gtin-scan-sheet.csv` | GTIN-Recherche | Arbeitsmaterial, kein Laufzeitbezug. |
| `data/odoo-redirects.json` | alte Odoo-URLs → neue Pfade | Laut `data/README.md:59-62` „in der Storefront einzubauen“. Ob das passiert ist, prüft der Frontend-Teil. |
| `docs/*.md` | 10 Dokumente, u. a. SEO-Recherche (27 KB) und Googlebot-Check (36 KB) | Viel Doku, teils Entwurf (`product-pricing-model.md` „Status: Entwurf“). |

### 3.8 Infrastruktur

| Teil | Ort | Bemerkung |
|---|---|---|
| Docker Compose: Postgres 16, Redis 7, Medusa, Storefront (baut aus Nachbar-Repo), Caddy (Profil) | `docker-compose.yml` | Ports nur auf Loopback, gut. `STATIC_TENANTS` ist Pflicht, sonst liefert die Storefront überall 404 (`:172-181`). |
| Caddy | `Caddyfile` | CSP `connect-src 'self' https://api.jibbit.ch` hart kodiert (`:71`); auf test.jibbit.ch (`api-test.jibbit.ch`) und für PostHog passt das nicht (Punkt 14). Der Block `handle /hooks/payment/*` (`:36-39`) ist redundant (kein Rate-Limit vorhanden). |
| nginx-Variante | `deploy/nginx/test.jibbit.ch.conf` | zweiter Reverse-Proxy-Weg parallel zu Caddy. |
| Dockerfile Low-Mem-Build | `backend/Dockerfile` | für die 2-GB-VPS. |
| Tests | `backend/src/__tests__/*.unit.spec.ts` (18 Dateien), `integration-tests/http/health.spec.ts` | Gute Abdeckung der reinen Logik, keine Integrationstests gegen Medusa ausser Health. |
| SaaS-Silo | `docs/multi-tenancy-architecture.md` (nur lokal, untracked), Frontend `lib/tenant/*` | Im Backend gibt es dafür keinen Code; im Frontend schon (siehe §2). |

---

## 4. Auffälligkeiten / Entscheidungen nötig

Fragen an Joris, keine erledigten Änderungen. Aufwand: S = Stunden,
M = ein bis zwei Tage, L = mehr. Reihenfolge grob nach Wichtigkeit.

### Repo und Prozess

**1. Lokale Checkouts veraltet, mit uncommitteten Altständen**
- *Ort:* `/home/jneber/projects/medusa-ecom` (`main` @ `8911597`, 94 hinter
  `origin/main`) und `/home/jneber/projects/jibbit-frontend` (`main` @ `dc7607b`,
  91 hinter). Dateistempel der lokalen Änderungen: 1.–3. August.
- *Backend, gestaged:* `.env.example`, `Caddyfile`, `backend/Dockerfile`,
  `backend/medusa-config.ts`, `backend/package-lock.json`, `backend/package.json`,
  `backend/src/modules/payrexx/service.ts`, `docker-compose.yml` (geändert);
  `backend/src/__tests__/payrexx-idempotency-store.unit.spec.ts`,
  `backend/src/__tests__/payrexx-webhook-idempotency.unit.spec.ts`,
  `backend/src/api/store/price-tiers/route.ts`,
  `backend/src/modules/payrexx/SECURITY-NOTES.md`,
  `backend/src/modules/payrexx/idempotency-store.ts`,
  `backend/src/scripts/import-catalog.ts`, `import-price-tiers.ts`,
  `script-args.ts`, `deploy/nginx/test.jibbit.ch.conf`,
  `docs/product-pricing-model.md`, `scripts/odoo-export.mjs`,
  `scripts/parse-price-rules.mjs`, `scripts/vps-bootstrap.sh` (gelöscht).
  *Nicht gestaged:* `backend/src/scripts/seed.ts`, `docs/payment-providers-setup.md`.
  *Untracked:* `backend/src/scripts/check-stock.ts`,
  `backend/src/scripts/purge-products.ts`, `docs/multi-tenancy-architecture.md`.
- *Frontend, nicht gestaged:* `.env.example`, `app/datenschutz/page.tsx`,
  `app/globals.css`, `app/products/[handle]/page.tsx`, `components/AddToCart.tsx`,
  `components/CartButton.tsx`, `components/CartDrawer.tsx`, `lib/data.ts`,
  `next.config.ts`, `package-lock.json`, `package.json`. *Untracked:*
  `components/TrackProductView.tsx`, `instrumentation-client.ts`,
  `lib/analytics.ts`, `public/loader/*`, `.claude/`.
- *Warum ein Problem:* Wer im Checkout arbeitet oder liest, sieht einen Stand
  von Anfang August. Die SaaS-Architektur (`docs/multi-tenancy-architecture.md`,
  28 KB) existiert **nur** als untracked Datei und ist nirgends gesichert.
  Dazu kommen ≈60 `_wt-*`-Worktrees und ≈45 ungemergte Remote-Zweige, darunter
  widersprüchliche Paare (`feat/zum-shop-burn-animation` vs.
  `revert/burn-animation`, `ship/tariff-fe` vs. `ship/tariff-fe2`) und liegen
  gebliebene Arbeit, die relevant wirkt (`feat/order-notifications`,
  `feat/staging-noindex`, `fix/katalog-skripte-sicher`,
  `fix/media-proxy-avif`).
- *Vorschlag:* Altstände verwerfen oder bewusst auf einen Zweig retten,
  Multi-Tenancy-Doku committen, `main` vorspulen, erledigte Worktrees/Zweige
  aufräumen. **Nicht während der laufenden Agenten-Arbeiten.**
- *Aufwand:* S

### Produkt, Preis, Bestand (Details in §5)

**2. Zwei Preisquellen für die Staffeln, und zwei Scripts, die sich gegenseitig überschreiben (Bug)**
- *Ort:* `backend/src/scripts/import-price-lists.ts:1-53` (Staffeln → Preisliste
  „Aktionspreise jibbit.ch“, Basispreis = regulärer Preis) vs.
  `backend/src/scripts/update-catalog.ts:405-434, 722-733` (Basispreis = Staffeln
  aus `catalog.json`).
- *Warum ein Problem:* `update-catalog.ts` vergleicht die Basispreise mit den
  Katalog-Staffeln, findet nach `import-price-lists.ts` nur noch einen
  regulären Preis und schreibt die Staffeln zurück in den Basispreis. Dann
  liegen die Staffeln doppelt vor, der Streichpreis verschwindet (regulär =
  Aktion), und der nächste `import-price-lists.ts`-Lauf dreht es wieder um.
  Beide Scripts sind als laufende Pflegewege dokumentiert (`data/README.md:152-165`,
  `docs/preislisten.md:98-110`). Der Kommentar der Store-Route geht davon aus,
  dass die Staffeln **nur** in der Preisliste liegen
  (`api/store/price-tiers/route.ts:23-27`).
- *Vorschlag:* Eine einzige Quelle festlegen. Im Zielmodell (Staffeln auf der
  einen Variante) entweder Basispreis-Staffeln **oder** Preisliste, nicht
  beides.
- *Aufwand:* M

**3. Preise, Staffeln, Bestand, EAN, Gewicht und Marke werden über JSON-Dateien und CLI gepflegt (Verstoss gegen die Admin-Regel)**
- *Ort:* `docs/preislisten.md:100-106` („Die Preisliste gehört dem Import“,
  „Staffelpreise nie im Admin anfassen“, „in `data/*.json` ändern, committen,
  importieren“); `data/README.md:54-58` (`inventory.json` „vom Betreiber zu
  pflegen“); `backend/src/scripts/galaxus-report.ts:680-682` (EAN/Gewicht/Marke
  in `catalog.json`); `docs/product-pricing-model.md:134-141` (Admin-Preismaske
  überschreibt Staffeln).
- *Warum ein Problem:* Genau das Gegenteil der Regel „alles im Admin, ohne
  Dateien“. Wer im Admin einen Preis korrigiert, verliert die Staffeln
  stillschweigend, und der nächste Import überschreibt Handeingaben.
- *Vorschlag:* Die Scripts klar als **einmalige Migration** einstufen und
  danach stilllegen. Für Staffeln braucht es eine Admin-Maske (Widget), weil
  Medusas Standard-Preiseditor keine Staffeln kennt. Das bleibt auch im
  Zielmodell nötig.
- *Aufwand:* L (die Admin-Maske); S für den Entscheid „Scripts nur Migration“.

**4. Der Seed legt Demo-Produkte an und setzt allen Artikeln ohne Bestand 1000 Stück**
- *Ort:* `backend/src/scripts/seed.ts:424-740`; Bestand `:699-727`.
- *Warum ein Problem:* (a) 13 erfundene Produkte mit erfundenen Preisen
  landen in jeder frischen Instanz (auch in jedem künftigen SaaS-Silo).
  (b) Ihre Variantentitel „1 Heftchen“, „50 Stück“ werden zu
  Inventory-Item-Titeln. Das ist der Müll im Kit-Dropdown (§5.2 Nr. 5).
  (c) Ein erneuter Seed-Lauf nach dem echten Import gibt **jedem** echten
  Inventory-Item ohne Level 1000 Stück, und die Artikel wirken dann lieferbar.
  (d) Kategorie „Kräutermischungen“ und „Greengo Kräutermischung“ als
  „Standard-Ersatz für Tabak beim Mischen“ (`:604-614`) widersprechen der
  Sortimentslinie. (e) Die Lageradresse „Hardturmstrasse 1, 8005 Zürich“
  (`:224-229`) sieht erfunden aus.
- *Vorschlag:* Seed auf Infrastruktur beschränken (Region, Steuer, Lager,
  Versand, Key), Demo-Produkte und die Bestandsschleife raus, Lageradresse
  klären.
- *Aufwand:* S

**5. `remove-seed-demo.ts` erwischt nicht alle Demo-Reste und löscht jede leere Kategorie**
- *Ort:* `backend/src/scripts/remove-seed-demo.ts:42-56, 110-135`; Befund auf
  test.jibbit.ch: `docs/product-inventory.md:123-132`.
- *Warum ein Problem:* Auf test.jibbit.ch stehen noch
  `elements-ultra-thin-king-size-slim-kss` und `purize-xtra-slim-6mm` (aus einer
  älteren Seed-Version), die nicht auf der Liste stehen. Solange sie
  existieren, bleiben ihre Inventory-Items im Kit-Dropdown. Ausserdem löscht
  das Script **alle** leeren Kategorien, auch eine absichtlich vorbereitete
  (die Storefront zeigt dafür sogar „bald verfügbar“).
- *Vorschlag:* Demo-Reste einmalig im Admin löschen (Produkte **und**
  verwaiste Inventory-Items prüfen), danach das Script entfernen.
- *Aufwand:* S

**6. Inventory-Items ohne Produktbezug im Namen**
- *Ort:* Medusa-Standard `create-product-variants.js` (Item-Titel =
  Variantentitel); `backend/src/scripts/update-catalog.ts:762-766` (Items nur mit
  SKU, **ohne Titel**).
- *Warum ein Problem:* Im Admin (Inventar, Kit-Auswahl, Reservierungen) weiss
  niemand, zu welchem Produkt „Einzeln“ oder „ANG-SLI-FIL-6MM-120-EA“ gehört.
- *Vorschlag:* Im Zielmodell Titel = Produktname setzen (einmalige
  Bereinigung der bestehenden Items).
- *Aufwand:* S

### Betriebsdaten im Code (Admin-Regel)

**7. Versandtarif doppelt hart kodiert**
- *Ort:* `backend/medusa-config.ts:187-190` und Frontend `lib/config.ts:20-27`
  (verwendet in Header, Footer, FAQ, Versandseite, **AGB** `app/agb/page.tsx:87-89`,
  Produktseite, JSON-LD, `lib/cart/shipping.ts`).
- *Warum ein Problem:* Eine Tarifänderung heisst Code in zwei Repos ändern und
  deployen. Laufen die beiden auseinander, zeigt der Shop andere Preise, als
  die Kasse berechnet (ist mit dem Seed-Text schon einmal passiert,
  `seed.ts:345-352`).
- *Vorschlag:* Tarif an einer Stelle, im Admin pflegbar (z. B. Store- oder
  Shipping-Option-Metadaten plus kleines Widget), Frontend liest ihn.
- *Aufwand:* M

**8. Rechtstexte, Betreiberdaten, FAQ und Servicetexte nur per Code änderbar**
- *Ort:* Frontend `lib/config.ts:57-68` und doppelt in `app/impressum`,
  `app/agb:32-33`, `app/datenschutz:30-31`; `app/service/*`.
- *Warum ein Problem:* Admin-Regel; im SaaS-Modell hätte jeder Mandant
  jibbits Impressum.
- *Vorschlag:* Entscheid: CMS/Admin-Inhalte oder bewusst als
  Entwickleraufgabe belassen. Mindestens die Doppelung beseitigen.
- *Aufwand:* M–L

**9. Marke kommt aus einer fest einprogrammierten Liste**
- *Ort:* Frontend `lib/placeholder.ts:27-39`, `lib/adapters.ts:146`; Backend setzt
  `metadata.brand` nur aus `catalog.json` (`import-catalog.ts:373`).
- *Warum ein Problem:* Eine neue Marke erfordert eine Codeänderung; im Admin
  gibt es kein Markenfeld.
- *Vorschlag:* Marke als pflegbares Feld (Medusa kennt keine Marke nativ:
  Tag, Collection oder Metadaten mit Widget).
- *Aufwand:* S–M

**10. Kontopflicht nur per Umgebungsvariable**
- *Ort:* Frontend `lib/checkout/account-requirement.ts:31`, `.env.example:58`.
- *Warum ein Problem:* Betrieblicher Schalter, Änderung braucht Neustart.
- *Vorschlag:* Entscheiden, ob das ein Betriebsschalter ist (dann Admin).
- *Aufwand:* S–M

### Bugs und Risiken

**11. Region-Cache speichert auch den Fehlschlag (Bug)**
- *Ort:* Frontend `lib/data.ts:51-72`.
- *Warum ein Problem:* Ist Medusa beim ersten Aufruf nicht erreichbar (z. B.
  Storefront startet im Compose vor Medusa), bleibt `undefined` für die ganze
  Prozesslaufzeit gecacht. Der Shop zeigt dann bis zum Neustart den
  Mock-Katalog, Warenkörbe entstehen ohne Region (`lib/cart/server.ts:166-170`).
- *Vorschlag:* Nur Erfolge cachen.
- *Aufwand:* S

**12. Mock-Katalog auch in Produktion**
- *Ort:* Frontend `lib/data.ts:181,202,214,272,294,323`, `lib/mock-catalog.ts`.
- *Warum ein Problem:* Bei einem Backend-Ausfall sieht die Kundschaft einen
  Scheinkatalog mit alten Preisen, bei dem „In den Warenkorb“ scheitert. Im
  Admin gelöschte Produkte, die im Mock stehen, bleiben sichtbar. Jeder
  SaaS-Mandant bekäme jibbits Produkte.
- *Vorschlag:* Mock nur ausserhalb von Produktion, sonst ehrliche
  Fehlerseite.
- *Aufwand:* S–M

**13. Admin-Passwort vergessen: es kommt keine E-Mail**
- *Ort:* `backend/src/subscribers/customer-password-reset.ts:291-296` (nur
  `actor_type === "customer"`); Workaround `backend/src/scripts/set-admin-password.ts`.
- *Warum ein Problem:* Mitarbeitende ohne IT-Kenntnisse kommen nach
  vergessenem Passwort nur per CLI zurück. Der Kommentar im Script („kein
  Notification-Provider“) ist inzwischen überholt, SMTP ist da.
- *Vorschlag:* Subscriber auch für `user` mit Link auf `/app/reset-password`.
- *Aufwand:* S

**14. CSP im Caddyfile blockiert vermutlich PostHog und passt nicht zu Staging**
- *Ort:* `Caddyfile:71` (`connect-src 'self' https://api.jibbit.ch`);
  Frontend `lib/analytics/client.ts:72-75` (`api_host` = `eu.i.posthog.com`).
- *Warum ein Problem:* Caddy läuft nur mit `--profile caddy`
  (`docker-compose.yml:224`). Die zweite Variante `deploy/nginx/test.jibbit.ch.conf`
  setzt **gar keine** Security-Header (kein `add_header`, keine CSP). Je nach
  Proxy gilt also: hinter Caddy dürfte der Browser keine PostHog-Events senden
  (nicht getestet), und die feste Produktions-API-Domain passt nicht zu
  `api-test.jibbit.ch`; hinter nginx fehlen CSP, HSTS und Co. ganz. Ein still
  blockiertes Analytics sieht aus wie „kein Traffic“. Ob der Browser die API
  überhaupt direkt anspricht (Server Actions), ist unklar.
- *Vorschlag:* CSP aus Env bauen, PostHog-Hosts aufnehmen oder über einen
  eigenen Pfad proxyen (der lokale Altstand hatte dafür eine `/jb7q`-Rewrite-Idee).
- *Aufwand:* S

**15. Odoo-Weiterleitungen fehlen**
- *Ort:* `data/odoo-redirects.json` (Backend-Repo), im Frontend nirgends
  verwendet.
- *Warum ein Problem:* Beim DNS-Umzug laufen alle 33 alten `/shop/…`-URLs
  (Google, Links) auf 404.
- *Vorschlag:* Vor dem Go-live einbauen (z. B. `redirects()` in
  `next.config.ts` oder `proxy.ts`).
- *Aufwand:* S

**16. Kein noindex für Staging**
- *Ort:* Frontend `app/robots.ts:8`; ungemergter Zweig `feat/staging-noindex`.
- *Warum ein Problem:* test.jibbit.ch kann parallel zum Odoo-Shop indexiert
  werden (Duplicate Content).
- *Vorschlag:* Zweig prüfen und mergen.
- *Aufwand:* S

**17. Event-Bus und Workflow-Engine in-memory**
- *Ort:* `backend/medusa-config.ts:109` (Redis nur als Session-Store).
- *Warum ein Problem:* Events (Passwort-Mail, Thumbnail) gehen bei einem
  Neustart zwischen Auslösen und Verarbeiten verloren. Redis läuft ohnehin im
  Compose.
- *Vorschlag:* Redis-Event-Bus/-Workflow-Engine prüfen. Das ist
  Stock-Starter-Verhalten, also kein Fehler von uns, für Produktion aber
  empfohlen.
- *Aufwand:* M

**18. Keine Bestell- und Versand-E-Mails**
- *Ort:* nur `customer-password-reset.ts` verschickt etwas; Zweig
  `feat/order-notifications` ungemergt; Frontend verspricht eine
  WhatsApp-Nachricht (`app/checkout/bestellung/[id]/page.tsx:63-70`).
- *Warum ein Problem:* Die Bestätigungsseite verspricht wörtlich „Eine
  Bestätigung geht an {E-Mail}“ und, ohne Telefonnummer, eine Versandmeldung
  per E-Mail (`page.tsx:61-70`). Keins von beidem wird verschickt.
- *Vorschlag:* Entscheiden, ob Mail, WhatsApp oder beides, und den Zweig
  prüfen.
- *Aufwand:* M

**19. Adressprüfung lückenhaft**
- *Ort:* `backend/src/api/middlewares.ts:7-30, 92-101`.
- *Warum ein Problem:* Die Prüfung greift nur beim Anlegen, nicht beim
  Ändern und nicht an Warenkorb-Adressen. Vermutlich ein Überbleibsel aus dem
  Projekt-Setup.
- *Vorschlag:* Entfernen oder vollständig machen (die Storefront prüft
  ohnehin selbst, `lib/checkout/address.ts`).
- *Aufwand:* S

**20. Liefergebiet widersprüchlich**
- *Ort:* Frontend `lib/checkout/address.ts:24-25`,
  `components/account/AddressBook.tsx:22-23`, `lib/auth/actions.ts:414-419`
  (CH+LI) vs. `lib/seo/jsonld.ts:284,360` und AGB `app/agb/page.tsx:85` („Wir
  liefern an Adressen in der Schweiz“); Backend-Region hat nur `ch`
  (`seed.ts:145`).
- *Warum ein Problem:* LI-Adressen sind im Formular erlaubt, aber die Region
  kennt LI nicht. Der Checkout könnte scheitern (nicht getestet).
- *Vorschlag:* Klären, ob LI beliefert wird; Länder aus der Region lesen.
- *Aufwand:* S

**21. Bestellbestätigung ohne Login zeigt Personendaten**
- *Ort:* Frontend `app/checkout/bestellung/[id]/page.tsx:60-71`,
  `lib/checkout/order.ts:4-8`.
- *Warum ein Problem:* Wer den Link hat (geteilt, in Logs oder
  Analytics-URLs), sieht E-Mail, Adresse und Telefon.
- *Vorschlag:* Bei Kontopflicht Login verlangen oder die Anzeige kürzen.
- *Aufwand:* S

**22. SDK-Version im Frontend ≠ Backend**
- *Ort:* Frontend `package.json:16-17` (`js-sdk`/`types` 2.18.0 als
  Tarball-URL) vs. Backend 2.13.6.
- *Warum ein Problem:* Typen und Endpunkte können abweichen; Updates nur von
  Hand.
- *Vorschlag:* Normale Versionsangabe, passend zum Backend.
- *Aufwand:* S

### Redundanz und toter Code

**23. Tote Abhängigkeiten und toter Code**
- *Backend:* `axios` und `ioredis` (`backend/package.json:31-32`, nirgends
  importiert); Beispielrouten `src/api/admin/custom/route.ts`,
  `src/api/store/custom/route.ts`; `import-price-tiers.ts` (für den Datenstand
  ungenutzt, nur noch Re-Export von `roundTo`, den `import-catalog.ts:58` und
  `update-catalog.ts:75` von dort statt aus `pricing-helpers.ts` holen);
  `scripts/parse-price-rules.mjs` (überholt); leeres `src/admin/i18n/index.ts`.
- *Frontend:* Reste des localStorage-Warenkorbs (`lib/pricing.ts:103-111`,
  `lib/types.ts:92-109`, `components/CartProvider.tsx:80`,
  `components/AddToCart.tsx:178-191`); ungenutzte Exporte
  (`app/actions/checkout.ts:53` `completeCartAction`, `lib/data.ts:297-303`
  `getFeaturedProducts`, `lib/variant-image.ts:34,62-63`, Tag `featured`).
- *Vorschlag:* Entfernen.
- *Aufwand:* S

**24. Doppelte Felder und Typen für dieselbe Sache**
- *Ort:* Katalogfelder `gtin` **und** `ean` für `variant.ean`
  (`data/README.md:86-91`); Kundenmarker `source` vs. `imported_from`,
  Odoo-ID als Zahl vs. String (`lib/odoo-login-claim.ts:387-409`); Typ
  `CatalogProduct` zweimal (`import-catalog.ts:92`, `price-list-mapping.ts:55`);
  Typ `OrderView` zweimal im Frontend.
- *Warum ein Problem:* Jede Doppelung muss beim Lesen beidseitig bedient
  werden. Der Code tut das auch, aber es sind Fallen.
- *Vorschlag:* Je eine Form festlegen.
- *Aufwand:* S

**25. Vorschaubild doppelt abgesichert**
- *Ort:* `backend/src/subscribers/product-thumbnail.ts` plus stündlicher Job
  `backend/src/jobs/product-thumbnail-backfill.ts`.
- *Warum ein Problem:* Ein stündlicher Vollscan als Auffangnetz für den
  Subscriber ist überdimensioniert. Kein Schaden, aber Last und Rauschen.
- *Vorschlag:* Job einmalig laufen lassen und entfernen oder auf täglich
  stellen. Niedrige Priorität.
- *Aufwand:* S

**26. Scripts finden Varianten nur über generierte SKUs; Kategorie wird aus dem Namen geraten**
- *Ort:* `import-catalog.ts:188-229` (`skuFor`), `update-catalog.ts:356-366`,
  `import-price-lists.ts:71`; `categoryFor` in `import-catalog.ts:147-168`.
- *Warum ein Problem:* Ändert jemand im Admin eine SKU (was der Kommentar
  ausdrücklich erlaubt), sind die Scripts für diese Variante blind. Neue
  Produktnamen landen per Regex in der falschen Kategorie.
- *Vorschlag:* Hinfällig, wenn die Scripts nur noch Migration sind (Punkt 3).
- *Aufwand:* S

### SaaS und Architektur

**27. Mandanten-Unterbau im Frontend gebaut, aber nicht in Betrieb; Inhalte jibbit-spezifisch**
- *Ort:* Frontend `lib/tenant/config-cache.ts`, `control-plane-client.ts`,
  `header-codec.ts`, `lib/analytics/server.ts:18-24`; Backend: kein
  Mandanten-Code; Architektur nur untracked (Punkt 1).
- *Warum ein Problem:* Control Plane und Cache sind getestet, laufen aber
  nicht. Gleichzeitig sind Versandtarif, Rechtstexte, Marken, Mock-Katalog und
  PostHog-Key jibbit-spezifisch. Im Silo-Modell (eigener Container je Mandant)
  könnte man auch je Mandant eine Storefront betreiben, dann ist die
  Host-Auflösung überflüssig.
- *Vorschlag:* Entscheid: gemeinsame Storefront für alle Mandanten (dann
  Punkte 7/8/9 lösen) oder eine Storefront je Mandant (dann Tenant-Schicht
  vereinfachen).
- *Aufwand:* M–L

**28. Galaxus-Anbindung halbfertig**
- *Ort:* `backend/src/scripts/galaxus-*.ts`, `docs/galaxus-marktplatz.md`.
- *Warum ein Problem:* CSV-Export ohne Upload und ohne Händleraufnahme;
  Pflege über `catalog.json`. Laut Memory ist Galaxus zudem günstiger im
  Endpreis.
- *Vorschlag:* Parken oder fertig machen, bewusst entscheiden.
- *Aufwand:* S (Entscheid)

### Kleinkram

**29. Intro läuft einmal pro Browser-Sitzung, nicht einmal überhaupt**
- *Ort:* Frontend `lib/intro/timings.ts:50-51`.
- *Frage:* Wiederkehrende Kundschaft sieht ≈4.4 s Animation (überspringbar).
  Gewollt?
- *Aufwand:* S

**30. Veraltete Doku und kleine Inkonsistenzen**
- *Ort:* Frontend `README.md:226-270` (nennt „CHF 9 flat, gratis ab 100“,
  „guest-only“, `[[PLATZHALTER]]`); `CheckoutFlow.tsx:3-8` (3 Schritte);
  `PriceTable.tsx:19-21` (Verweis auf nicht existierenden Text);
  Header-Zahlarten vs. `lib/config.ts:35-39`; `lib/data.ts:199` (`limit: 100`,
  ohne Seitenumbruch); `docs/product-pricing-model.md` als „Entwurf“.
- *Aufwand:* S

**31. JSON-LD `sku` = Varianten-ID**
- *Ort:* Frontend `lib/seo/jsonld.ts:680`.
- *Warum ein Problem:* Passt nicht zu einem späteren Merchant-Feed.
- *Vorschlag:* Echte SKU verwenden.
- *Aufwand:* S

**32. Admin-Favicon per Nachbearbeitung des Builds**
- *Ort:* `backend/scripts/admin-favicon.mjs`, `backend/package.json:16`.
- *Warum ein Problem:* Kosmetik, die bei einem Medusa-Upgrade den Build
  absichtlich brechen lässt.
- *Vorschlag:* Behalten und beim Upgrade wissen, oder entfernen.
- *Aufwand:* S

---

## 5. Deep-Dive: Produkt, Variante, Preis, Bestand

Hier nur die Problembeschreibung, die Lösung entwirft ein anderer Agent.
**Zielmodell laut Joris (Stand heute):** ein Produkt = eine Variante = ein
Inventory-Item. Gebinde (1/10/12/24/50) werden zu Mengenstaffeln („ab X Stück
→ Stückpreis“) auf dieser einen Variante. Keine Gebinde-Varianten, keine
Inventory-Kits. Andere Designs/Farben sind eigene Produkte. Die Spalte
„obsolet im Zielmodell“ unten bezieht sich darauf.

### 5.1 Wie ein Produkt heute entsteht

Es gibt **drei** Quellen, die Produkte anlegen, und **vier**, die Preise
schreiben:

```
seed.ts ─────────────► 13 Demo-Produkte, Option "Variante",
                        Varianten "1 Heftchen"/"5er Pack"/"50 Stück"…,
                        manage_inventory=true (Default) → je Variante ein
                        Inventory-Item mit Titel = Variantentitel, 1000 Stück

catalog.json ─► import-catalog.ts ─► Produkt + Option "Verpackungseinheit"
                                     + je Gebinde eine Variante
                                     ("Einzeln", "Display (34 Stk.)", "Box (24 Stk.)")
                                     + Staffeln als BASISPREISE (min/max_quantity)
                                     + variant.metadata {units_per_pack, pack_type}
                                     + manage_inventory=false (ohne stock=)

catalog.json ─► update-catalog.ts ─► Basispreise erneut = Staffeln
inventory.json ─┘                     + Inventory-Item je SKU (NUR sku, kein Titel)
                                      + manage_inventory=true + Level

price-lists.json ─► import-price-lists.ts ─► Basispreis = EIN regulärer Preis
catalog.json ─────┘                          Preisliste "Aktionspreise" = Staffeln

tiers.json ─► import-price-tiers.ts ─► Basispreise = Staffeln (aktuell ungenutzt)

Admin (Joris) ─► Preis-Editor ─► ersetzt ALLE Basispreise durch einen Preis
                                  (Staffeln weg, laut docs/product-pricing-model.md §3)
```

### 5.2 Die Ursachen, einzeln

| # | Symptom im Admin | Ursache im Code | Ort | Obsolet im Zielmodell? |
|---|---|---|---|---|
| 1 | Pro Gebinde eine eigene Variante; Option „Verpackungseinheit“ muss gewählt/gepflegt werden | Import modelliert Einzeln/Display/Box bewusst als Varianten („Entscheidung: A“) | `import-catalog.ts:62, 374-397`; `docs/product-pricing-model.md:19-35`; Datenformat `data/catalog.json` (`variants[].label/pack_type/units_per_pack`) | ja: Option, Gebinde-Varianten, `pack_type`, `units_per_pack`, `skuFor`-Suffixe `-D34/-BX24` |
| 2 | Preise mehrfach eingeben | (a) Jede Gebinde-Variante hat ein eigenes Price Set, der Displaypreis ist unabhängig vom Einzelpreis. (b) Staffeln stehen je Variante als mehrere Preiszeilen. (c) Zusätzlich existiert die Preisliste „Aktionspreise“ mit **denselben** Staffeln, der Basispreis ist dann der „reguläre“ Preis. (d) `update-catalog.ts` schreibt die Staffeln wieder in den Basispreis zurück. Je nach Script-Reihenfolge liegen die Staffeln also an einer von zwei Stellen oder an beiden. | `import-catalog.ts:388-393`; `update-catalog.ts:405-434, 722-733`; `import-price-lists.ts:1-53`; `docs/preislisten.md:20-28` | teils: Staffeln bleiben (jetzt „ab X Stück“), aber nur **eine** Quelle; Gebinde-Price-Sets fallen weg |
| 3 | Preis im Admin speichern zerstört Staffeln | Der Admin-Preis-Editor kennt nur einen Preis je Währung und ersetzt das Price Set komplett (so dokumentiert, nicht selbst nachgeprüft) | `docs/product-pricing-model.md:117-141`; `docs/preislisten.md:104-106` | **nein, bleibt das Kernproblem**: Auch im Zielmodell leben Staffeln als `min_quantity`-Zeilen; ohne eigene Admin-Maske sind sie weiter nicht pflegbar |
| 4 | Bestand je Variante statt je Produkt | `manage_inventory` je Variante; `update-catalog.ts` legt je SKU ein eigenes Inventory-Item an; Seed ebenso über Medusa-Default | `update-catalog.ts:448-478, 760-782`; `seed.ts:668-681`; Medusa `core-flows/dist/product/workflows/create-product-variants.js` (`buildVariantItemCreateMap`: ein Item je Variante, `title: variantInput.title`) | ja: ein Item je Produkt |
| 5 | Inventory-Kit-Dropdown zeigt „1 Heftchen“, „50 Stück“… ohne Produktnamen | Medusa beschriftet das Dropdown mit `inventoryItem.title ?? inventoryItem.sku` (`@medusajs/dashboard` 2.13.6) und erzeugt den Item-Titel aus dem **Variantentitel**, nicht aus dem Produkt. Diese Titel stammen von den **Seed-Demo-Produkten** (`seed.ts:488-599`). Auf test.jibbit.ch stehen laut `docs/product-inventory.md:123-132` noch vier Demo-Reste, zwei davon mit Handles, die `remove-seed-demo.ts` gar nicht kennt. Items aus `update-catalog.ts` haben **keinen Titel** und erscheinen nur als SKU (`BLA-LEA-…-EA`). Das Dropdown listet alle Items der ganzen DB, weil Kits produktübergreifend sein dürfen (Stock-Verhalten). | `seed.ts:479-636`; `remove-seed-demo.ts:42-56`; `update-catalog.ts:762-766` | ja: Kits werden nicht genutzt; die Demo-Items müssen aber trotzdem weg |
| 6 | Grundpreis „CHF x / Stk.“ hängt an unsichtbaren Feldern | `variant.metadata.units_per_pack/pack_type`, nur im rohen Metadaten-Editor sichtbar | `import-catalog.ts:381-387`; Frontend liest es (siehe §2) | ja |
| 7 | Meldebestand je Variante | Nachschub schreibt `variant.metadata.reorder_point` je Gebinde-Variante | `src/lib/nachschub.ts:44-47`; Widget | ja (und wird ohnehin abgeschaltet, `_wt-medusa-noreorder`) |
| 8 | SKUs „künstlich“ | `skuFor()` erzeugt SKUs aus Wortkürzeln + Gebindesuffix; die Scripts finden Varianten **nur** über diese SKU wieder. Wer die SKU im Admin ändert (was der Kommentar ausdrücklich erlaubt, `import-catalog.ts:201-202`), macht `update-catalog.ts` und `import-price-lists.ts` für diese Variante blind. | `import-catalog.ts:188-229`; `update-catalog.ts:356-366`; `import-price-lists.ts:71` | teils: Suffixe fallen weg; die SKU-Kopplung der Scripts bleibt ein Problem, solange es die Scripts gibt |
| 9 | Kategorie falsch/unerwartet | `categoryFor()` rät die Kategorie per Regex aus dem Produktnamen | `import-catalog.ts:147-168` | nein (unabhängig vom Gebinde) |

### 5.3 Konkrete Zahlen (laut Repo-Daten, nicht aus der DB gelesen)

- `data/catalog.json` + `catalog-extra.json`: 28 Produkte, 35 Varianten, davon
  7 Display/Box-Varianten (`docs/product-inventory.md:9-16`). Im Zielmodell
  wären es 28 Produkte mit je einer Variante.
- Odoo selbst ist uneinheitlich: 5 Gebinde als eigene Produkte, 2 als
  Attribut-Varianten (`docs/product-inventory.md:166`). Die Medusa-Struktur
  wurde daraus vereinheitlicht, nicht übernommen.
- Die DB von test.jibbit.ch wurde für dieses Audit **nicht** abgefragt. Wie
  viele verwaiste oder Demo-Inventory-Items dort wirklich stehen, ist unklar.
  Das untracked Script `backend/src/scripts/check-stock.ts` (nur im lokalen
  Checkout) listet genau das auf.

### 5.4 Code, der im Zielmodell wegfällt oder umgebaut werden muss

| Teil | Ort | Was damit passiert |
|---|---|---|
| Option „Verpackungseinheit“, Gebinde-Varianten, `skuFor`-Suffixe | `import-catalog.ts` | umbauen |
| `pack_type`/`units_per_pack` in `catalog.json` und `variant.metadata` | `data/catalog.json`, `import-catalog.ts:381-387` | entfällt |
| Gebinde-Parser im Preislisten-Mapping („Display: 25x …“ → Variante) | `price-list-mapping.ts:9-23` | entfällt/umbauen |
| Doppelte Preisquelle Basispreis vs. Preisliste „Aktionspreise“ | `import-price-lists.ts`, `update-catalog.ts` | entscheiden, welche bleibt (Punkt 2) |
| `/store/price-tiers` inkl. Preislisten-Sperre | `api/store/price-tiers/*` | bleibt nötig, solange Staffeln angezeigt werden; wird mit nur einer Preisquelle einfacher |
| Nachschub (Meldebestand je Variante) | `src/lib/nachschub.ts`, Widget, Seite, Report, Middleware | wird abgeschaltet (in-flight) |
| Seed-Demo-Produkte, `remove-seed-demo.ts` | `seed.ts:424-740`, `remove-seed-demo.ts` | entfernen (Punkte 4/5) |
| Frontend: Varianten-Auswahl, Varianten-Bild, Grundpreis aus Metadaten | siehe §2 | umbauen (in-flight `_wt-frontend-packsizes`) |
