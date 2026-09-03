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

## Nicht verifiziert (ehrlicherweise)

- Kein End-to-End-Test gegen ein echtes zahls.ch-Testkonto (Gateway anlegen,
  TWINT-Testzahlung, Webhook-Empfang) — dafür braucht es die echten
  TEST-Zugangsdaten des Betreibers.
- Die GET-Prüfung von zahls.ch wurde gegen die neue Route nicht live
  ausgelöst (gleicher Mechanismus wie beim früheren Eigenbau-Modul, dort
  belegt).
- Ob zahls.ch für `waiting` überhaupt Webhooks schickt (bestimmt nur, wie
  viel Log-Rauschen die bekannte Lücke erzeugt).
