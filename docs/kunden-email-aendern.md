# E-Mail-Adresse eines Kunden korrigieren

Für den Fall, dass sich jemand beim Bestellen oder Registrieren bei der E-Mail-Adresse vertippt hat.

## Warum das Admin es nicht zulässt

Das Formular «Bearbeiten» auf der Kundenseite sperrt das Feld E-Mail, sobald der Kunde ein Konto hat
(`has_account = true`). Die Sperre sitzt im Dashboard (`@medusajs/dashboard`,
`routes/customers/customer-edit/components/edit-customer-form/edit-customer-form.tsx`: das Feld ist `disabled`, und
beim Speichern wird `email` weggelassen). Die Admin-API selbst (`POST /admin/customers/:id`) würde die Adresse annehmen,
aber nur am Kundendatensatz ändern. Das reicht nicht, weil die Adresse an drei Orten steht:

| Ort | Wofür |
|---|---|
| `customer.email` | Anzeige und Suche im Admin, Vorgabe für neue Bestellungen |
| `provider_identity.entity_id` (Provider `emailpass`) | Anmeldung und Empfänger von «Passwort vergessen» |
| `order.email` | Empfänger von Versandbestätigung, Storno- und Rückerstattungs-Mail dieser Bestellung |

Das Passwort steht als Hash in `provider_identity.provider_metadata`, die Verknüpfung zum Kunden in
`auth_identity.app_metadata.customer_id`. In beiden steht die Adresse nicht. Mehr dazu in
`docs/odoo-datenmigration.md`, Abschnitt 7.

## Was die Funktion macht

Widget «E-Mail-Adresse korrigieren» auf der Kundenseite, Route `POST /admin/customers/:id/email`, Workflow
`aendere-kunden-email`.

- Die neue Adresse wird getrimmt, klein geschrieben und geprüft.
- Geändert wird `customer.email` und, falls der Kunde eine Anmeldung mit E-Mail und Passwort hat, deren `entity_id`.
  Das Passwort und die Verknüpfung zum Kunden bleiben. Die Kundin meldet sich danach mit der neuen Adresse und dem
  alten Passwort an; «Passwort vergessen» geht an die neue Adresse.
- Mit Haken «Auch auf offenen Bestellungen setzen» (Vorgabe: an) bekommen die offenen Bestellungen des Kunden die neue
  Adresse. Offen heisst: nicht abgeschlossen, nicht storniert, nicht archiviert, kein Entwurf, mindestens ein Artikel
  noch nicht versendet, und höchstens 90 Tage alt (`BESTELLUNG_MAX_ALTER_TAGE`).
- Mit Haken «Kurze Mitteilung» (Vorgabe: an) geht eine Mail an die **neue** Adresse (Vorlage
  `customer-email-corrected`). An die alte Adresse geht nichts.
- Alles oder nichts: Scheitert ein Schritt, werden die vorherigen zurückgenommen.
- Im Log steht, welcher Kunde von welchem Admin-Benutzer geändert wurde und wie viele Bestellungen, unter
  `[kunden-email]`. Adressen stehen nicht im Log. Die neue Adresse wird im Body gesendet, nie in der URL.

## Was sie bewusst nicht macht

- **Keine Kunden zusammenführen.** Gehört die neue Adresse schon zu einem anderen Kunden mit demselben Stand (beide mit
  Konto oder beide ohne), oder ist sie schon die Anmeldung von jemand anderem (auch eines Admin-Benutzers), wird
  nichts geändert. Die Meldung nennt die ID des anderen Kunden.
- **Nur ein Hinweis, keine Sperre**, wenn es einen zweiten Datensatz mit der Adresse gibt, der den anderen Stand hat
  (einer mit Konto, einer ohne). Medusa lässt das zu; die Bestellungen bleiben getrennt.
- **Abgeschlossene, stornierte, vollständig versendete und alte Bestellungen bleiben unverändert.** Sie sind Belege.
- **Offene Warenkörbe werden nicht angepasst.** Bestellt die Kundin aus einem alten Warenkorb, kann die alte Adresse
  noch einmal auf einer Bestellung landen. Dann die Funktion noch einmal mit derselben Adresse ausführen: sie holt
  nach, was noch nicht stimmt.
- **Niemand wird abgemeldet.** Das Anmelde-Token enthält die ID des Kunden und der Anmeldung, nicht die Adresse
  (`generateJwtTokenForAuthIdentity` in `@medusajs/medusa`). Eine angemeldete Kundin bleibt angemeldet und sieht die
  neue Adresse. Ein Link aus «Passwort vergessen», der vor der Korrektur verschickt wurde, enthält die alte Adresse
  und gilt danach nicht mehr (er wäre ohnehin nur 15 Minuten gültig).
- **Kein Verlauf.** Die alte Adresse wird nirgends aufbewahrt.
- **Keine Route für den Shop.** Kundinnen können ihre Adresse damit nicht selbst ändern.

## So geht es

1. Im Admin den Kunden öffnen, unten beim Widget «E-Mail-Adresse korrigieren» auf «Korrigieren».
2. Neue Adresse eingeben, Haken nach Bedarf setzen, «Prüfen».
3. Die Übersicht zeigt, was geändert wird und wie viele Bestellungen die neue Adresse bekommen. Steht dort ein
   Konflikt, wurde nichts geändert: zuerst klären, welcher Kundendatensatz gilt.
4. «Speichern».

Hat ein Kunde ohne Konto mehrere Bestellungen unter verschiedenen Kundendatensätzen, jeden einzeln korrigieren.
