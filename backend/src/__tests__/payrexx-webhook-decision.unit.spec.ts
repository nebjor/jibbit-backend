/**
 * Entscheidungslogik: Payrexx-Transaktion → Medusa-Aktion.
 *
 * `decideAction()` ist rein — kein Netz, kein Redis, keine Signatur. Damit
 * ist die Statustabelle direkt prüfbar, inklusive der beiden Fälle, die
 * SECURITY-NOTES.md als offen dokumentiert hatte: der Betragsabgleich gegen
 * den aktuell gültigen Gateway und die Behandlung von Rückerstattungen.
 */

import { decideAction, extractTransaction } from "../modules/payrexx/webhook"
import type { PayrexxSessionState } from "../modules/payrexx/session-store"

const SESSION = "payses_01HTEST"

function tx(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    status: "confirmed",
    amount: 4200, // CHF 42.00 in Rappen
    referenceId: SESSION,
    ...overrides,
  }
}

const CURRENT_GATEWAY: PayrexxSessionState = {
  gatewayId: 900,
  amountInRappen: 4200,
  currency: "CHF",
}

describe("decideAction — Status-Tabelle", () => {
  it("authorizes a confirmed transaction and reports the amount in DECIMAL CHF", () => {
    const decision = decideAction(tx(), null)

    expect(decision.action.action).toBe("authorized")
    expect(decision.action.data?.session_id).toBe(SESSION)
    // Payrexx meldete 4200 Rappen — Medusa muss 42 sehen, nicht 4200.
    expect(Number(decision.action.data?.amount)).toBe(42)
  })

  it("authorizes 'waiting' (Powerpay/Rechnungskauf) the same way as 'confirmed'", () => {
    // Vorher wich getPaymentStatus() hier ab und meldete "pending" — eine per
    // Webhook autorisierte Powerpay-Bestellung blieb dadurch hängen.
    const decision = decideAction(tx({ status: "waiting" }), null)
    expect(decision.action.action).toBe("authorized")
  })

  it.each(["authorized", "reserved"])(
    "authorizes the pre-authorization status '%s'",
    (status) => {
      expect(decideAction(tx({ status }), null).action.action).toBe("authorized")
    }
  )

  it.each(["cancelled", "declined", "expired", "error", "chargeback"])(
    "fails on '%s'",
    (status) => {
      expect(decideAction(tx({ status }), null).action.action).toBe("failed")
    }
  )

  it("does NOT report a refund as a capture", () => {
    // Bisher: "refunded" → action "captured". Das ist die falsche
    // Ereignisform — Medusa würde daraufhin einen CAPTURE ausführen, also
    // Geld in die Gegenrichtung bewegen. Siehe SECURITY-NOTES.md.
    const decision = decideAction(tx({ status: "refunded" }), null)

    expect(decision.action.action).not.toBe("captured")
    expect(decision.action.action).toBe("not_supported")
    expect(decision.log?.level).toBe("warn")
    expect(decision.log?.message).toContain("Medusa Admin")
  })

  it("does not guess the amount semantics of a partial refund either", () => {
    const decision = decideAction(
      tx({ status: "partially-refunded", amount: 1000 }),
      null
    )
    expect(decision.action.action).toBe("not_supported")
  })

  it("ignores an unknown status instead of inventing a meaning for it", () => {
    const decision = decideAction(tx({ status: "quantum-superposition" }), null)
    expect(decision.action.action).toBe("not_supported")
    expect(decision.log?.level).toBe("warn")
  })

  it("cannot attribute a transaction without a referenceId", () => {
    const decision = decideAction(tx({ referenceId: undefined }), null)
    expect(decision.action.action).toBe("not_supported")
  })
})

describe("decideAction — Betragsplausibilität", () => {
  it.each([0, -1, 42.5, Number.NaN, undefined, "4200"])(
    "rejects the implausible amount %p",
    (amount) => {
      const decision = decideAction(tx({ amount }), null)
      expect(decision.action.action).toBe("failed")
      expect(decision.log?.level).toBe("error")
    }
  )

  it("does not require an amount for a failing status", () => {
    const decision = decideAction(tx({ status: "declined", amount: 0 }), null)
    expect(decision.action.action).toBe("failed")
    // Kein "implausible amount"-Fehler — bei einer abgelehnten Zahlung ist
    // ein fehlender Betrag normal.
    expect(decision.log?.level).toBe("info")
  })
})

describe("decideAction — Stale-Gateway-/Preis-Manipulations-Guard", () => {
  it("authorizes when the reported amount matches the current gateway", () => {
    const decision = decideAction(tx(), CURRENT_GATEWAY)
    expect(decision.action.action).toBe("authorized")
  })

  it("refuses to complete when the customer paid a stale, LOWER amount", () => {
    // Kunde hatte einen alten Gateway über CHF 42 offen, der Warenkorb ist
    // inzwischen CHF 89. Das Löschen des alten Gateways war gescheitert.
    const decision = decideAction(tx({ amount: 4200 }), {
      ...CURRENT_GATEWAY,
      amountInRappen: 8900,
    })

    expect(decision.action.action).toBe("not_supported")
    expect(decision.log?.level).toBe("error")
    expect(decision.log?.message).toContain("MANUAL REVIEW REQUIRED")
  })

  it("refuses to complete when the customer paid a stale, HIGHER amount", () => {
    const decision = decideAction(tx({ amount: 8900 }), CURRENT_GATEWAY)
    expect(decision.action.action).toBe("not_supported")
    expect(decision.log?.level).toBe("error")
  })

  it("does NOT mark the payment as failed on a mismatch", () => {
    // Das Geld ist bei Payrexx eingegangen. "failed" würde die Zahlung in
    // Medusa als gescheitert markieren und die Diskrepanz verstecken.
    const decision = decideAction(tx({ amount: 8900 }), CURRENT_GATEWAY)
    expect(decision.action.action).not.toBe("failed")
  })

  it("falls open (processes) when no expectation is recorded for the session", () => {
    // Store leer, abgelaufen oder ausgefallen: lieber ungeprüft verarbeiten
    // als eine bezahlte Bestellung verlieren.
    const decision = decideAction(tx({ amount: 8900 }), null)
    expect(decision.action.action).toBe("authorized")
  })
})

describe("extractTransaction", () => {
  it("reads the transaction out of a Payrexx webhook body", () => {
    expect(extractTransaction({ transaction: { id: 1 } })).toEqual({ id: 1 })
  })

  it.each([null, undefined, {}, { transaction: null }, { transaction: "nope" }])(
    "returns null for the unusable body %p",
    (body) => {
      expect(extractTransaction(body)).toBeNull()
    }
  )
})
