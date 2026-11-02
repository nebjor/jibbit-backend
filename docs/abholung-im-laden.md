# Abholung im Laden

jibbit hat ein Ladenlokal: **Unterwegli 1, 8404 Winterthur**, Mo–Fr 09:00–17:00 (identisch mit dem
Google-Unternehmensprofil). Onlinebestellungen können dort gratis abgeholt werden. Entscheid des Inhabers vom
2026-10-05.

## Wie es in Medusa aussieht

Die Abholung ist eine gewöhnliche **Shipping Option** auf derselben Service-Zone («Schweiz») wie der Versand, mit
demselben Provider (`swiss-shipping_swiss-shipping`) und demselben Versandprofil:

| Feld | Wert |
|---|---|
| Name | `Abholung im Laden` |
| `price_type` | `flat`, Preis 0 (CHF und Region Schweiz) |
| `type` | `{ label: "Abholung", code: "pickup" }` |
| `data` | `{ id: "swiss-pickup", pickup: true, address: "Unterwegli 1, 8404 Winterthur" }` |
| `metadata` | `{ pickup: true, address: "Unterwegli 1, 8404 Winterthur" }` |
| Regeln | `enabled_in_store = true`, `is_return = false` (wie der Versand) |

Auf Staging (`api-test.jibbit.ch`, Datenbank wird Produktion) ist sie angelegt: `so_01M45H9J4SFSZ6WMABCR0BBNER`.
Der Seed (`backend/src/scripts/seed.ts`) legt sie auf einer frischen Installation an und holt sie auf einer
bestehenden beim nächsten Lauf nach (Prüfung über `type.code`/`data.pickup`, nicht über den Namen).

**Bewusst kein Fulfillment-Set vom Typ `pickup`.** Medusa kennt an einem Lager Fulfillment-Sets vom Typ `shipping`
und `pickup`. Ein eigenes Pickup-Set brächte eine zweite Service-Zone und einen anderen Reiter im Admin, sonst nichts:
Die Store-API liefert die Option so oder so in derselben Liste (`GET /store/shipping-options?cart_id=…`), der Preis
ist so oder so 0, und Storefront wie Mails lesen die Marker an der Option. Sollte das Lager einmal nicht der Laden
sein (zwei Standorte), ist der Umzug in ein Pickup-Set am zweiten Lager der richtige Schritt — dann trägt die Option
dieselben Marker und nichts im Code muss sich ändern.

## Woran die Abholung erkannt wird — nie am Namen

Drei Marker, alle in `backend/src/lib/pickup.ts`:

1. **`shipping_method.data.pickup === true`.** Der Provider stempelt ihn beim Hinzufügen zum Warenkorb
   (`validateFulfillmentData` in `src/modules/swiss-shipping/service.ts`, Medusa ruft das für jede Option), die
   Storefront schickt ihn zusätzlich mit. Medusa kopiert `data` beim Abschluss auf die Bestellung, die Store-API gibt
   es mit `GET /store/orders/:id` zurück. Das ist der Weg, den die Bestellseite der Storefront nimmt.
2. **`order.metadata.pickup === true`.** Setzt die Storefront als Cart-Metadatum, Medusa kopiert es auf die Bestellung.
3. **Die Option selbst:** `type.code === "pickup"` oder `metadata.pickup === true` oder `data.id === "swiss-pickup"`.
   Dafür lädt `resolvePickup()` die Shipping Options der Versandmethoden nach — der Rückfall, falls jemand die Option im
   Admin ohne `data` neu anlegt.

Scheitert das Nachladen, gilt die Bestellung als Versand; eine Mail fällt deshalb nie aus.

## Was im Admin zu tun ist (Ablauf für das Team)

1. Bestellung kommt rein: Die Betreiber-Mail trägt «– Abholung im Laden» im Betreff und den Hinweis «nicht versenden»,
   der ntfy-Push ebenfalls. Die Kundin bekommt die Bestellbestätigung mit «wir melden uns, sobald die Bestellung
   abholbereit ist», Ladenadresse und Abholzeiten.
2. Ware bereitlegen.
3. **Als abholbereit melden** = im Admin wie beim Versand: Bestellung → **Fulfillment anlegen** → **«Als versendet
   markieren»**, Sendungsnummer leer lassen, «Benachrichtigung senden» eingeschaltet lassen. Medusa löst
   `shipment.created` aus, der Subscriber erkennt die Abholung und schickt statt der Versandbestätigung die
   **Abholbereit-Mail** (`pickup-ready`): Artikel, Laden, Abholzeiten, «Bestellbestätigung mitnehmen», keine
   Sendungsnummer.
4. Kundin holt ab. Medusa hat dafür keinen eigenen Zustand; die Bestellung gilt nach Schritt 3 als «fulfilled».

Es gibt in Medusa 2.13 keinen Knopf «abholbereit» — «Als versendet markieren» ist dieser Knopf. Wer das später sauberer
will, baut ein Admin-Widget, das denselben Workflow (`createOrderShipmentWorkflow`) mit anderer Beschriftung ausführt.

## Lieferadresse einer Abholbestellung

Medusa verlangt für jede Shipping Option eine Lieferadresse im Liefergebiet der Service-Zone. Die Storefront füllt
sie bei Abholung mit Name und Telefon der Kundin und der Ladenadresse. Folge: Im Admin steht als Lieferadresse der
Laden. Die Kundenmails zeigen diese Adresse deshalb **nicht** als «Lieferadresse», sondern den Block «Abholung im
Laden» mit Adresse und Abholzeiten (`deliveryBlock()` in `order-notification.ts`).

## Adresse und Zeiten ändern

Adresse und Abholzeiten stehen an drei Orten, alle müssen mit:

- `backend/src/lib/pickup.ts` (`PICKUP_ADDRESS_LINES`, `PICKUP_HOURS`) — die Mails,
- die Shipping Option im Admin (`data.address`, `type.description`) — nur Freitext, nirgends ausgewertet,
- `jibbit-frontend/lib/config.ts` (`BUSINESS`, `PICKUP`) — Kasse, Bestellseite, /service/versand, FAQ, Kontakt,
  JSON-LD (`Store` mit `openingHoursSpecification`).

Und das Google-Unternehmensprofil, von dem die Zeiten stammen.

## Offen / bekannt

- Die zweite Option «Free Shipping» (`so_01M206SVAWJGGGGXNYB97VFTSS`, flat 0 mit `item_total >= 69`-Regel) ist ein
  Überbleibsel vom 2026-09-08 — die Regel wertet in 2.13.6 falsch aus (Kommentar im Seed). Sie wurde hier nicht
  angefasst (kein Löschen über die Admin-API aus dem Agenten). Prüfen und im Admin löschen.
- Die Lageradresse im Admin heisst «Wintethur» (Tippfehler), Lager «Jibbit Headquarter». Nur kosmetisch; die
  Storefront liest die Adresse aus `lib/config.ts`.
