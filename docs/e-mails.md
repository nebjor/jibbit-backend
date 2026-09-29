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
| Passwort zurücksetzen | Kundin | `auth.password_reset` (`actor_type: customer`) | `password-reset.ts` | `customer-password-reset` |
| Passwort zurücksetzen | Admin-Benutzer | `auth.password_reset` (`actor_type: user`) | `password-reset.ts` | `admin-password-reset` |

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

### Auf Staging testen

1. Testbestellung mit einer eigenen E-Mail-Adresse aufgeben.
2. Im Admin die Bestellung öffnen, Fulfillment anlegen, dann «Als versendet markieren», Sendungsnummer eintragen,
   «Benachrichtigung senden» eingeschaltet lassen.
3. Mail prüfen: Artikel, Adresse, Link zur Sendungsverfolgung. Im Log steht `[smtp] Vorlage "shipping-confirmation" versendet.`
4. Zweite Bestellung ohne Sendungsnummer versenden, dritte mit abgeschalteter Benachrichtigung (es darf keine Mail kommen).

## Was noch fehlt

Nicht umgesetzt. Die Events gibt es in Medusa 2.13.6, es fehlt jeweils der Subscriber.

| Mail | An | Event |
|---|---|---|
| Bestellung storniert | Kundin | `order.canceled` |
| Rückerstattung | Kundin | `payment.refunded` |
| Sendung storniert | Kundin | `order.fulfillment_canceled` |
| Sendung zugestellt | Kundin | `delivery.created` |
| Konto erstellt / Willkommen | Kundin | `customer.created` |
| Einladung für Admin-Benutzer | neue Mitarbeitende | `invite.created`, `invite.resent` |
| Bestellung an anderes Konto übertragen | Kundin | `order.transfer_requested` |
| Zahlung eingegangen | Betreiber | `payment.captured` |
| Bestellung storniert oder rückerstattet | Betreiber | `order.canceled`, `payment.refunded` |

Rücksendung, Umtausch und Reklamation (`order.return_requested`, `order.exchange_created`, `order.claim_created`)
haben ebenfalls keine Mail. Ohne Rückgaberecht (AGB §9) braucht es sie vorerst nicht.
