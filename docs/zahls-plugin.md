# zahls.ch über das offizielle Plugin (@zahls/medusa-plugin)

Stand: 2026-08-24. Betrifft `@zahls/medusa-plugin@0.0.1` auf Medusa **2.13.6**.

## Kurzfassung für die Einrichtung

1. In der `.env` drei Werte setzen (aus `<instanz>.zahls.ch` → API & Integrationen):

   ```
   ZAHLS_INSTANCE=<instanzname>          # "beispiel" für beispiel.zahls.ch
   ZAHLS_API_KEY=<api-schlüssel>
   ZAHLS_WEBHOOK_SECRET=<signatur-schlüssel>
   ```

   Alle drei sind in `docker-compose.yml` unter `environment:` bereits
   durchgereicht. Steht das zahls.ch-Konto auf **TEST MODUS**, sind das die
   Test-Schlüssel — es gibt keinen weiteren Schalter im Shop.

2. Im zahls.ch-Backend unter **Webhooks** eintragen (Typ **JSON**):

   ```
   https://<API_DOMAIN>/hooks/payment/zahls_zahls
   ```

   zahls.ch prüft die Adresse beim Eintragen mit einem **GET**. Den
   beantwortet `backend/src/api/hooks/payment/zahls_zahls/route.ts` mit 200 —
   ohne diese Route käme 404 und zahls.ch wiese die Adresse als «nicht
   gültig» zurück (genau daran war die Einrichtung schon einmal gescheitert).

3. Neustart (`docker compose up -d --build medusa`). Bei unvollständiger
   Konfiguration startet der Shop trotzdem; im Log steht dann eine Warnung,
   welche Variable fehlt.

4. Auf einer **bestehenden** Instanz den Provider der Region zuweisen:
   Admin → Einstellungen → Regionen → Schweiz → Zahlungsanbieter →
   **zahls.ch** hinzufügen. (Der Seed macht das nur bei einer frischen
   Datenbank, und auch nur, wenn die drei Variablen beim Seeden gesetzt sind.)

5. Zahlarten (TWINT, Kreditkarte, PostFinance) werden im **zahls.ch-Backend**
   der Instanz aktiviert, nicht in Medusa. Der Shop bietet kein Powerpay und
   keinen Kauf auf Rechnung an — im zahls.ch-Backend also auch nichts
   dergleichen freischalten.

## Was das Plugin ist — und was es auf 2.13.6 tut

- **Provider-Kennung:** `pp_zahls_zahls` (Service-Identifier `zahls`,
  Registrierungs-`id` `zahls` in `medusa-config.ts`).
- **Checkout-Modell:** Hosted Redirect. `initiatePayment` legt einen
  zahls.ch-Gateway an und schreibt dessen Checkout-URL als `link` in die
  Payment-Session-Daten; die Storefront muss den Kunden auf
  `paymentSession.data.link` weiterleiten. Ein eingebettetes Kartenfeld gibt
  es nicht.
- **Beträge:** Medusa-Dezimalbeträge werden mit `toMinorUnits()` in Rappen
  umgerechnet (CHF 3.75 → 375, über Medusas BigNumber, kein Faktor-100-
  Fehler; abgesichert in `src/__tests__/zahls-plugin-amounts.unit.spec.ts`).
  Webhook-Beträge kommen in Rappen an und werden nach Dezimal zurückgerechnet.
- **Webhook:** Medusas **eingebaute** Route `POST /hooks/payment/zahls_zahls`
  (das Plugin bringt keine eigene mit). Signaturprüfung: HMAC-SHA256 über den
  rohen Body gegen den Header `X-Webhook-Signature`, timing-sicher; ohne
  `webhookSecret` verwirft das Plugin jeden Webhook. `preserveRawBody` für
  diesen Pfad ist in `backend/src/api/middlewares.ts` gesetzt — nicht
  entfernen, sonst stimmt keine Signatur mehr.
- **Statusmeldung:** `confirmed` → Webhook-Aktion **`captured`**
  (`PaymentActions.SUCCESSFUL`). Das ist anders als beim früheren
  Eigenbau-Modul (`confirmed` → `authorized`), aber auf 2.13.6 sicher: das Payment-Modul
  bricht eine zweite Capture an `payment.captured_at` ab, und das
  provider-seitige `capturePayment` des Plugins ist bei einem bereits
  bestätigten Gateway ein No-Op (kein zweiter API-Aufruf Richtung zahls.ch).

