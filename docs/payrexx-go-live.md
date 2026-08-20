# Payrexx in Betrieb nehmen — Betreiber-Anleitung

Stand: 2026-08-20. Gilt für `backend/src/modules/payrexx/` (Medusa v2.13.6).

Diese Datei beschreibt, **was der Betreiber eintragen muss**, damit über
jibbit.ch echtes Geld fliessen kann. Der Code ist fertig; was fehlt, sind
Zugangsdaten und zwei Einstellungen im Payrexx-Backend.

Die **kaufmännische** Vorfrage — ob Payrexx unser Sortiment überhaupt
akzeptiert — steht in [`payment-providers-setup.md`](./payment-providers-setup.md)
und ist der eigentliche Blocker. Ohne schriftliche Zusage von Payrexx
Compliance bringt alles hier nichts.

---

## 1. Was wo einzutragen ist

Alles in die `.env` **im Repository-Wurzelverzeichnis** (nicht in
`backend/.env`) — `docker-compose.yml` reicht die Werte an den
`medusa`-Container durch.

| Variable | Woher | Ohne diesen Wert |
|---|---|---|
| `PAYREXX_INSTANCE` | Payrexx-Backend → der Name in der URL `https://<instance>.payrexx.com` | Jeder API-Aufruf schlägt fehl |
| `PAYREXX_API_SECRET` | Payrexx-Backend → **Einstellungen → API & Plugins → API-Schlüssel** | Gateway-Erstellung schlägt fehl |
| `PAYREXX_WEBHOOK_SECRET` | Payrexx-Backend → **Einstellungen → Webhooks** (Signatur-Schlüssel) | Jeder Webhook wird mit **401** abgewiesen |
| `PAYREXX_ENABLED_PSPS` | Liste, siehe §3 | Payrexx zeigt dem Kunden **alle** freigeschalteten Methoden — kein Fehler, aber unkontrolliert |
| `STORE_URL` | Die öffentliche Storefront-URL, z.B. `https://jibbit.ch` | Der Kunde wird nach der Zahlung auf `localhost:8000` geschickt |
| `REDIS_URL` | Ist im Compose-Betrieb schon gesetzt (`redis://redis:6379`) | Idempotenz und Betragsabgleich fallen auf In-Memory zurück — **nicht produktionstauglich** |

`PAYREXX_ENABLED_PSPS` ist eine kommaseparierte Liste von Zahlen, z.B.
`PAYREXX_ENABLED_PSPS=17,36`.

> **Nie ins Repository committen.** `.env` steht in `.gitignore`; das muss so
> bleiben. Die Werte gehören auf die VPS, nicht in Git.

Nach jeder Änderung: `docker compose up -d medusa` (Neustart, kein Rebuild
nötig — die Werte kommen zur Laufzeit aus der Umgebung).

---

## 2. Webhook-URL bei Payrexx hinterlegen

Payrexx-Backend → **Einstellungen → Webhooks → Webhook hinzufügen**:

```
https://api.jibbit.ch/hooks/payment/payrexx
```

(`api.jibbit.ch` ist der Wert von `API_DOMAIN` aus der `.env`. Im
Testbetrieb entsprechend die Testdomain.)

Ereignis: **Transaction** (alle Statusänderungen).

Der Caddyfile-Block `handle /hooks/payment/*` reicht diesen Pfad ohne
Rate-Limit durch — Payrexx' Wiederholungen dürfen nicht gedrosselt werden.

### Warum genau diese URL

Medusa bringt eine eigene Webhook-Route `POST /hooks/payment/:provider` mit.
Die würde hier `/hooks/payment/payrexx_payrexx` heissen (Medusa bildet intern
`pp_${provider}`, und der Provider ist als `pp_payrexx_payrexx` registriert —
`identifier` plus `id` aus `medusa-config.ts`). Sie funktioniert, ist aber
für echtes Geld ungeeignet: sie antwortet **immer** 200, auch auf eine
gefälschte Signatur, und verarbeitet erst 5 Sekunden später asynchron über
den Event-Bus. Ohne Redis-Event-Bus liegt das Ereignis in dieser Zeit nur im
Prozessspeicher — ein Neustart in diesem Fenster verliert eine bereits
bezahlte Bestellung, und Payrexx hat schon 200 bekommen, wiederholt also
nicht.

Unsere Route unter `/hooks/payment/payrexx` verarbeitet synchron und
antwortet ehrlich:

| Code | Bedeutung | Was Payrexx tut |
|---|---|---|
| 200 | verarbeitet, Duplikat, oder bewusst ignoriert | fertig |
| 400 | Body unbrauchbar | nicht wiederholen |
| 401 | Signatur ungültig | nicht wiederholen |
| 500 | vorübergehend gescheitert | **wiederholen** — genau so gewollt |
| 503 | Payrexx-Zugangsdaten fehlen in der Umgebung | wiederholen |

