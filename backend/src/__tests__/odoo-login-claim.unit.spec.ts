/**
 * Die Entscheidungstabelle für den Odoo-Umzug.
 *
 * Zwei Fehler, die man einem Import nicht ansieht, hängen an genau diesen
 * Regeln:
 *
 *   - Ein importierter Kunde ohne `provider_identity` bekommt nie eine
 *     Reset-E-Mail. Die Route antwortet trotzdem mit 201.
 *   - Medusas Unique-Index geht über `(email, has_account)`. Wird der
 *     bestehende Datensatz nicht übernommen, entsteht eine zweite Zeile mit
 *     derselben Adresse — und die Bestellhistorie bleibt an der ersten.
 *
 * Beides erzeugt keinen Fehler und keinen Logeintrag. Deshalb hier.
 */

import { decideClaim } from "../lib/odoo-login-claim"

const IMPORTIERT = { id: "cus_import", hasAccount: false }
const REGISTRIERT = { id: "cus_selbst", hasAccount: true }

describe("decideClaim", () => {
  it("legt neu an, wenn es zur Adresse noch gar nichts gibt", () => {
    expect(
      decideClaim({ imported: null, registered: null, identity: null }),
    ).toEqual({ action: "create" })
  })

  it("übernimmt den importierten Datensatz, statt einen zweiten anzulegen", () => {
    // Der Kern von Befund (2): eine Neuanlage wäre erlaubt — (email, false)
    // und (email, true) verletzen den Unique-Index nicht — und würde die
    // Bestellhistorie vom Konto abhängen.
    expect(
      decideClaim({ imported: IMPORTIERT, registered: null, identity: null }),
    ).toEqual({ action: "claim", customerId: "cus_import", setHasAccount: true })
  })

  it("zieht has_account nach, aber nur wenn es fehlt", () => {
    const schonKonto = decideClaim({
      imported: null,
      registered: REGISTRIERT,
      identity: null,
    })
    expect(schonKonto).toEqual({
      action: "claim",
      customerId: "cus_selbst",
      setHasAccount: false,
    })
  })

  it("verknüpft eine vorhandene, aber unbeanspruchte Identität, statt sie zu überschreiben", () => {
    // Eine Identität mit leerem app_metadata gilt emailpass als "claimable"
    // und wird von register() kommentarlos mit neuem Passwort überschrieben —
    // ohne Bestätigung per E-Mail. Wer die Adresse kennt, könnte das Konto
    // übernehmen. Nur zu verknüpfen schliesst diesen Zustand.
    expect(
      decideClaim({
        imported: IMPORTIERT,
        registered: null,
        identity: { authIdentityId: "au_1", customerId: null },
      }),
    ).toEqual({ action: "link", customerId: "cus_import", authIdentityId: "au_1" })
  })

  it("lässt in Ruhe, was schon anmeldefähig ist — das Script muss wiederholbar sein", () => {
    expect(
      decideClaim({
        imported: IMPORTIERT,
        registered: null,
        identity: { authIdentityId: "au_1", customerId: "cus_import" },
      }),
    ).toEqual({ action: "skip", reason: "bereits-anmeldefaehig" })

    // Auch dann, wenn gar kein Kundendatensatz mehr gefunden wird — die
    // Verknüpfung ist die Wahrheit, nicht unsere Suche.
    expect(
      decideClaim({
        imported: null,
        registered: null,
        identity: { authIdentityId: "au_1", customerId: "cus_x" },
      }),
    ).toEqual({ action: "skip", reason: "bereits-anmeldefaehig" })
  })

  it("meldet zwei Datensätze zur selben Adresse, statt zu raten", () => {
    // Entsteht, wenn sich jemand nach dem Import selbst registriert hat.
    // Welcher der richtige ist, hängt an Bestellungen und Adressen — ein
    // falsch zusammengeführtes Konto ist schlimmer als ein gemeldetes.
    expect(
      decideClaim({ imported: IMPORTIERT, registered: REGISTRIERT, identity: null }),
    ).toEqual({ action: "conflict", reason: "doppelter-kunde" })
  })

  it("meldet die Dublette AUCH DANN, wenn die Anmeldung längst funktioniert", () => {
    // Der reale Ablauf, gegen ein lokales Medusa nachgestellt: Import ohne
    // Vorbereitung, danach registriert sich derselbe Mensch selbst. Die
    // Identität zeigt sauber auf den neuen Datensatz, die Anmeldung geht —
    // und daneben liegt die zweite Zeile mit der ganzen Bestellhistorie.
    //
    // Eine Erfolgsprüfung vor der Dublettenprüfung meldete hier "alles in
    // Ordnung". Genau das ist der Fehler, den dieses Script finden soll.
    expect(
      decideClaim({
        imported: IMPORTIERT,
        registered: REGISTRIERT,
        identity: { authIdentityId: "au_1", customerId: REGISTRIERT.id },
      }),
    ).toEqual({ action: "conflict", reason: "doppelter-kunde" })
  })

  it("meldet keinen Konflikt, wenn beide Treffer derselbe Datensatz sind", () => {
    const selbe = { id: "cus_1", hasAccount: true }
    expect(
      decideClaim({ imported: selbe, registered: selbe, identity: null }),
    ).toEqual({ action: "claim", customerId: "cus_1", setHasAccount: false })
  })

  it("bevorzugt den registrierten Datensatz, wenn nur einer da ist", () => {
    const d = decideClaim({
      imported: null,
      registered: REGISTRIERT,
      identity: { authIdentityId: "au_1", customerId: null },
    })
    expect(d).toEqual({
      action: "link",
      customerId: "cus_selbst",
      authIdentityId: "au_1",
    })
  })
})
