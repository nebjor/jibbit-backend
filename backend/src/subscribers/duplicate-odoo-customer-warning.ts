import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { isOdooImport } from "../lib/odoo-login-claim"

/**
 * Sicherheitsnetz für den Odoo-Umzug: meldet, wenn zu einer Adresse ZWEI
 * Kundendatensätze entstanden sind.
 *
 * ─── WARUM DAS PASSIEREN KANN ─────────────────────────────────────────────
 *
 * Medusas Unique-Index auf `customer` geht über `(email, has_account)`, nicht
 * über `email` allein. Importierte Datensätze haben `has_account = false`.
 * Registriert sich dieselbe Person danach selbst, ist `(email, true)` eine
 * andere Zeile — die Datenbank lässt sie zu, und ab da hängen Bestellhistorie
 * und Adressen am einen, das Konto am anderen Datensatz. Beide sind gültig,
 * nichts schlägt fehl, niemand merkt etwas.
 *
 * ─── WARUM HIER NUR GEWARNT UND NICHT ZUSAMMENGEFÜHRT WIRD ────────────────
 *
 * Zwei Datensätze automatisch zu verschmelzen hiesse zu entscheiden, welche
 * Adressen gelten und an welchen Kunden die alten Bestellungen gehen. Das ist
 * eine kaufmännische Entscheidung, keine technische — ein falsch
 * zusammengeführtes Konto ist schlimmer als ein gemeldetes. Der Fall gehört
 * in den Admin, und `prepare-odoo-logins.ts` zählt ihn beim nächsten Lauf als
 * "Konflikt".
 *
 * ─── DER EIGENTLICHE SCHUTZ ───────────────────────────────────────────────
 *
 * ist `prepare-odoo-logins.ts`, direkt nach dem Kundenimport und VOR dem
 * DNS-Umzug. Danach hat jede importierte Adresse eine emailpass-Identität,
 * und eine Registrierung mit derselben Adresse scheitert an Medusas eigenem
 * "Identity with email already exists" — es kann gar kein Duplikat mehr
 * entstehen. Dieser Subscriber ist für den Fall, dass dieser Schritt vergessen
 * wurde.
 */
export default async function duplicateOdooCustomerWarning({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  if (!data?.id) return

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService = container.resolve(Modules.CUSTOMER)

  try {
    const customer = await customerService.retrieveCustomer(data.id, {
      select: ["id", "email", "has_account"],
    })
    // Nur der neu registrierte Fall ist interessant. Der Import selbst legt
    // Datensätze ohne Konto an und würde sonst bei jedem Datensatz warnen.
    if (!customer?.email || !customer.has_account) return

    const gleiche = await customerService.listCustomers(
      { email: customer.email },
      { select: ["id", "has_account", "metadata"], take: 10 },
    )

    const importiert = gleiche.find(
      (c) =>
        c.id !== customer.id &&
        isOdooImport(c.metadata as Record<string, unknown> | null),
    )
    if (!importiert) return

    // Ohne die E-Mail-Adresse im Log: die beiden IDs genügen, um den Fall im
    // Admin zu finden, und eine Adresse in einer Logdatei löscht niemand mehr.
    logger.warn(
      `[odoo] Doppelter Kunde: neues Konto ${customer.id} zur selben Adresse wie der ` +
        `importierte Datensatz ${importiert.id}. Bestellhistorie und Adressen hängen am ` +
        `importierten. Im Admin zusammenführen — und prüfen, ob ` +
        `prepare-odoo-logins.ts nach dem Import gelaufen ist.`,
    )
  } catch (err) {
    logger.warn(
      `[odoo] Dublettenprüfung fehlgeschlagen: ${
        err instanceof Error ? err.name : "unbekannter Fehler"
      }`,
    )
  }
}

export const config: SubscriberConfig = {
  event: "customer.created",
}