### Test ohne echtes Geld

Ein Aufruf mit falscher Signatur muss 401 liefern:

```bash
curl -i -X POST https://api.jibbit.ch/hooks/payment/payrexx \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"transaction":{"id":1,"status":"confirmed","amount":100}}'
```

Kommt hier **200** statt 401, ist der Webhook-Secret leer oder die Route
nicht erreichbar — in dem Zustand darf nicht scharfgeschaltet werden.

---

## 3. PSP-IDs für TWINT und Rechnungskauf

`PAYREXX_ENABLED_PSPS` schränkt ein, welche Zahlungsmethoden auf der
Payrexx-Seite angeboten werden. Leer gelassen zeigt Payrexx alles, was im
Account freigeschaltet ist.

**Die IDs sind pro Payrexx-Account zu erfragen — sie sind nicht öffentlich
dokumentiert und dürfen nicht geraten werden.** Ein falscher Wert führt zu
einer Bezahlseite ohne die gewünschte Methode.

Abrufen, sobald der Account existiert:

```bash
# Signatur über einen LEEREN Query-String, base64-kodiert
SIG=$(printf '' | openssl dgst -sha256 -hmac "$PAYREXX_API_SECRET" -binary | base64)
curl -s "https://api.payrexx.com/v1.0/PaymentProvider/?instance=$PAYREXX_INSTANCE&ApiSignature=$(printf %s "$SIG" | jq -sRr @uri)"
```

Endpunkt-Referenz:
<https://developers.payrexx.com/reference/retrieve-all-payment-providers>

In der Antwort:

- **TWINT** → der Eintrag mit `name: "twint"`, dessen `id` eintragen.
- **Rechnungskauf / Powerpay** → der Eintrag mit `name: "powerpay"`.
  Erscheint erst, wenn der separate Vertrag mit der MF Group besteht und im
  Payrexx-Backend verbunden ist.
- **Karten** kommen bei Payrexx Pay über den Standard-Acquirer und brauchen
  in der Regel keinen eigenen Eintrag.

Beispiel für „nur TWINT und Powerpay anbieten“:

```
PAYREXX_ENABLED_PSPS=17,36
```

Die Zahlen sind Platzhalter. Erst nach dem Abruf oben eintragen.

---

## 4. Was der Kunde durchläuft

1. Storefront erstellt eine Payment Session → `initiatePayment()` legt bei
   Payrexx ein Gateway an und gibt `data.link` zurück.
2. Storefront leitet den Browser auf `data.link` (Payrexx-Hosted-Page — wir
   sehen nie Kartendaten, das hält uns aus dem PCI-Scope).
3. Der Kunde bezahlt. Payrexx leitet zurück auf
   `${STORE_URL}/checkout/success?payment_session_id=…`
   (bzw. `/checkout/failed`, `/checkout/cancel`).
4. **Zwei unabhängige Wege** schliessen die Bestellung ab:
   - **Webhook** → `/hooks/payment/payrexx`
   - **Rückkehr** → die Storefront ruft `POST /store/payrexx/return` auf

   Beide gehen durch dieselbe Entscheidungslogik und teilen sich denselben
   Idempotenz-Schlüssel. Wer zuerst kommt, erledigt die Arbeit; der andere
   tut nichts. **Erreicht der Kunde die Rückkehrseite nie** — TWINT-App
   geschlossen, Netz weg, Tab zu —, entsteht die Bestellung trotzdem, weil
   der Webhook allein den Warenkorb abschliesst. Bleibt umgekehrt der
   Webhook aus, trägt der Rückkehr-Abgleich.

### Schnittstelle für die Storefront

Die Storefront muss nach der Rückkehr genau einen Aufruf machen (der
Parameter steht bereits in der URL, `initiatePayment()` hängt ihn an):

```
POST /store/payrexx/return
x-publishable-api-key: <publishable key>
Content-Type: application/json

{ "payment_session_id": "payses_…" }
```

Antwort:

```json
{
  "payment_session_id": "payses_…",
  "status": "authorized" | "pending" | "captured" | "canceled",
  "transaction_status": "confirmed"
}
```

- `authorized` / `captured` → Bestellung ist da, Danke-Seite zeigen.
- `pending` → noch nicht bezahlt (oder Powerpay-Prüfung läuft). Kurz warten
  und erneut abfragen; parallel zieht der Webhook nach.
- `canceled` → Zahlung abgelehnt oder abgebrochen.
- HTTP **502** → Payrexx war nicht erreichbar. **Nicht** als Misserfolg
  anzeigen — erneut versuchen; der Webhook zieht ohnehin nach.

Der Status stammt immer aus einer frischen Payrexx-Abfrage, nie aus dem, was
der Browser behauptet. Wer `/checkout/success` von Hand aufruft, bekommt
keine bezahlte Bestellung.

---