## Die Versionsfrage (Plugin will 2.18.0, Projekt hat 2.13.6)

`@zahls/medusa-plugin@0.0.1` pinnt seine `peerDependencies` **exakt** auf
`@medusajs/*@2.18.0`. Das Projekt läuft auf 2.13.6. Befund nach Lektüre des
Plugin-Quelltexts und Tests gegen die installierten 2.13.6-Pakete:

**Es läuft.** Der Provider nutzt ausschliesslich API, die es in 2.13.6 gibt
(`AbstractPaymentProvider`, `ModuleProvider`, `BigNumber`/`MathBN`,
`session_id` in den Initiate-Daten — von 2.13.6 gesetzt). Die Peer-Pins sind
strenger als der tatsächliche Bedarf.

Zwei Konsequenzen:

1. **npm braucht `legacy-peer-deps`** (in `.npmrc` im Repo-Root und in
   `backend/.npmrc`, letzteres wandert in beide Docker-Stages). `overrides`
   in package.json greifen bei Peer-Konflikten nicht. Beim Upgrade auf
   2.18.x den Schalter wieder entfernen.
2. **Eine bekannte, harmlose Lücke:** `PaymentActions.PENDING_AUTHORIZATION`
   und `PaymentSessionStatus.PENDING_AUTHORIZATION` existieren in 2.13.6
   nicht — für den Status `waiting` liefert das Plugin deshalb `undefined`.
   Folgen: ein `waiting`-Webhook erzeugt einen wirkungslosen (ggf. als
   fehlgeschlagen geloggten) Workflow-Lauf, und `authorizePayment` auf einem
   unbezahlten Gateway schlägt mit «was not authorized» fehl — Letzteres ist
   inhaltlich korrekt (unbezahlt darf nicht autorisieren), nur der Statuswert
   ist unschön. **Es kann dadurch weder eine Bestellung ohne Zahlung noch
   eine Doppelbelastung entstehen.** Festgehalten in
   `src/__tests__/zahls-plugin-webhook.unit.spec.ts`; der Test macht ein
   späteres Medusa-Upgrade an dieser Stelle sichtbar.

### Alternative: Projekt auf 2.18.0 heben

Nicht hier entschieden — Abwägung für den Betreiber:

| | Bleiben auf 2.13.6 (dieser Stand) | Upgrade auf 2.18.0 |
|---|---|---|
| Aufwand | erledigt | alle `@medusajs/*` gleichziehen, Migrationen fahren, alle Module/Routen/Workflows nachtesten (swiss-shipping, smtp, Odoo-Skripte), Docker-Lockfile neu |
| Risiko | `waiting`-Lücke (harmlos, s.o.); `legacy-peer-deps` bleibt nötig | Breaking Changes über 5 Minor-Versionen; produktive Instanz mit Livedaten |
| Gewinn | — | Peer-Pins passen wieder, `waiting` → sauberes `pending_authorization` |

## Webhook-Zuverlässigkeit — ehrlich benannt

Die eingebaute Route antwortet **immer 200** (auch bei ungültiger Signatur)
und verarbeitet **asynchron** über den Event-Bus mit 5 s Verzögerung. Dieses
Projekt fährt den **In-Memory**-Event-Bus: ein Neustart in diesem Fenster
verliert das Ereignis, und zahls.ch wiederholt nicht, weil es schon 200
bekommen hat. Das frühere Eigenbau-Modul hatte für genau diese Punkte eine
eigene synchrone Route mit ehrlichen Statuscodes (401/500) gebaut.

Das ist der Preis des offiziellen Plugins in Standardkonfiguration. Milderung
ohne Eigenbau: Redis-Event-Bus (`@medusajs/event-bus-redis`) konfigurieren —
Redis läuft im Stack bereits. Das ist hier **nicht** Teil dieses Umbaus und
sollte vor dem Livegang entschieden werden.

## Ablösung des früheren Payrexx-Eigenbau-Moduls — vollzogen

Das Eigenbau-Modul (`backend/src/modules/payrexx/`, sprach dasselbe
zahls.ch-Konto über die Payrexx-API an) ist **entfernt**, samt seiner Routen
(`/hooks/payment/payrexx`, `/store/payrexx/return`), Tests und
`PAYREXX_*`-Variablen. Das offizielle Plugin ist der einzige
Zahlungsanbieter.

