# E-Mails und Meldungen

Alle Mails gehen über das Modul `backend/src/modules/smtp-notification/` (SMTP bei Infomaniak). Absender ist
`SMTP_FROM` (Vorgabe `noreply@jibbit.ch`), die Zugangsdaten stehen in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, siehe `.env.example`. Der Provider rendert nichts: Betreff und Text kommen fertig aus `backend/src/lib/`.
Versendet wird über `sendEmail` in `backend/src/lib/notify.ts`. Die Funktion wirft nie, Fehler stehen im Log, ohne
E-Mail-Adresse.

## Was verschickt wird

| Mail | An | Auslöser (Event) | Subscriber | Vorlage |
|---|---|---|---|---|
| Bestellbestätigung | Kundin | `order.placed` | `order-placed.ts` | `order-confirmation` |
| Neue Bestellung | Betreiber (`ORDER_NOTIFICATION_TO`), dazu Push über ntfy (`NTFY_URL`) | `order.placed` | `order-placed.ts` | `order-notification` |
| Versandbestätigung | Kundin | `shipment.created` | `shipment-created.ts` | `shipping-confirmation` |
| Abholbereit (Abholung im Laden) | Kundin | `shipment.created`, wenn die Bestellung abgeholt wird (`docs/abholung-im-laden.md`) | `shipment-created.ts` | `pickup-ready` |
| Bestellung storniert | Kundin | `order.canceled` | `order-canceled.ts` | `order-canceled` |
| Bestellung storniert | Betreiber (`ORDER_NOTIFICATION_TO`) | `order.canceled` | `order-canceled.ts` | `order-canceled-notification` |
| Rückerstattung | Kundin | `payment.refunded` | `payment-refunded.ts` | `refund-confirmation` |
| Passwort zurücksetzen | Kundin | `auth.password_reset` (`actor_type: customer`) | `password-reset.ts` | `customer-password-reset` |
| Passwort zurücksetzen | Admin-Benutzer | `auth.password_reset` (`actor_type: user`) | `password-reset.ts` | `admin-password-reset` |
| Einladung ins Admin | neue Mitarbeitende | `invite.created`, `invite.resent` | `invite-created.ts` | `admin-invite` |
| E-Mail-Adresse korrigiert | Kundin, an die neue Adresse | kein Event: Widget «E-Mail-Adresse korrigieren» im Admin, siehe `docs/kunden-email-aendern.md` | Route `admin/customers/[id]/email` | `customer-email-corrected` |

Keine dieser Mails verlinkt oder erwähnt eine Rückgabe oder ein Widerrufsrecht: Beides gibt es nicht (AGB §9).

## Versandbestätigung

Die Mail geht raus, sobald im Admin ein Fulfillment als versendet markiert wird (Bestellung → Fulfillment →
«Als versendet markieren»). Medusa löst dann `shipment.created` aus, mit der ID des Fulfillments.

- **Inhalt:** Bestellnummer, Artikel dieser Sendung mit Menge, Lieferadresse, Sendungsnummer mit Link, Kontakt
  info@jibbit.ch. Keine Preise, kein Hinweis auf Rückgabe.
- **Sendungsnummer:** im Admin beim Versenden ins Feld «Tracking-Nummer» eintragen. Der Link führt zur
  Sendungsverfolgung der Post (`SWISS_POST_TRACKING_URL` in `backend/src/lib/shipping-notification.ts`). Steht im Admin
  ein eigener Link (http/https), gilt dieser.
- **Ohne Sendungsnummer** (Brief): Die Mail sagt, dass die Sendung ohne Sendungsverfolgung unterwegs ist.
- **Teillieferung:** Die Mail nennt nur die Artikel der Sendung und weist darauf hin, dass der Rest separat kommt.
- **Keine Mail:** wenn im Admin der Schalter «Benachrichtigung senden» aus ist (`no_notification`), wenn die Bestellung
  keine E-Mail-Adresse hat oder wenn das Fulfillment storniert ist.
- **Kein Doppelversand:** Die Notification trägt den Schlüssel `shipping-confirmation:<Fulfillment-ID>`. Kommt das
  Event für dieselbe Sendung noch einmal, verschickt das Notification-Modul keine zweite Mail. Ein fehlgeschlagener
  Versuch sperrt nicht.