## 5. Beträge — die Stelle, an der man alles verlieren kann

Payrexx rechnet in **Rappen als ganzer Zahl** (CHF 42.00 = `4200`), Medusa in
**Dezimal-CHF** (`42`). Faktor 100, in beide Richtungen. Die Umrechnung liegt
ausschliesslich in `backend/src/modules/payrexx/amounts.ts`, mit Tests in
`payrexx-amounts.unit.spec.ts`.

Die Shop-Preise sind **inklusive MwSt.** (`is_tax_inclusive = true`, gesetzt
als price_preference auf `currency_code=chf`, siehe `src/scripts/seed.ts`).
Was Payrexx belastet, ist exakt der Bruttobetrag aus dem Warenkorb — hier
wird keine MwSt. mehr auf- oder abgeschlagen.

**Keine 5-Rappen-Rundung.** Das ist eine Bargeld-Konvention; elektronische
Zahlungen erlauben jeden Rappen-Betrag. Würden wir runden, wiche der
belastete Betrag vom Bestellbetrag ab — und genau diese Differenz würde der
Betragsabgleich (§6) als Manipulationsverdacht werten.

### Erster Echtbetrag: gegenprüfen

Nach der ersten echten Zahlung im Payrexx-Dashboard nachsehen, ob der
belastete Betrag mit der Medusa-Bestellung übereinstimmt. Eine Bestellung
über CHF 27.90, die als CHF 2790.00 oder CHF 0.28 erscheint, ist ein
Faktor-100-Fehler und muss den Betrieb sofort stoppen.

---

## 6. Was das System selbst überwacht

Im Log (`docker compose logs -f medusa`) sind drei Meldungen relevant:

| Meldung | Bedeutung | Zu tun |
|---|---|---|
| `PAYREXX AMOUNT MISMATCH — MANUAL REVIEW REQUIRED` | Der Kunde hat auf einem veralteten Gateway einen anderen Betrag bezahlt, als der Warenkorb jetzt hat. Die Bestellung wurde **nicht** automatisch abgeschlossen. | Im Payrexx-Dashboard den tatsächlich bezahlten Betrag ansehen und die Bestellung von Hand abschliessen oder rückerstatten |
| `Payrexx reported 'refunded' … mirror it in the Medusa Admin` | Eine Rückerstattung wurde **im Payrexx-Dashboard** ausgelöst. Medusa erfährt davon nichts automatisch. | Die Rückerstattung im Medusa-Admin nachtragen, sonst stimmt die Buchhaltung nicht |
| `REDIS_URL not set — falling back to in-memory` | Idempotenz und Betragsabgleich sind wirkungslos | Sofort beheben. In Produktion darf das nie erscheinen |

Rückerstattungen deshalb **immer im Medusa-Admin auslösen**, nicht im
Payrexx-Dashboard. Der Admin-Weg ruft Payrexx auf und schreibt beides fort.

---

## 7. Offene Punkte vor dem Scharfschalten

| # | Punkt | Warum |
|---|---|---|
| 1 | Schriftliche Akzeptanz-Zusage von Payrexx Compliance | Der eigentliche Blocker, siehe `payment-providers-setup.md` §3 |
| 2 | Payrexx' **Retry-Fenster** für Webhooks erfragen | Die Idempotenz-TTL steht auf 48 h — eine grosszügige Annahme, kein bestätigter Wert (`webhook.ts`, `WEBHOOK_IDEMPOTENCY_TTL_SECONDS`) |
| 3 | Vor Powerpay: klären, ob MF Group das **Delkredere-Risiko ab Zusage** trägt | Der Status `waiting` wird als „autorisiert" behandelt, wir versenden also vor Zahlungseingang |
| 4 | Prüfen, ob Karten-Zahlungen bei Payrexx als **Pre-Authorization** oder als Direktbelastung ankommen | Bei Direktbelastung ist „Capture" im Admin nur eine Buchung; das Modul erkennt eine bereits verbuchte Transaktion und ruft Payrexx dann nicht erneut auf |
| 5 | `@medusajs/event-bus-redis` + `@medusajs/workflow-engine-redis` einrichten | Aktuell laufen Event-Bus und Workflow-Engine in-memory. Unsere Webhook-Route ist davon unabhängig (sie verarbeitet synchron), aber alles andere Asynchrone im System überlebt keinen Neustart |
| 6 | Ein **zweites Zahlungsmittel** (Vorauskasse) aktivieren | Damit der Shop weiterläuft, wenn Payrexx pausiert |

---

## 8. Zweitprüfung: sind die Zugangsdaten überhaupt angekommen?

```bash
docker compose exec medusa printenv | grep -c PAYREXX_
# muss 4 sein — die Werte selbst NICHT ausgeben
```

Sind es weniger als 4, fehlt ein Eintrag in der `.env` oder der Container
wurde nach der Änderung nicht neu gestartet.
