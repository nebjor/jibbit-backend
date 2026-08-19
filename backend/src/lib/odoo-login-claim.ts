/**
 * Entscheidungstabelle: Wie wird ein aus Odoo importierter Kunde anmeldefähig?
 *
 * Als reine Funktion, ohne Container und ohne Datenbank — die Regeln sind
 * das, was hier schiefgehen kann, nicht das Schreiben. Getestet in
 * `src/__tests__/odoo-login-claim.unit.spec.ts`.
 *
 * ─── DAS PROBLEM IN ZWEI TEILEN ───────────────────────────────────────────
 *
 * (1) Ein importierter Kunde OHNE `provider_identity` kommt nie wieder in sein
 *     Konto. `generateResetPasswordTokenWorkflow` sucht zuerst die
 *     Provider-Identität und wirft, wenn es keine gibt; die Store-Route läuft
 *     mit `throwOnError: false` und antwortet trotzdem mit 201. Aus Sicht der
 *     Kundin sieht "Passwort vergessen" also normal aus — es kommt nur nie
 *     eine E-Mail. Für immer, ohne Fehlermeldung irgendwo.
 *
 * (2) Medusas Unique-Index auf `customer` geht über `(email, has_account)`,
 *     nicht über `email` allein (siehe `@medusajs/customer` Model). Importierte
 *     Datensätze haben `has_account = false`. Registriert sich derselbe Mensch
 *     danach neu, entsteht eine ZWEITE Zeile mit derselben Adresse und
 *     `has_account = true` — Bestellhistorie und Adressen bleiben an der
 *     ersten hängen, und niemand merkt es, weil beide Zeilen gültig sind.
 *
 * Beides zusammen heisst: der Umzug braucht einen ausdrücklichen Schritt, der
 * bestehende Datensätze ÜBERNIMMT statt neue anzulegen. Genau das entscheidet
 * diese Funktion.
 */

/** Was von einem vorhandenen Kundendatensatz gebraucht wird. */
export interface MatchedCustomer {
  id: string
  hasAccount: boolean
}

/** Was von einer vorhandenen emailpass-Identität gebraucht wird. */
export interface MatchedIdentity {
  authIdentityId: string
  /** `app_metadata.customer_id`, falls gesetzt. */
  customerId: string | null
}

export interface ClaimInput {
  /**
   * Der importierte Datensatz — gefunden über `metadata.odoo_partner_id` oder
   * über die Adresse mit `has_account = false`.
   */
  imported: MatchedCustomer | null
  /**
   * Ein bereits registrierter Datensatz zur selben Adresse
   * (`has_account = true`). Entsteht, wenn sich jemand nach dem Import selbst
   * ein Konto angelegt hat.
   */
  registered: MatchedCustomer | null
  /** Die emailpass-Identität zur Adresse, falls vorhanden. */
  identity: MatchedIdentity | null
}

export type ClaimDecision =
  /** Nichts zu tun — Identität vorhanden und verknüpft. */
  | { action: "skip"; reason: "bereits-anmeldefaehig" }
  /**
   * Kunde und Identität sind da, nur nicht miteinander verbunden. Nur die
   * Verknüpfung setzen, kein neues Passwort.
   */
  | { action: "link"; customerId: string; authIdentityId: string }
  /**
   * Kunde da, Identität fehlt: Identität mit Zufallspasswort anlegen,
   * verknüpfen, und `has_account` nachziehen, falls noch nicht gesetzt.
   */
  | { action: "claim"; customerId: string; setHasAccount: boolean }
  /** Weder Kunde noch Identität — regulär anlegen. */
  | { action: "create" }
  /**
   * Zwei Datensätze zur selben Adresse. Hier wird NICHT geraten: welcher der
   * richtige ist, hängt an Bestellungen und Adressen, und ein falsch
   * zusammengeführtes Konto ist schlimmer als ein gemeldetes.
   */
  | { action: "conflict"; reason: "doppelter-kunde" }

export function decideClaim(input: ClaimInput): ClaimDecision {
  const { imported, registered, identity } = input

  // 1. Schon fertig. Häufigster Fall beim zweiten Lauf desselben Scripts —
  //    das Script muss wiederholbar sein, sonst traut sich niemand, es am
  //    Umzugstag ein zweites Mal zu starten.
  if (identity?.customerId) {
    return { action: "skip", reason: "bereits-anmeldefaehig" }
  }

  // 2. Zwei Zeilen zur selben Adresse. Das ist genau der Zustand, den (2) oben
  //    beschreibt. Melden, nicht selbst auflösen.
  if (imported && registered && imported.id !== registered.id) {
    return { action: "conflict", reason: "doppelter-kunde" }
  }

  const target = registered ?? imported

  // 3. Identität vorhanden, aber ohne `app_metadata.customer_id`.
  //
  //    ACHTUNG, das ist der gefährliche Zustand: eine Identität mit leerem
  //    `app_metadata` gilt Medusas emailpass-Provider als "noch nicht
  //    beansprucht" und wird von `register()` KOMMENTARLOS mit einem neuen
  //    Passwort überschrieben — ohne jede Bestätigung per E-Mail. Wer die
  //    Adresse kennt, könnte sich damit einfach "registrieren" und das Konto
  //    übernehmen. Deshalb wird hier nur verknüpft und das vorhandene
  //    Passwort nicht angefasst: die Verknüpfung ist es, die den Zustand
  //    schliesst.
  if (identity && target) {
    return { action: "link", customerId: target.id, authIdentityId: identity.authIdentityId }
  }

  // 4. Kunde da, Identität fehlt — der Normalfall nach einem Import, der nur
  //    Kundendatensätze angelegt hat.
  if (target) {
    return { action: "claim", customerId: target.id, setHasAccount: !target.hasAccount }
  }

  // 5. Nichts da.
  return { action: "create" }
}