- **Fehler** brechen das Versenden im Admin nicht ab. Sie stehen im Log unter `[shipment.created]` oder `[notify]`.
- **Abholung im Laden:** Dieselbe Aktion («Als versendet markieren») heisst dann «abholbereit». Die Mail sagt
  «Deine Bestellung … ist abholbereit», nennt Laden und Abholzeiten und keine Sendungsnummer (auch wenn eine
  eingetragen wurde). Vorlage im Log: `pickup-ready`, derselbe Schlüssel `shipping-confirmation:<Fulfillment-ID>`.
  Auch die Bestellbestätigung und die Betreiber-Meldung unterscheiden Abholung und Versand. Wie die Abholung erkannt
  wird: `docs/abholung-im-laden.md`.

### Auf Staging testen

1. Testbestellung mit einer eigenen E-Mail-Adresse aufgeben.
2. Im Admin die Bestellung öffnen, Fulfillment anlegen, dann «Als versendet markieren», Sendungsnummer eintragen,
   «Benachrichtigung senden» eingeschaltet lassen.
3. Mail prüfen: Artikel, Adresse, Link zur Sendungsverfolgung. Im Log steht `[smtp] Vorlage "shipping-confirmation" versendet.`
4. Zweite Bestellung ohne Sendungsnummer versenden, dritte mit abgeschalteter Benachrichtigung (es darf keine Mail kommen).

## Bestellung storniert

Die Mail geht raus, sobald im Admin eine Bestellung storniert wird (Bestellung → «Bestellung stornieren»). Medusa löst
`order.canceled` aus, mit der ID der Bestellung. Stornieren geht nur, solange kein Fulfillment offen ist.

- **Inhalt (Kundin):** Bestellnummer, dass die Bestellung storniert ist, die Artikel mit Menge, ein Satz zur Zahlung,
  Kontakt info@jibbit.ch.
- **Satz zur Zahlung:** richtet sich nach den Abbuchungen (`captures`) an der Bestellung, nicht nach einem Status.
  Wurde abgebucht: Betrag in CHF, er geht auf das ursprüngliche Zahlungsmittel zurück, das kann ein paar Werktage
  dauern. Wurde nichts abgebucht: «nichts belastet», eine Reservation wird freigegeben. Sind die Zahlungsdaten nicht
  geladen: «Falls du bereits bezahlt hast, …». Der Satz behauptet nie, die Rückerstattung sei schon ausgeführt.
- **Rückerstattung beim Stornieren:** Medusa erstattet abgebuchte Zahlungen beim Stornieren selbst (über
  `refundPaymentsWorkflow`). Dafür kommt **kein** `payment.refunded`, es geht also keine zweite Mail raus.
- **Betreiber:** kurze Mail an `ORDER_NOTIFICATION_TO` mit Zahlungsstand (abgebucht, erstattet, offen) und Link ins
  Admin. Steht dort «Offen», hat die Rückerstattung bei zahls.ch nicht geklappt und muss von Hand nachgeholt werden.
- **Keine Mail an die Kundin:** wenn die Bestellung keine E-Mail-Adresse hat oder das Event `no_notification` trägt
  (Medusa 2.13.6 schickt das bei `order.canceled` nicht mit, der Admin hat dafür keinen Schalter).
- **Kein Doppelversand:** Schlüssel `order-canceled:<Bestell-ID>` bzw. `order-canceled-notification:<Bestell-ID>:<n>`.
- **Fehler** brechen das Stornieren nicht ab. Sie stehen im Log unter `[order.canceled]` oder `[notify]`.

### Auf Staging testen

1. Testbestellung mit eigener E-Mail-Adresse aufgeben und bezahlen (zahls.ch im Testmodus).
2. Im Admin die Bestellung öffnen und stornieren.
3. Mail prüfen: Artikel, Betrag, Satz zum Zahlungsmittel. Betreiber-Mail: «abgebucht und vollständig erstattet». Im
   Log steht `[smtp] Vorlage "order-canceled" versendet.` Es darf keine Rückerstattungs-Mail dazukommen.
4. Wenn sich eine Bestellung ohne Abbuchung herstellen lässt (Zahlung nur autorisiert): stornieren, die Mail muss
   «nichts belastet» sagen.

## Rückerstattung

Die Mail geht raus, wenn im Admin eine Zahlung ganz oder teilweise zurückerstattet wird (Bestellung → Zahlung →
«Rückerstattung»). Medusa löst `payment.refunded` aus, mit der ID der **Zahlung**. Der Subscriber geht von dort über
die Payment Collection zur Bestellung.

