# SEO-Check «Was bekommt Googlebot?» — jibbit.ch (Odoo) + test.jibbit.ch (Staging)

Stand: 2026-09-20, ca. 14:40–15:00 MESZ. Reiner Lesezugriff von aussen (curl via Git Bash, sequenziell mit Pausen, keine Logins, keine Formulare, keine Schreibzugriffe). Kein Zugriff auf die Google Search Console (GSC) — was nur die GSC beantworten kann, steht in [Abschnitt 9](#9-was-nur-die-search-console-beantworten-kann).

Verwendete User-Agents:

```bash
GB='Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
CH='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
```

Einschränkung: Ein gefälschter Googlebot-UA ist nicht dasselbe wie der echte Googlebot (echte IPs, Rendering-Service). Alles hier ist «was der Server einem Client mit diesem UA schickt». Die Bestätigung liefert nur die GSC.

---

## 0. Kurzfassung

**Was Googlebot bekommt:** Deutsch (`de_CH`) auf der präfixlosen URL, `200 OK`, ohne Redirect — für `/`, `/shop` und alle geprüften Produkte. `<html lang="de-CH">`, Canonical zeigt auf sich selbst (`https://jibbit.ch/...`), nicht auf `/en`. Deutsch ist die Default-Sprache der Odoo-Website und lebt auf `/` (nicht auf `/de_CH/…`; `/de_CH/…` leitet per 303 auf die präfixlose URL).

**Warum der frühere Check `/en` sah:** Odoo leitet jeden Nicht-Bot-Client ohne passendes `Accept-Language` per **303** auf `/en/…`, weil Odoo bei fehlendem Header hart `en_US` als Sitzungssprache annimmt und Englisch als Website-Sprache installiert ist. Clients, deren UA `bot`, `crawl`, `spider`, `curl` usw. enthält, nimmt Odoo davon aus und liefert die Default-Sprache. Googlebot ist also **nicht** betroffen — aber **`Google-InspectionTool`** (der UA des GSC-Live-Tests), Lighthouse/PageSpeed und jeder Browser ohne de/fr/it sind es.

| # | Befund | Schweregrad |
|---|---|---|
| F1 | Odoo kennt das HTTPS-Schema nicht (Proxy-Konfiguration): `http://` in robots.txt + allen 39 Sitemap-URLs **und deshalb gar keine hreflang-Tags** | **hoch** |
| F2 | `noindex` auf einzelnen Seiten ohne erkennbares Muster — darunter 2 deutsche Produktseiten, die in der Sitemap stehen | **hoch** |
| F3 | Staging `test.jibbit.ch` ist voll indexierbar (robots.txt `Allow: /`, `index, follow`, eigene Sitemap, kein Auth, kein Canonical) | **hoch** |
| F4 | EN/FR/IT-Versionen: halb übersetzt, eigene Canonicals, Junk-Slugs (`/en/shop/coming-soon-11`, `…-kopie-47`); `/en`-URLs tauchen in der öffentlichen Suche auf | **mittel** |
| F5 | `www.jibbit.ch` antwortet mit 200 statt auf `jibbit.ch` weiterzuleiten (Canonical fängt es ab) | mittel |
| F6 | Startseite: Title «Home \| Jibbit.ch», Meta-Description «This is the homepage of the website» (englischer Odoo-Platzhalter); 14 von 33 Produkten ohne Meta-Description; `/shop` ohne | mittel |
| F7 | 303-Redirect nach `/en` für GSC-Live-Test, PageSpeed und Browser ohne de/fr/it | mittel |
| F8 | Sitemap enthält `/website/info`; `/web/login`, `/shop/cart`, `?order=`/`?search=` sind crawlbar; robots.txt hat keine Disallows | niedrig |
| F9 | Kein HTTP/2, kein HSTS, keine `Secure`-Flag auf Cookies, nginx 1.18.0 sichtbar | niedrig |
| F10 | Altersabfrage: reines JS-Overlay, Inhalt steht im HTML — kein Indexierungsproblem; GSC-Screenshot wird das Overlay zeigen | niedrig |
| F11 | Strukturierte Daten: nur dünnes Microdata (Product/Offer), kein JSON-LD | niedrig (bekannt) |

---

## 1. Redirects, Sprache, URL-Varianten

### 1.1 Root `/`

```bash
curl -sIL -A "$GB" https://jibbit.ch/ | grep -iE '^(HTTP|location|vary|content-language|set-cookie: frontend|x-robots)'
```

| Variante | Ergebnis |
|---|---|
| (a) Googlebot Smartphone, **kein** Accept-Language | `200 OK`, `Set-Cookie: frontend_lang=de_CH` — kein Redirect |
| (a') Googlebot Desktop, Googlebot-Image, Storebot-Google, AdsBot-Google, bingbot, facebookexternalhit, WhatsApp, curl-Default | alle `200`, `de_CH` |
| (b) Googlebot + `Accept-Language: de-CH` | `200`, `de_CH` |
| (c) Chrome + `de-CH,de;q=0.9` | `200`, `de_CH` |
| Chrome **ohne** Accept-Language | `303 SEE OTHER → /en/` → `301 → /en` → `200` (`frontend_lang=en_US`) |
| Chrome + `en-US` | gleiche Kette nach `/en` |
| Chrome + `fr-CH` | `303 → /fr_CH/` → `301 → /fr_CH` → `200` |
| **Google-InspectionTool** (mobil + desktop), kein Accept-Language | `303 → /en/` → `301 → /en` → `200` (en_US) |
| Chrome-Lighthouse (PageSpeed Insights) | `303 → /en/` → `301 → /en` → `200` |

Auf keiner Antwort vorhanden: `Vary`, `Content-Language`, `X-Robots-Tag`, `Cache-Control` (HTML), `Strict-Transport-Security`.

### 1.2 `/shop` + 3 Produkte

Geprüft: `/shop`, `/shop/raw-black-kss-papers-2`, `/shop/purize-aktivkohlefilter-9mm-60`, `/shop/ocb-bio-slim-organic-hemp-rolls-40`.

- (a) Googlebot ohne AL, (b) Googlebot + de-CH, (c) Chrome + de-CH: überall `200 OK`, `frontend_lang=de_CH`, keine Redirects.
- Chrome ohne AL: `303 → /en/shop/…`. Beim OCB-Produkt zusätzlich ein zweiter Hop, weil der englische Slug anders lautet:

```
HTTP/1.1 303 SEE OTHER   Location: /en/shop/ocb-bio-slim-organic-hemp-rolls-40
HTTP/1.1 301 MOVED PERMANENTLY   Location: /en/shop/ocb-bio-slim-organic-hemp-rolls-24-40
HTTP/1.1 200 OK
```

### 1.3 `http://`, `www.`, Sprachpräfixe (als Googlebot)

| URL | Kette |
|---|---|
| `http://jibbit.ch/` | `301 → https://jibbit.ch/` → `200` (nginx) |
| `http://jibbit.ch/shop/raw-black-kss-papers-2` | `301 → https://…` → `200` |
| `http://www.jibbit.ch/` | `301 → https://www.jibbit.ch/` → **`200`** (kein Redirect auf Apex) |
| `https://www.jibbit.ch/` und `…/shop/raw-black-kss-papers-2` | **`200`**; Canonical im HTML zeigt auf `https://jibbit.ch/…` |
| `https://jibbit.ch/de_CH/`, `/de_CH/shop` | `303 → /` bzw. `/shop` → `200` |
| `https://jibbit.ch/de/` | `301 → /de_CH/` → `303 → /` → `200` |
| `https://jibbit.ch/en` | `200` (en_US); `/en/` → `301 → /en` |
| `https://jibbit.ch/fr_CH` | `200`; `/fr` → `301 → /fr_CH/` → `301 → /fr_CH` |
| `https://jibbit.ch/it` | `200` (Sprache ist `it_IT`, URL-Code `it`); `/it_IT` und `/it_CH` → `301 → /it/` → `301 → /it` |

Installierte Website-Sprachen laut Verhalten: `de_CH` (Default, ohne Präfix), `en_US` (`/en`), `fr_CH` (`/fr_CH`), `it_IT` (`/it`).

### 1.4 Ursache des `/en`-Redirects (im Odoo-Quellcode verifiziert, Branch 17.0)

- `odoo/http.py`: `default_lang()` gibt `self.best_lang or DEFAULT_LANG` zurück, `DEFAULT_LANG = 'en_US'`. Ohne `Accept-Language` ist die Kontextsprache also `en_US`.
- `addons/http_routing/models/ir_http.py` (`_match`): `request.lang = nearest_url_lang or cookie_lang or context_lang or default_lang`. Da `en_US` eine aktive Website-Sprache ist, gewinnt `context_lang = en_US` vor der Default-Sprache → Zweig «missing lang in url, redirect» → `request.redirect_query(...)` = **303**.
- Davor steht der Bot-Zweig: `elif not url_lang_str and request.env['ir.http'].is_a_bot(): request.lang = default_lang`. Bot-Liste (`addons/web/models/ir_http.py`): `bot, crawl, slurp, spider, curl, wget, facebookexternalhit, whatsapp, trendsmapresolver, pinterest, instagram, google-pagerenderer, preview`. `Google-InspectionTool` und `Chrome-Lighthouse` stehen nicht drin.
- Indiz in der Seite: `odoo.__session_info__` enthält `"lang": "en_US"` selbst auf der deutschen Seite.

Das ist Odoo-Standardverhalten und keine Einstellung. Die genaue Odoo-Version ist von aussen nicht sicher bestimmbar (Asset-URLs `/web/assets/1/<hash>/…` und fehlendes Pager-`noindex` auf `/shop/page/2` sprechen für 17 oder 18; der zitierte Code ist in 17.0 und 18.0 gleich aufgebaut).

---

## 2. Head-Tags auf den gelandeten Seiten

```bash
grep -oiE '<html[^>]*>|<title>[^<]*</title>|<meta[^>]*name="(description|robots)"[^>]*>|<link[^>]*rel="(canonical|alternate)"[^>]*>' seite.html
```

| Seite (als Googlebot) | `html lang` | Canonical | hreflang | meta robots | Title / Description |
|---|---|---|---|---|---|
| `/` | `de-CH` | `https://jibbit.ch/` (self) | **keine** | – | «Home \| Jibbit.ch» / «This is the homepage of the website» |
| `/shop` | `de-CH` | `https://jibbit.ch/shop` (self) | **keine** | – | «Shop \| Jibbit.ch» / keine Description |
| `/shop/raw-black-kss-papers-2` | `de-CH` | self | **keine** | – | «RAW Black KSS Papers \| Jibbit.ch» / «King Size Slim Papers Extra fein» |
| `/shop/ocb-bio-slim-organic-hemp-rolls-40` | `de-CH` | self | **keine** | – | Title ok / keine Description |
| `/en` | `en-US` | `https://jibbit.ch/en` (self) | **keine** | – | «Home \| Jibbit.ch» / gleicher Platzhalter |
| `/en/shop/raw-black-kss-papers-2` | `en-US` | self (`/en/…`) | **keine** | **`noindex`** | Description «…Extra Fine» |
| `/fr_CH/shop/raw-black-kss-papers-2` | `fr-CH` | self | **keine** | **`noindex`** | Description englisch |
| `/it/shop/raw-black-kss-papers-2` | `it-IT` | self | **keine** | **`noindex`** | Description englisch |
| `https://www.jibbit.ch/shop/raw-black-kss-papers-2` | `de-CH` | `https://jibbit.ch/…` (Apex) | keine | – | wie DE |

- Canonical der deutschen Seiten zeigt auf sich selbst, **nicht** auf `/en`. Gut.
- `grep -ci hreflang` = 0 auf allen geprüften Seiten, in allen Sprachen. Kein `x-default`. → F1.
- Kein `X-Robots-Tag`-Header irgendwo.
- `og:type` ist auf Produktseiten `website` statt `product` (Kosmetik).

---

## 3. Befunde im Detail

### F1 — Odoo sieht `http://` statt `https://`: falsche Sitemap/robots.txt **und fehlende hreflang-Tags** — HOCH

**Evidenz**

```
$ curl -s https://jibbit.ch/robots.txt
User-agent: *
Sitemap: http://jibbit.ch/sitemap.xml

##############
#   custom   #
##############
```

```
$ curl -s https://jibbit.ch/sitemap.xml | head
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://jibbit.ch/contactus</loc><lastmod>2026-02-18</lastmod></url>
    <url><loc>http://jibbit.ch/impressum</loc><lastmod>2026-08-21</lastmod></url>
    <url><loc>http://jibbit.ch/terms</loc></url>
    <url><loc>http://jibbit.ch/shop/angel-slim-filters-6mm-120stk-13</loc></url>
    …
```

Alle 39 `<loc>` beginnen mit `http://`. Alle 39 geprüft: `200` nach genau 1 Hop (`http → https`), keine 404.

**Ursache (im Odoo-Quellcode verifiziert, nicht `web.base.url`)**

- `addons/website/controllers/main.py`: robots.txt und Sitemap werden mit `request.httprequest.url_root` gebaut, nicht mit `web.base.url`. `url_root` ist `http://…`, wenn Odoo hinter nginx läuft und das Original-Schema nicht kennt.
- `addons/website/models/website.py`: `_get_alternate_languages()` gibt `[]` zurück, wenn `_is_canonical_url()` falsch ist. `_is_canonical_url()` vergleicht `request.httprequest.url_root + REQUEST_URI` (= `http://jibbit.ch/…`) mit der kanonischen URL aus der Website-Domain (= `https://jibbit.ch/…`). Ungleich → **keine hreflang-Tags auf keiner Seite**. Der Canonical selbst ist korrekt `https://`, weil er aus der Website-Domain kommt.

Ein Konfigurationsfehler erklärt also beide Symptome. Odoo-Doku (Deploy → HTTPS): `proxy_mode = True` in der Odoo-Konfiguration plus im nginx `proxy_set_header X-Forwarded-Host $http_host; X-Forwarded-For …; X-Forwarded-Proto $scheme; X-Real-IP …`.

**Fix (Server, nicht Odoo-Backend)**

1. `/etc/odoo/odoo.conf` (Pfad je nach Installation): `proxy_mode = True`.
2. nginx-Serverblock für jibbit.ch, im `location /`: `proxy_set_header X-Forwarded-Host $http_host;`, `proxy_set_header X-Forwarded-Proto $scheme;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_set_header X-Real-IP $remote_addr;`. Welche davon fehlen, ist von aussen nicht sichtbar — beide Stellen prüfen.
3. Odoo neu starten, nginx reload.
4. Sitemap-Cache leeren: Odoo cached die Sitemap 12 h als Attachment (Doku: «cached and updated every 12 hours»). Entwicklermodus → Einstellungen → Technisch → Anhänge → nach `sitemap` suchen → löschen (Hinweis aus dem Odoo-Forum, Menüpfad nicht selbst verifiziert). Sonst 12 h warten.
5. Kontrolle:
   ```bash
   curl -s https://jibbit.ch/robots.txt | grep -i sitemap          # erwartet https://
   curl -s https://jibbit.ch/sitemap.xml | grep -c '<loc>https://'  # erwartet 39
   curl -s -A "$GB" https://jibbit.ch/shop | grep -i hreflang       # erwartet de, fr, it, en, x-default
   ```
   Laut Quellcode erzeugt Odoo dann `hreflang="de"`, `"fr"`, `"it"`, `"en"` (Kurzcodes, weil je Sprache nur eine Region installiert ist) plus `x-default` → Default-Sprache (Deutsch). Das ist für die Schweiz in Ordnung; `de-CH`/`fr-CH` sind nicht nötig, und `it-IT`/`en-US` als Regionscodes wären sogar falsch.
6. GSC → Sitemaps: `https://jibbit.ch/sitemap.xml` neu einreichen.

Die Systemparameter-Einstellung `web.base.url` (Einstellungen → Technisch → Systemparameter) sollte trotzdem `https://jibbit.ch` sein und `web.base.url.freeze = True` gesetzt haben (betrifft Mails/Portal-Links) — sie behebt dieses Problem aber **nicht**.

### F2 — `noindex` auf einzelnen Seiten ohne erkennbares Muster — HOCH

**Evidenz** (stabil über 6 Wiederholungen, unabhängig vom UA, auch mit `?x=173`):

| URL | `<meta name="robots" content="noindex"/>` |
|---|---|
| `/shop/box-50x-elements-king-slim-size-ultra-thin-57` (**Deutsch, in Sitemap**) | ja |
| `/shop/greengo-unbleached-slim-rolls-24` (**Deutsch, in Sitemap**) | ja |
| übrige 31 deutsche Produkte, `/`, `/shop`, `/contactus`, `/terms`, `/impressum` | nein |
| `/en/shop/…`: raw-black-kss-papers-2, 7-ocb-premium-rolls-slim-3, box-50x-…-57, greengo-…-24, ocb-slim-filter-bio-10x120-tips-41, raw-kristallglas-aschenbecher-ruby-51 | ja (6 von 33) |
| `/fr_CH` (Startseite), `/fr_CH/contactus`, `/fr_CH/shop/raw-black-kss-papers-2`, `/it/shop/raw-black-kss-papers-2` | ja |
| `/en`, `/it`, `/it/contactus`, `/fr_CH/shop/7-ocb-premium-rolls-slim-3`, `/it/shop/7-ocb-…-3`, `/en/terms` | nein |

Gleiche Produkt-ID, je nach Sprache verschieden → das ist keine bewusste Pro-Produkt-Einstellung.

**Einordnung (Ursache von aussen NICHT bestimmbar — unverifiziert):** Das Standard-Template `website.layout` (17.0/18.0 geprüft) setzt `noindex` nur, wenn (a) `main_object.website_indexed` falsch ist — das Feld gibt es auf Seiten, nicht auf Produkten — oder (b) `website.domain` gesetzt ist und der Host der Anfrage nicht zur Domain passt (`_is_indexable_url(url_root)`). Beides kann nicht pro Sprache variieren. Hypothesen: (1) zwischengespeicherte `<head>`-Fragmente (Odoo cached den `<head>` per `t-cache` für `website.page`-Datensätze), die entstanden, als eine Anfrage über einen fremden Hostnamen/die IP hereinkam oder die Website-Domain noch anders gesetzt war — passt zu F1 (Host/Proxy-Header); erklärt die Produktseiten aber nicht mit Standardcode. (2) Eine Anpassung am Layout oder ein Zusatzmodul (die Altersabfrage zeigt, dass das Layout bereits von Hand erweitert wurde).

**Fix / Vorgehen**

1. Zuerst F1 beheben und Odoo neu starten (leert die In-Memory-Caches). Danach erneut prüfen:
   ```bash
   for u in /shop/greengo-unbleached-slim-rolls-24 /shop/box-50x-elements-king-slim-size-ultra-thin-57 /fr_CH /en/shop/raw-black-kss-papers-2; do
     echo "$u $(curl -s --compressed -A "$GB" https://jibbit.ch$u | grep -c 'content=\"noindex\"')"; sleep 1; done
   ```
2. Falls weiterhin `noindex`: Website → Konfiguration → Einstellungen → Feld **Domain** prüfen (muss `https://jibbit.ch` sein). Entwicklermodus → Einstellungen → Technisch → Benutzeroberfläche → Ansichten → nach `noindex` im Feld «Architektur» suchen (angepasste Kopien von `website.layout`) und installierte Zusatzmodule prüfen.
3. Für Seiten (nicht Produkte): Website → Seite öffnen → Site → Eigenschaften → Reiter «Veröffentlichen» → «Indexiert» (Doku: Site ‣ Properties ‣ Publish ‣ Indexed).
4. GSC → Seiten-Bericht → Grund «Durch "noindex"-Tag ausgeschlossen»: zeigt, welche URLs Google tatsächlich so gesehen hat.

### F3 — Staging `test.jibbit.ch` ist indexierbar — HOCH

Siehe [Abschnitt 7](#7-staging-testjibbitch).

### F4 — EN/FR/IT: halb übersetzte Duplikate mit Junk-Slugs — MITTEL

**Evidenz** — Scan aller 33 Produkte unter `/en/shop/…` (Googlebot-UA): 12 von 33 leiten per `301` auf einen anderen englischen Slug, weil der englische Produktname (Quellbegriff `en_US`) nie nachgezogen wurde:

```
/en/shop/coming-soon-11                                          ← DE: kailar-filter-5-9mm-65stk-weiss-11
/en/shop/black-leaf-el-humeros-konische-hulsen-ks-100x-kopie-47
/en/shop/gizeh-dw-extra-fine-kopie-61
/en/shop/purize-super-slim-white-50er-pack-5mm-kopie-48
/en/shop/kailar-filer-5-9mm-65stk-schwarz-26                     ← Tippfehler «filer»
/en/shop/ocb-bio-slim-organic-hemp-rolls-24-40
/en/shop/silikon-dose-22mm-hellgrun-55, /en/shop/smoking-brown-double-window-28, …
```

- Meta-Descriptions der EN/FR/IT-Seiten sind überwiegend deutsch oder englisch gemischt («4 Meter Rolls, gebleicht» auf `/en`). Die Altersabfrage ist in allen Sprachen deutsch.
- Jede Sprachversion hat einen eigenen Self-Canonical, und weil hreflang fehlt (F1), sieht Google vier unverbundene, fast identische Kopien pro Produkt.
- Die deutschen Slugs und Titel sind sauber: kein «(Kopie)», kein «coming-soon» in den 39 Sitemap-URLs.

**Fix**

- Variante A (empfohlen, solange die Übersetzungen nicht gepflegt sind und der Shop ohnehin abgelöst wird): Website → Konfiguration → Einstellungen → Abschnitt «Website-Info» → Feld **Sprachen**: Englisch/Französisch/Italienisch entfernen, Default bleibt Deutsch (Menüpfad in der Odoo-Doku verifiziert). Nebeneffekt: der 303-Redirect nach `/en` (F7) verschwindet, weil `en_US` dann keine Website-Sprache mehr ist (aus dem Quellcode abgeleitet, nicht live getestet). Für bereits indexierte `/en/…`-URLs danach 301-Redirects anlegen: Entwicklermodus → Website → Konfiguration → **Redirects** (Doku verifiziert; Typ «301 Moved Permanently», z. B. `/en/shop` → `/shop`). Vorher testen, was Odoo mit `/en/…` macht, wenn die Sprache weg ist (wahrscheinlich 404).
- Variante B: Sprachen behalten, dann F1 beheben (hreflang) und die englischen Produktnamen korrigieren: Produkt im Backend öffnen → Sprachkürzel-Button (`DE`/`EN`) neben dem Feld «Name» → englischen Wert setzen. Odoo bildet den Slug aus dem Namen der jeweiligen Sprache.

### F5 — `www.jibbit.ch` liefert 200 — MITTEL

Evidenz: siehe 1.3. Das Zertifikat deckt beide Namen (`DNS:jibbit.ch, DNS:www.jibbit.ch`), der Canonical zeigt auf den Apex — Google wird das meist korrekt zusammenführen, aber es ist ein vermeidbares Duplikat und verbraucht Crawl-Budget.

Fix: eigener nginx-Serverblock `server_name www.jibbit.ch; return 301 https://jibbit.ch$request_uri;` (für 80 und 443). Kein Odoo-Thema. Das Pendant in Odoo (Website → Konfiguration → Einstellungen → Domain) leitet nicht selbst um.

### F6 — Startseiten-Metadaten und fehlende Descriptions — MITTEL

- `/`: `<title>Home | Jibbit.ch</title>`, `<meta name="description" content="This is the homepage of the website"/>` — der englische Odoo-Platzhalter auf der wichtigsten deutschen Seite.
- `/shop`: `<title>Shop | Jibbit.ch</title>`, keine Description; `og:title` lautet «Products | Jibbit.ch».
- 14 von 33 deutschen Produktseiten ohne Meta-Description; die vorhandenen sind 2–6 Wörter lang («Ultra Thin Papers», «hellgrün», «Limited Edition»).

Fix: Seite im Frontend öffnen (als Editor eingeloggt) → **Site → SEO optimieren** → Titel und Beschreibung setzen (Doku-Seite SEO; pro Seite und pro Produkt). Startseite z. B. «Jibbit.ch – Online-Headshop Schweiz: Papers, Filter & Zubehör».

### F7 — 303 nach `/en` für Nicht-Bots ohne de/fr/it — MITTEL

Evidenz und Ursache: 1.1 und 1.4. Folgen:

- **GSC «Live-URL testen»** nutzt den UA `Google-InspectionTool` → bekommt `303 → /en`. Der Live-Test kann deshalb «Seite mit Weiterleitung» bzw. die englische Seite zeigen, obwohl der echte Indexierungs-Crawl (UA `Googlebot`) Deutsch auf `/` erhält. Beim Lesen der GSC immer zwischen «Gecrawlte Seite ansehen» (= echter Googlebot) und «Live-Test» unterscheiden.
- PageSpeed Insights/Lighthouse messen die englische Seite inklusive zweier Redirect-Hops.
- Besucher mit englischem Browser (in der Schweiz häufig) landen auf der halb übersetzten EN-Version.
- 303 ist für Suchmaschinen ein temporärer Redirect; da Googlebot ihn nicht bekommt, ist das für die Indexierung unkritisch.

Fix: nicht per Einstellung abschaltbar. Entweder Variante A aus F4 (Englisch als Website-Sprache entfernen) oder akzeptieren. Eine Bot-Listen-Erweiterung wäre Custom-Code und lohnt sich vor der Ablösung nicht.

### F8 — Crawlbare Junk-URLs, robots.txt ohne Regeln — NIEDRIG

| URL (Googlebot-UA) | Status | robots | Canonical |
|---|---|---|---|
| `/website/info` (**steht in der Sitemap**) | 200 | – | self; listet installierte Odoo-Apps |
| `/web/login` | 200 | – | self |
| `/shop/cart` | 200 | – | self |
| `/shop?order=name+asc`, `/shop?search=raw` | 200 | – | `/shop` (gut) |
| `/shop/page/2` | 200 | – | self |
| `/shop/category/1` | 404 | – | – (es gibt keine Kategorien-URLs) |

Sitemap-Inhalt: 39 URLs = 3 statische Seiten, 33 Produkte, `/shop`, `/`, `/website/info`. Nur die Default-Sprache (keine `/en`-, `/fr_CH`-, `/it`-URLs — Odoo-Standard). `lastmod` nur bei 2 von 39 (contactus, impressum). Kein «(Kopie)», kein «coming-soon», keine `?page=`-/Filter-URLs, kein `/web/login` in der Sitemap.

Fix: Website → Konfiguration → Einstellungen → Abschnitt SEO → **robots.txt bearbeiten** (Pfad in der Odoo-Doku verifiziert) und ergänzen:

```
Disallow: /web/
Disallow: /shop/cart
Disallow: /shop/checkout
Disallow: /shop/change_pricelist/
Disallow: /website/info
Disallow: /*?order=
Disallow: /*?search=
```

`/website/info` zusätzlich abschalten: Die Seite hängt an der Ansicht `website.website_info`/`website.show_website_info` (Quellcode); Deaktivieren über Entwicklermodus → Technisch → Ansichten (unverifiziert, ob es dafür einen Schalter im Editor gibt).

### F9 — Transport/Performance — NIEDRIG

| Messung (Googlebot-UA, gzip, vom Testrechner) | Wert |
|---|---|
| TTFB `/` · `/shop` · 3 Produkte | 0.058 s · 0.151 s · 0.081 / 0.071 / 0.074 s |
| HTML-Grösse gzip / entpackt | `/` 6.3 KB / 24 KB · `/shop` 11 KB / 91 KB · Produkt ≈ 9 KB / 35 KB |
| CSS-Bundle `web.assets_frontend.min.css` | 136 KB gzip / 754 KB entpackt |
| Kompression | `Content-Encoding: gzip` auf HTML, CSS, JS |
| Cache-Header Assets | `Cache-Control: public, max-age=31536000, immutable` (CSS/JS); Bilder `private, max-age=31536000, immutable`, WebP |
| Cache-Header HTML | keine (jede Antwort setzt frische `session_id`- und `frontend_lang`-Cookies) |
| HTTP-Version | **nur HTTP/1.1** — `openssl s_client -alpn h2,http/1.1` → `ALPN protocol: http/1.1` |
| HSTS | fehlt |
| Cookies | `session_id` mit `HttpOnly`, aber ohne `Secure`/`SameSite` |
| TLS | TLSv1.3, Let's Encrypt, gültig bis 2026-12-13 |
| Server-Header | `nginx/1.18.0 (Ubuntu)` |
| Mixed Content | keine `http://`-Ressourcen; nur Links: `href="http://jibbit.ch"` / `http://Jibbit.ch` im Startseiteninhalt und die Odoo-Footer-Links |

Die Antwortzeiten sind sehr gut; nichts davon bremst Googlebot. Fix (nginx): `listen 443 ssl http2;`, `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";` und `proxy_cookie_flags session_id samesite=lax secure;` (beides im nginx-Beispiel der Odoo-Doku), `server_tokens off;`. Die zwei `http://jibbit.ch`-Links im Startseiten-Editor auf `https://` ändern.

### F10 — Altersabfrage blockiert den Inhalt nicht — NIEDRIG

Der Inhalt steht vollständig im initialen HTML, ohne JavaScript und ohne Cookies:

```
<h1 itemprop="name">RAW Black KSS Papers
oe_currency_value">1.89
```

Die Altersabfrage ist ein Bootstrap-Modal (`#ageVerificationModal`), das erst per JS eingeblendet wird:

```js
var isBot = /bot|googlebot|crawler|spider|robot|crawling|bingbot|yandex|duckduckbot/i.test(navigator.userAgent);
if (!isBot && !localStorage.getItem('age_verified_18')) { modal.classList.add('show'); … }
```

Kein Cookie-Wall, kein serverseitiger Block. Anmerkungen: (1) `Google-InspectionTool` matcht die Regex nicht → der Screenshot im GSC-Live-Test zeigt das Overlay über der Seite; der gerenderte HTML-Inhalt ist trotzdem vollständig. (2) UA-Sniffing, das nur ein Overlay weglässt, gilt nicht als Cloaking, solange der Inhalt identisch ist. (3) «Nein» leitet auf google.com — harmlos. Kein Handlungsbedarf.

### F11 — Strukturierte Daten — NIEDRIG (bekannt)

Bestätigt: Produktseite hat nur Microdata (`schema.org/Product` + `Offer` mit `name`, `image`, `url`, `price`, `priceCurrency`, `listPrice`), **0 JSON-LD-Blöcke**; kein `availability`, `brand`, `sku`, `gtin`, `description`.

---

## 4. Rendering

Hauptinhalt (H1, Preis, Beschreibung, Produktlinks auf `/shop`: 20 Produkte + `/shop/page/2`) ist im initialen HTML; JS wird `defer` geladen und ist für den Inhalt nicht nötig. Bilder haben `alt` und `loading="lazy"`. Googlebot braucht kein Rendering, um die Seite zu verstehen.

---

## 5. Öffentliche Index-Hinweise (schwache Evidenz)

Ein einzelner Versuch `site:jibbit.ch` über die WebSearch-Schnittstelle (US-basiert, Suchmaschine unbekannt, nicht Google Schweiz) lieferte genau zwei Treffer der Domain:

- `https://jibbit.ch/en/shop` — «Products | Jibbit.ch»
- `https://jibbit.ch/en/shop/6-purize-white-50er-pack-10` — «PURIZE White, 50er Pack | Jibbit.ch»

Beides sind **englische** URLs. Das ist kein Beweis für den Google-Index, passt aber zum Bild: ohne hreflang konkurrieren die `/en`-Kopien mit den deutschen Seiten, und ein US-Index bevorzugt die englische Version. Verlässlich beantwortet das nur der GSC-Seitenbericht.

---

## 6. Reihenfolge der Massnahmen

1. **Staging sperren** (F3) — fünf Minuten, grösstes Risiko.
2. **Proxy-Konfiguration** (F1): `proxy_mode = True` + `X-Forwarded-*`-Header, Neustart, Sitemap-Cache leeren, Sitemap in der GSC neu einreichen. Behebt `http://` in robots.txt/Sitemap und bringt hreflang + x-default zurück.
3. **`noindex`-Seiten** erneut prüfen (F2); falls noch vorhanden, Domain-Feld und angepasste Ansichten untersuchen.
4. **Sprachen entscheiden** (F4/F7): EN/FR/IT entfernen + 301-Redirects, oder sauber übersetzen.
5. `www` → Apex per nginx-301 (F5), Startseiten-Title/-Description (F6), robots.txt-Disallows (F8), HTTP/2 + HSTS (F9).

---

## 7. Staging `test.jibbit.ch`

Neues Storefront (Next.js hinter demselben nginx). Geprüft mit Googlebot-Smartphone-UA, ohne Cookies.

```
$ curl -sIL -A "$GB" https://test.jibbit.ch/
HTTP/1.1 200 OK
X-Powered-By: Next.js
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
(kein X-Robots-Tag, kein WWW-Authenticate)

$ curl -s https://test.jibbit.ch/robots.txt
User-Agent: *
Allow: /

Sitemap: https://test.jibbit.ch/sitemap.xml

$ curl -s https://test.jibbit.ch/sitemap.xml   → 200, application/xml, 40 URLs (https://test.jibbit.ch/products/…, /?kategorie=…, /agb, …)
```

| Seite | Status | meta robots | Canonical | Inhalt |
|---|---|---|---|---|
| `/` | 200, TTFB 0.36 s | **`index, follow`** | **fehlt** | `<html lang="de-CH">`, Title «jibbit — Online Headshop Schweiz» |
| `/products/raw-classic-king-size-slim` | 200, TTFB 0.44 s | **`index, follow`** | **fehlt** | H1, Preis «CHF 3.75», Beschreibung und 2 JSON-LD-Blöcke (`Product`, `Offer`) im HTML |

**Urteil: Staging ist vollständig indexierbar — Befund, Schweregrad HOCH.** Kein Auth, kein `noindex`, robots.txt erlaubt alles und bewirbt sogar eine Sitemap. Es ist aktuell von jibbit.ch aus nicht verlinkt (`grep -c test.jibbit.ch` = 0 auf `/`, `/shop`, Produktseite), aber Hostnamen werden über Certificate-Transparency-Logs (Let's-Encrypt-Zertifikat für `test.jibbit.ch`) gefunden. Ohne Canonical würde Google die Staging-Produkte als eigenständige Duplikate des künftigen Shops werten.

**Fix (eine der Varianten, am besten 1 + 2):**

1. HTTP Basic Auth im nginx-Serverblock von `test.jibbit.ch` (`auth_basic` + `auth_basic_user_file`) — zuverlässigste Sperre; Webhooks/Payment-Callbacks per eigener `location` ausnehmen.
2. `add_header X-Robots-Tag "noindex, nofollow" always;` im selben Serverblock, bzw. im Next.js-Code `robots: { index: false, follow: false }` abhängig von einer Env-Variable (z. B. nur bei Produktions-Domain `index: true`).
3. **Nicht** nur `Disallow: /` in robots.txt: das verhindert das Crawlen, aber nicht das Indexieren bereits bekannter URLs, und Google könnte ein `noindex` dann nicht mehr lesen.
4. Falls schon etwas indexiert ist: GSC-Property für `test.jibbit.ch` anlegen → Entfernen → «Vorübergehend entfernen» (Präfix).

Vor dem Go-live zusätzlich: Self-Canonical auf allen Seiten ergänzen (fehlt derzeit komplett) und die Kategorie-URLs `/?kategorie=…` überdenken — Query-Parameter auf der Startseite ohne Canonical sind Duplikate der Startseite.

**Altersabfrage Staging:** Das Overlay (`AgeGate-module__…__overlay`, `role="dialog" aria-modal="true"`, «Bist du 18…») wird **serverseitig mit ausgeliefert** und steht im HTML vor dem Inhalt (Byte-Offset 5'983 vs. `<h1>` bei 47'438 von 59'157). Der eigentliche Inhalt — `<main id="main">`, H1, Preis, Beschreibungstext, JSON-LD — steht trotzdem vollständig im HTML für einen cookielosen Client; `<main>`/`<body>` tragen kein `hidden`/`inert`. Der Inhalt ist für Googlebot also **nicht versteckt**. Restrisiko (niedrig): Das Overlay ist für jeden cookielosen Client sichtbar, also auch im Google-Rendering/Screenshot, und der Overlay-Text steht im DOM vor dem Hauptinhalt. Vor dem Launch in der GSC-URL-Prüfung («Gecrawlte Seite ansehen» → Screenshot + HTML) kontrollieren; bei Bedarf das Overlay erst clientseitig nach Hydration einblenden.

---

## 8. Befehle zum Nachprüfen

```bash
GB='Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
F='^(HTTP|location|vary|content-language|set-cookie: frontend|x-robots|strict)'

curl -sIL -A "$GB" https://jibbit.ch/ | grep -iE "$F"                                   # Googlebot: 200 de_CH
curl -sIL -A 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)' https://jibbit.ch/ | grep -iE "$F"   # 303 → /en
curl -s https://jibbit.ch/robots.txt
curl -s https://jibbit.ch/sitemap.xml | grep -c '<loc>http://'                           # heute 39, Ziel 0
curl -s --compressed -A "$GB" https://jibbit.ch/shop/raw-black-kss-papers-2 \
  | grep -oiE '<html[^>]*>|<link[^>]*rel="(canonical|alternate)"[^>]*>|<meta[^>]*name="robots"[^>]*>'
curl -sI -A "$GB" https://www.jibbit.ch/ | head -1                                       # heute 200, Ziel 301
echo | openssl s_client -alpn h2,http/1.1 -connect jibbit.ch:443 -servername jibbit.ch 2>/dev/null | grep ALPN
curl -s https://test.jibbit.ch/robots.txt; curl -sI -A "$GB" https://test.jibbit.ch/ | grep -iE '^(HTTP|x-robots|www-auth)'
```

---

## 9. Was nur die Search Console beantworten kann

Property: am besten die Domain-Property `jibbit.ch` (deckt http/https/www/Subdomains inkl. `test.` ab).

| Frage | Wo klicken |
|---|---|
| Welche Sprache/URL hat der **echte** Googlebot zuletzt gecrawlt und indexiert? | **URL-Prüfung** (Suchfeld oben) → `https://jibbit.ch/` und eine Produkt-URL eingeben → «Seite ist indexiert» aufklappen → **«Gecrawlte Seite ansehen»** → Reiter HTML (nach `<html lang=` und `canonical` suchen), Screenshot, «Weitere Informationen» (HTTP-Antwort). Achtung: **«Live-URL testen»** verwendet `Google-InspectionTool` und bekommt den 303 nach `/en` (F7) — das ist nicht das, was indexiert wird. |
| Welchen Canonical hat Google gewählt (DE oder `/en`)? | URL-Prüfung → Abschnitt «Seitenindexierung» → «Vom Nutzer angegebene kanonische URL» vs. **«Von Google ausgewählte kanonische URL»**. |
| Wie viele Seiten sind indexiert, welche nicht und warum? | **Indexierung → Seiten**. Relevante Gründe: «Seite mit Weiterleitung» (http://-Sitemap-URLs, `/en`-Ketten), «Durch "noindex"-Tag ausgeschlossen» (F2), «Duplikat – Google hat eine andere Seite als der Nutzer als kanonische Seite bestimmt» (Sprachkopien, `www`), «Alternative Seite mit richtigem kanonischen Tag», «Gecrawlt – zurzeit nicht indexiert», «Nicht gefunden (404)». Oben den Filter «Alle eingereichten Seiten» wählen, um nur Sitemap-URLs zu sehen. |
| Sind `/en`-, `/fr_CH`-, `/it`-URLs im Index? | Indexierung → Seiten → «Daten zu indexierten Seiten ansehen» → Filter URL enthält `/en/`. Ergänzend **Leistung → Suchergebnisse → Reiter Seiten**, Filter «Land: Schweiz»: Welche Sprachversion bekommt Impressionen? |
| hreflang-Fehler | Den früheren Bericht «Internationale Ausrichtung» gibt es nicht mehr. hreflang-Probleme zeigen sich heute indirekt: Seiten-Bericht (Duplikat-/Canonical-Gründe je Sprachversion) und URL-Prüfung je Sprach-URL. Nach dem F1-Fix pro Sprache eine URL prüfen und im gecrawlten HTML nach `hreflang` suchen. |
| Wurde die Sitemap gelesen, wie viele URLs erkannt? | **Indexierung → Sitemaps** → Status, «Erkannte Seiten», «Zuletzt gelesen». Prüfen, ob `http://jibbit.ch/sitemap.xml` oder `https://…` eingereicht ist; nach F1 die https-Variante neu einreichen, die alte entfernen. Klick auf die Sitemap → «Seitenindexierung ansehen». |
| Crawl-Frequenz, Antwortcodes, Hosts | **Einstellungen → Crawling-Statistiken → Bericht öffnen** → «Nach Antwort» (Anteil 301/302/303/404), «Nach Googlebot-Typ» (Smartphone), «Nach Zweck», Abschnitt **Hosts** (taucht `www.jibbit.ch` oder `test.jibbit.ch` auf?), «Hoststatus» (robots.txt-Abruf, DNS, Serververbindung). |
| Ist das Staging schon im Index? | Eigene Property `test.jibbit.ch` (oder Domain-Property) → Indexierung → Seiten; sonst in Google Schweiz `site:test.jibbit.ch`. |
| Rich-Result-Status der Produkte | Seitenleiste **Shopping → Produkt-Snippets / Händlereinträge** (erscheint nur, wenn Google Produkt-Markup erkennt); sonst URL-Prüfung → «Verbesserungen». |
| Manuelle Massnahmen / Sicherheitsprobleme | **Sicherheit & manuelle Massnahmen**. |

---

## 10. Quellen für die Odoo-Aussagen

Verifiziert (heute abgerufen):

- Odoo 17 Doku «System configuration / Deploy → HTTPS»: `proxy_mode = True`, nginx-Header `X-Forwarded-Host/-For/-Proto`, `X-Real-IP`, HSTS-Zeile, `proxy_cookie_flags`. https://www.odoo.com/documentation/17.0/administration/on_premise/deploy.html
- Odoo 17 Doku «SEO»: robots.txt unter Website ‣ Configuration ‣ Settings ‣ SEO ‣ Edit robots.txt; Sitemap 12 h Cache; «Indexed» unter Site ‣ Properties ‣ Publish; Odoo setzt hreflang + x-default automatisch. https://www.odoo.com/documentation/17.0/applications/websites/website/pages/seo.html
- Odoo 17 Doku «Pages»: Redirects unter Website ‣ Configuration ‣ Redirects (Entwicklermodus), Typen 301/302/308/404. https://www.odoo.com/documentation/17.0/applications/websites/website/pages.html
- Odoo 17 Doku «Translations»: Sprachen und Default-Sprache unter Website ‣ Configuration ‣ Settings ‣ Website info. https://www.odoo.com/documentation/17.0/applications/websites/website/configuration/translate.html
- Odoo-Quellcode (GitHub, Branch 17.0; 18.0 stichprobenartig gleich): `addons/website/controllers/main.py` (robots/sitemap mit `url_root`, `SITEMAP_CACHE_TIME = 12 h`), `addons/website/models/website.py` (`_get_alternate_languages`, `_is_canonical_url`, `_is_indexable_url`), `addons/website/views/website_templates.xml` (`noindex`-Bedingung, `t-cache` auf `<head>`), `addons/http_routing/models/ir_http.py` (Sprach-Redirect, Bot-Zweig), `addons/web/models/ir_http.py` (Bot-Liste), `odoo/http.py` (`default_lang`, `DEFAULT_LANG`).
- Odoo-Forum zum gleichen Symptom: https://www.odoo.com/forum/help-1/url-root-not-https-so-the-sitemap-and-robots-dont-have-links-with-https-192947

Unverifiziert / Annahmen (im Text markiert): exakte Odoo-Version der Instanz; Ursache der `noindex`-Tags (F2); Menüpfad zum Löschen des Sitemap-Attachments; Verhalten von `/en/…`-URLs nach dem Entfernen der Sprache; Abschaltweg für `/website/info`.