Auf dem Server ist dafür einmalig nötig:

1. `pp_payrexx_payrexx` in Admin → Einstellungen → Regionen → Schweiz von
   der Region nehmen (falls noch vorhanden) und stattdessen **zahls.ch**
   (`pp_zahls_zahls`) hinzufügen.
2. Den Webhook-Eintrag im zahls.ch-Backend auf
   `https://<API_DOMAIN>/hooks/payment/zahls_zahls` umstellen — die alte
   Adresse `/hooks/payment/payrexx` existiert nicht mehr.
3. In der `.env` die drei `ZAHLS_*`-Pflichtwerte setzen (s. Kurzfassung
   oben); alte `PAYREXX_*`-Einträge können weg.

## Fehlerbild: 500 unknown_error beim Bezahlen / Provider nicht registriert

**Symptom:** Der Shop läuft, die Kasse zeigt zahls.ch als Zahlart an, aber
jeder Klick auf «Bezahlen» endet mit «Die Zahlung liess sich nicht
vorbereiten»; im Backend steht ein nackter `500 unknown_error`, im
Payment-Modul dahinter «Unable to retrieve the payment provider with id:
pp_zahls_zahls». Der Zustand ist unauffällig — es gibt keinen Absturz, nur
eine Warnzeile beim Start.

**Ursache (so geschehen, wochenlang unbemerkt):** Der Umstieg auf das
offizielle Plugin (Commit `6385a4f`, 03.09.2026) hat den Namen des
API-Schlüssels von `ZAHLS_API_SECRET` in `ZAHLS_API_KEY` umbenannt. Die
`.env` auf dem Server wandert bei einem Deploy nicht mit und trug weiter den
alten Namen. `medusa-config.ts` registriert den Provider nur, wenn alle drei
Werte (`ZAHLS_INSTANCE`, `ZAHLS_API_KEY`, `ZAHLS_WEBHOOK_SECRET`) gesetzt
sind — `ZAHLS_API_KEY` war leer, der Provider fehlte, die Verknüpfung an der
Region blieb aber bestehen.

Dasselbe gilt für alle Namen der beiden Vorgänger-Stände:

| Alter Name | Heute | Bemerkung |
|---|---|---|
| `ZAHLS_API_SECRET` | `ZAHLS_API_KEY` | gleicher Wert, nur umbenennen |
| `PAYREXX_INSTANCE` | `ZAHLS_INSTANCE` | Wert prüfen (zahls.ch-Instanz) |
| `PAYREXX_API_SECRET` | `ZAHLS_API_KEY` | Wert prüfen (zahls.ch-Backend) |
| `PAYREXX_WEBHOOK_SECRET` | `ZAHLS_WEBHOOK_SECRET` | Wert prüfen (zahls.ch-Backend) |
| `ZAHLS_API_BASE_URL`, `ZAHLS_ENABLED_PSPS`, `PAYREXX_API_BASE_URL`, `PAYREXX_ENABLED_PSPS` | — | ohne Funktion, Zeile entfernen |

**Was der Shop seither tut** (`backend/src/lib/zahls-plugin.ts`,
`zahlsEnvHinweise()`):

- Beim Start nennt die Warnung nicht nur, *was fehlt*, sondern auch, *welche
  alte Zeile umzubenennen ist* (nur Namen, nie Werte).
- Bei `NODE_ENV=production` **bricht der Start ab**, wenn ein umbenannter
  Name gesetzt ist, während sein Nachfolger fehlt. Begründung: ein Shop, der
  in Produktion still ohne Zahlungsanbieter läuft, ist schlimmer als ein
  Shop, der nicht startet — Ersterer verliert jede Bestellung und meldet
  nichts, Letzterer fällt beim Deploy sofort auf. Fehlen die Werte schlicht
  komplett (Dev ohne Konto), bleibt es bei der Warnung.

**Diagnose:**

```bash
# Startwarnung bzw. Abbruchgrund im Log:
docker compose logs medusa | grep -i zahls

# Vollständiger Abgleich Umgebung <-> Datenbank <-> Region; nennt auch die
# veralteten Namen und die Zeile, die umzubenennen ist:
docker compose exec medusa npx medusa exec ./src/scripts/check-payment-setup.ts
```