- **Inhalt:** Bestellnummer, rückerstatteter Betrag in CHF, dass er auf das Zahlungsmittel zurückgeht, mit dem
  bezahlt wurde, und dass das ein paar Werktage dauern kann. Kontakt info@jibbit.ch.
- **Teilbeträge und mehrere Rückerstattungen:** Jede Rückerstattung bekommt eine eigene Mail mit ihrem Betrag. Weil
  das Event nur die Zahlung nennt, nimmt der Subscriber alle Rückerstattungen dieser Zahlung aus der letzten Stunde
  (`REFUND_WINDOW_MS`), sonst die jüngste.
- **Kein Doppelversand:** Schlüssel `refund-confirmation:<Refund-ID>`. Eine Rückerstattung, die schon eine Mail hat,
  bekommt keine zweite, auch wenn sie noch im Zeitfenster liegt.
- **Keine Mail:** wenn die Bestellung keine E-Mail-Adresse hat, wenn zur Zahlung keine Bestellung gehört oder das
  Event `no_notification` trägt.
- **Fehler** brechen die Rückerstattung nicht ab. Sie stehen im Log unter `[payment.refunded]` oder `[notify]`.

### Auf Staging testen

Achtung: Die Rückerstattung im Admin löst bei zahls.ch eine echte Rückerstattung aus. Nur mit Testzahlungen.

1. Testbestellung mit eigener E-Mail-Adresse aufgeben und bezahlen.
2. Im Admin bei der Zahlung einen Teilbetrag zurückerstatten. Mail prüfen: Teilbetrag, Bestellnummer.
3. Den Rest zurückerstatten. Es kommt eine zweite Mail mit dem zweiten Betrag, die erste nicht noch einmal.
   Im Log steht je `[smtp] Vorlage "refund-confirmation" versendet.`

## Einladung ins Admin

Die Mail geht raus, wenn im Admin unter Einstellungen → Benutzer jemand eingeladen wird (`invite.created`) oder die
Einladung erneut gesendet wird (`invite.resent`).

- **Inhalt:** Einladung auf Deutsch, Link auf `<MEDUSA_BACKEND_URL>/app/invite?token=…`, Gültigkeit (aus `expires_at`
  der Einladung gerechnet, Vorgabe von Medusa: 24 Stunden).
- **Link:** Die Basis kommt wie beim Passwort-Reset aus `MEDUSA_BACKEND_URL`, nie aus dem Request. Fehlt die
  Variable, geht keine Mail raus und im Log steht der Grund.
- **Token:** steht nur im Text der Mail, nicht in der Datenbank der Notifications und nicht im Log.
- **Kein Doppelversand:** Schlüssel `admin-invite:<Invite-ID>:<Ablaufzeit>`. Erneutes Senden setzt ein neues
  Ablaufdatum und lässt damit eine neue Mail durch.
- **Keine Mail:** wenn die Einladung schon angenommen ist oder Adresse oder Token fehlen.

### Auf Staging testen

1. Im Admin unter Einstellungen → Benutzer eine eigene zweite Adresse einladen.
2. Mail prüfen, Link öffnen: Er muss auf die Einladungsseite des Admins führen und das Anlegen des Zugangs erlauben.
3. Bei einer zweiten Einladung «Einladung erneut senden» wählen: Es kommt eine neue Mail mit neuem Link.

## Was noch fehlt

Nicht umgesetzt. Die Events gibt es in Medusa 2.13.6, es fehlt jeweils der Subscriber.

| Mail | An | Event |
|---|---|---|
| Sendung storniert | Kundin | `order.fulfillment_canceled` |
| Sendung zugestellt | Kundin | `delivery.created` |
| Konto erstellt / Willkommen | Kundin | `customer.created` |
| Bestellung an anderes Konto übertragen | Kundin | `order.transfer_requested` |
| Zahlung eingegangen | Betreiber | `payment.captured` |
| Rückerstattung | Betreiber | `payment.refunded` |

Rücksendung, Umtausch und Reklamation (`order.return_requested`, `order.exchange_created`, `order.claim_created`)
haben ebenfalls keine Mail. Ohne Rückgaberecht (AGB §9) braucht es sie vorerst nicht.
