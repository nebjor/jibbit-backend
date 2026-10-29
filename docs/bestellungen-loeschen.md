# Bestellungen löschen

Im Admin steht am Ende jeder Bestelldetailseite ein roter Kasten
«Gefahrenzone» mit der Schaltfläche «Bestellung endgültig löschen». Gedacht
ist das für **Testbestellungen**. Medusas eigenes «Stornieren» geht bei einer
Bestellung mit versandter Lieferung nicht («All fulfillments must be canceled
before canceling an order»), und eine versandte Lieferung lässt sich nicht
stornieren.

Code: `backend/src/lib/bestellung-loeschen.ts` (Regeln),
`backend/src/workflows/bestellung-loeschen/` (Ablauf),
`backend/src/api/admin/orders/[id]/loeschen/` (API),
`backend/src/admin/widgets/bestellung-loeschen-widget.tsx` (Oberfläche).

## Wann benutzen

- Testbestellung, die aus Listen, Dashboard und Buchhaltung verschwinden soll.
- **Nicht** für bezahlte Bestellungen echter Kunden. Die gehören zu den
  Belegen (Aufbewahrung, siehe unten): dort stornieren und zurückerstatten.

## Was passiert (in dieser Reihenfolge)

Der Dialog zeigt die Folgen vorher an; die Zahlen kommen vom Server.

1. **Offene Lieferungen** (nicht versandt) werden storniert. Medusa legt dabei
   Bestand und Reservierung zurück.
2. **Versandte Lieferungen** bleiben unverändert (Ware ist beim Kunden). Mit
   dem Häkchen «Ware ist zurück im Lager» wird die versandte Menge wieder zum
   Bestand addiert, am Lagerort der Lieferung. Ohne Häkchen bleibt der Bestand
   wie er ist.
3. **Restliche Reservierungen** der Bestellung werden gelöscht.
4. **Nicht erfasste Zahlungen** (nur autorisiert) werden beim Zahlungsanbieter
   abgebrochen.
5. **Erfasste Zahlungen**:
   - Häkchen «Zahlung zurückerstatten» **gesetzt**: der noch nicht erstattete
     Betrag geht über zahls.ch an den Kunden zurück (echtes Geld; Medusa
     verschickt dazu die übliche Rückerstattungs-Mitteilung).
   - **Nicht gesetzt** (Vorgabe, Testbestellung): keine Rückerstattung. Das Geld
     bleibt beim Shop, gelöscht wird nur die Bestellung. Medusas
     «Stornieren» kann das nicht, es erstattet immer; deshalb setzt der
     Workflow die Schritte selbst zusammen.
6. **Weiches Löschen**: die Bestellung bekommt `deleted_at` (samt Positionen,
   Summen, Versandarten). Abfragen von Medusa, Dashboard und Buchhaltung
   (`query.graph`) blenden solche Zeilen aus. Es wird keine Bestellung
   storniert und keine Stornierungs-Mail verschickt.

Bestätigung: Der Server verweigert das Löschen, wenn die Bestellnummer nicht
eingegeben wurde. Im Log steht eine Zeile `[bestellung-loeschen]` mit
Bestell-ID, Benutzer und Zahlen, ohne Personendaten.

## Was nicht rückgängig geht

- Eine **Rückerstattung** ist beim Zahlungsanbieter ausgeführt.
- Eine **stornierte Lieferung** lässt sich nicht wieder aufnehmen.
- Das Löschen selbst ist in der Oberfläche nicht umkehrbar. In der Datenbank
  bleiben die Zeilen mit `deleted_at` erhalten; Wiederherstellen ist nur über
  Medusa (`restoreOrders`) oder von Hand möglich, nicht per Klick.
- Die Bestellnummer wird nicht neu vergeben (fortlaufende Zählung).

Scheitert ein Schritt, bevor die Rückerstattung läuft, werden Lagerbuchung und
Reservierungen zurückgerollt. Stornierte offene Lieferungen bleiben storniert
(harmlos, die Bestellung besteht dann ohne offene Lieferung weiter).
Scheitert die Rückerstattung, wird nichts gelöscht.

## Buchhaltung

Rechnungen und Belege müssen in der Schweiz zehn Jahre aufbewahrt werden. Eine
bezahlte Bestellung eines echten Kunden darf deshalb nicht verschwinden:
stornieren und zurückerstatten, damit die Gegenbuchung sichtbar bleibt. Das
Löschen ist für Testbestellungen gedacht; wird eine echte, bezahlte Bestellung
gelöscht, fehlt sie im Bericht, und der Zahlungseingang bei zahls.ch hat dann
keinen Beleg mehr im Shop. Im Zweifel die Treuhänderin fragen.

## Direkter Datenbankzugriff

Für Auswertungen und Kontrolle kann die Datenbank direkt abgefragt werden.
Auf dem Server (Verzeichnis mit der `docker-compose.yml`):

```
docker compose exec postgres psql -U medusa medusa
```

Beenden mit `\q`. Nützlich: `\dt` (Tabellen), `\d order` (Spalten einer Tabelle).

**Zuerst eine Sicherung ziehen**, bevor etwas geschrieben wird:

```
docker compose exec -T postgres pg_dump -U medusa -Fc medusa > /root/medusa-$(date +%F-%H%M).dump
```

Sicheres, nur lesendes Beispiel: die letzten Bestellungen, auch gelöschte:

```sql
SELECT display_id, status, created_at, deleted_at
FROM "order"
ORDER BY display_id DESC
LIMIT 10;
```

Nur lesen (`SELECT`) ist gefahrlos. Mit `BEGIN;` beginnen und mit `ROLLBACK;`
enden, wenn man etwas ausprobieren will.

### Warum kein `DELETE` auf die Bestelltabellen

Eine Bestellung hängt über Module hinweg an vielen Stellen, und viele davon
sind nur lose verknüpft (ohne Fremdschlüssel der Datenbank):

- Positionen, Summen, Versandarten, Transaktionen: eigene Tabellen mit
  Versionen.
- Lieferungen (Fulfillment-Modul), Zahlungen und Zahlungssammlungen
  (Payment-Modul), Kundenverknüpfung: andere Module, verbunden über
  Link-Tabellen.
- **Reservierungen und Lagerbestand** (Inventory-Modul): ein `DELETE` auf die
  Bestellung lässt Reservierungen stehen, die Ware dauerhaft als «reserviert»
  blockieren, und bucht versandte Ware nicht zurück.
- Zahlungen bei zahls.ch lassen sich per SQL weder stornieren noch erstatten.

Folgen sind verwaiste Zeilen, Fehler im Admin («not found» bei verknüpften
Daten), falsche Lagerzahlen und Berichte, die nicht mehr stimmen. Darum der
Weg über die Schaltfläche: sie räumt in der richtigen Reihenfolge auf.
Geschrieben wird per SQL nur nach Sicherung, nur in einer Transaktion
(`BEGIN; … ROLLBACK;` zum Prüfen, erst dann `COMMIT;`) und nur mit einer
Abfrage, deren Wirkung vorher als `SELECT` mit derselben `WHERE`-Bedingung
geprüft wurde.