**Behebung:** Zeile in der `.env` umbenennen (`ZAHLS_API_SECRET=…` →
`ZAHLS_API_KEY=…`, gleicher Wert), `docker compose up -d medusa`, dann das
Diagnose-Script erneut laufen lassen, bis es «✓» meldet.

## Wenn die Kasse «Die Zahlung liess sich nicht vorbereiten» sagt

Diese Meldung kommt aus der Storefront (`lib/checkout/server.ts`,
`placeOrder`). Sie bedeutet: `POST /store/payment-collections/:id/payment-sessions`
ist gescheitert. **Nicht** gemeint ist «die Region hat keine Zahlart» — dafür
gibt es einen eigenen Satz («Für diese Region ist gerade keine Zahlungsart
freigeschaltet»). Steht der generische Satz da, bietet die Region den Provider
also noch an, und der Backend-Aufruf selbst ist gescheitert.

Es gibt genau zwei realistische Ursachen, und **von aussen sind sie nicht zu
unterscheiden** — beide enden in einem nackten `500 unknown_error`:

1. **Der laufende Prozess registriert den Provider nicht.** Fehlt einer der
   drei `ZAHLS_*`-Werte in der Umgebung des Containers (typisch: die `.env`
   trägt noch `ZAHLS_API_SECRET` statt `ZAHLS_API_KEY`, siehe Abschnitt
   «Fehlerbild» oben), lässt
   `medusa-config.ts` den Provider weg. Die Verknüpfung
   `region_payment_provider` in der Datenbank bleibt aber bestehen, und
   `GET /store/payment-providers` liefert `pp_zahls_zahls` weiterhin aus.
   Medusa scheitert dann im Payment-Modul mit
   «Unable to retrieve the payment provider with id: pp_zahls_zahls».
2. **zahls.ch hat den Gateway-Aufruf abgelehnt** (Schlüssel, Betrag, Netz).

### Der Weg, der es entscheidet

```bash
# 1. Sagt das Backend beim Start selbst, dass es den Provider weglässt?
docker compose logs medusa | grep -i zahls
#    "[zahls.ch] Provider nicht registriert — es fehlt: …"  → Ursache 1

# 2. Vollständiger Abgleich Region <-> registrierte Provider:
docker compose exec medusa npx medusa exec ./src/scripts/check-payment-setup.ts

# 3. Der genaue Backend-Fehler, den der Kunde nie sieht, steht im Log der
#    Storefront — sie ruft Medusa serverseitig auf:
docker compose logs storefront | grep '\[checkout\]'
```

### Warum `is_enabled` dabei nichts nützt

Man würde erwarten, dass ein nicht mehr registrierter Provider in der Tabelle
`payment_provider` auf `is_enabled = false` fällt, und dass die Storefront ihn
daran erkennen könnte. **Auf 2.13.6 passiert das nie.** Der Loader
`@medusajs/payment/dist/loaders/providers.js` liest die vorhandenen Zeilen mit
`list({ id: providersToLoad })` und setzt danach alles auf `false`, was
*nicht* in `providersToLoad` steht — die gelesene Liste enthält per Filter
aber ausschliesslich Einträge *aus* `providersToLoad`. Der Zweig ist
unerreichbar. Ein Provider, der einmal registriert war, bleibt für immer
`is_enabled = true`.

Deshalb kann die Storefront diesen Fall nicht selbst erkennen, und deshalb
gleicht `check-payment-setup.ts` gegen die Umgebung des laufenden Prozesses ab
statt gegen ein Datenbankflag.

## Nicht verifiziert (ehrlicherweise)

- Kein End-to-End-Test gegen ein echtes zahls.ch-Testkonto (Gateway anlegen,
  TWINT-Testzahlung, Webhook-Empfang) — dafür braucht es die echten
  TEST-Zugangsdaten des Betreibers.
- Die GET-Prüfung von zahls.ch wurde gegen die neue Route nicht live
  ausgelöst (gleicher Mechanismus wie beim früheren Eigenbau-Modul, dort
  belegt).
- Ob zahls.ch für `waiting` überhaupt Webhooks schickt (bestimmt nur, wie
  viel Log-Rauschen die bekannte Lücke erzeugt).
