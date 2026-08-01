# Payrexx provider — security notes (assessment only, no fix applied)

Status: 2026-08-01. Written as part of the Redis idempotency hardening pass.
Scope: Task 3 only — **analysis, not a fix**. The module's header comment and
`getWebhookActionAndData()` already document, deliberately, that webhook
amounts are not cross-checked against the Medusa payment session / cart
total:

> Ein echter "Price Manipulation Guard", der den Webhook-Betrag gegen den
> Cart-/Payment-Session-Betrag abgleicht [ist nicht implementiert].
> getWebhookActionAndData() hat keinen Zugriff auf die Payment Session;
> Medusa selbst prüft den Betrag beim Autorisieren nicht gegen den
> Provider-Report.

This note assesses how exploitable that gap actually is given the real
integration (hosted payment page + `updatePayment()`'s gateway-replacement
logic), not just the generic "someone forges a webhook" framing — forgery is
already closed by the HMAC check (`PayrexxClient.verifyWebhookSignature`,
timing-safe, tested in `payrexx-security.unit.spec.ts`). The question that
matters is: **can a legitimate, correctly-signed webhook for a legitimate,
unmodified Payrexx transaction still authorize the wrong amount?**

Yes — via a race in `updatePayment()`, without forging anything.

## The concrete exploit path: stale gateway reuse via `updatePayment()`

`initiatePayment()` creates a Payrexx Gateway (`G1`) with `referenceId =
session_id`. Payrexx Gateways are immutable, so whenever the cart amount
changes, `updatePayment()` (service.ts, ~line 420) does:

```ts
if (gatewayId) {
  try {
    await this.client.deleteGateway(gatewayId)
  } catch {
    // Ignore
  }
}
return this.initiatePayment({ amount: input.amount, ... }) // new gateway, SAME referenceId
```

Two properties of this combine into a real problem:

1. **The delete is best-effort and silently swallowed.** If it fails — e.g.
   Payrexx refuses to delete a gateway that already has a transaction
   attached (a customer has opened the TWINT app / requested a Powerpay
   invoice on it), a transient network error, or a rate limit — the code
   does not know and does not care. `G1` keeps existing and keeps being a
   valid, payable, correctly-signed-webhook-producing gateway at Payrexx.
2. **The new gateway (`G2`) reuses the same `referenceId`.** Nothing in
   `getWebhookActionAndData()` distinguishes "a webhook for the gateway that
   is currently authoritative for this session" from "a webhook for some
   earlier gateway that used to represent this session." The handler only
   ever looks at `referenceId` (→ `session_id`) and `amount`; it has no
   concept of "current" vs. "stale" gateway/transaction id for that session.

### Walkthrough

1. Customer's cart is CHF 100. `initiatePayment()` creates `G1` (CHF 100),
   customer opens the Payrexx-hosted payment page for `G1` in a tab — this is
   the hosted-payment-page flow, so the browser is now talking directly to
   Payrexx, not to this backend.
2. Before the customer pays, the cart total drops to CHF 50 (removed item,
   an auto-applied discount, a shipping-option change — anything that
   triggers Medusa to call `updatePayment()` on the still-open session).
   `updatePayment()` tries to delete `G1`. Suppose the customer has, in that
   moment, already progressed far enough on Payrexx's page that Payrexx
   refuses the delete (transaction already attached) — the `catch {}`
   swallows this and a brand-new `G2` (CHF 50, same `referenceId`) is
   created and would be shown on any *new* checkout render.
3. The customer's already-open tab still shows `G1`'s payment page (CHF
   100) and completes payment there — a completely legitimate action from
   their point of view; nothing was forged or tampered with.
4. Payrexx sends a correctly-signed webhook for `G1`'s transaction:
   `referenceId = session_id`, `amount = 10000` (Rappen), `status =
   confirmed`. HMAC passes. Idempotency passes (new key). Amount
   plausibility passes (`10000 > 0`). `getWebhookActionAndData()` returns
   `action: "authorized"` with **CHF 100** for a session whose current cart
   total is **CHF 50**.

The direction that hurts the merchant is the mirror case — cart total goes
*up* (item added, discount removed, shipping recalculated) while a
lower-amount `G1` is still open and payable in a stale tab, and its delete
fails the same way. The customer completes `G1` at the *lower*, stale
amount; the resulting order is fulfilled at the current (higher) cart total.
Same root cause, opposite financial direction. Both are reachable through
the hosted-payment-page flow specifically **because** the customer's browser
holds a direct, working link to a Payrexx-hosted gateway that this backend
no longer considers current — the backend's belief about which gateway is
"the" gateway for a session and Payrexx's belief can diverge, and nothing
here detects the divergence.

### Why this is more exploitable than it might look

- It requires no signature forgery, no timing attack, no malformed payload —
  every check currently in the file passes cleanly, because the request
  really is a legitimate, correctly-signed Payrexx webhook for a real
  transaction that a real customer really paid.
- It doesn't even require an adversarial customer. An ordinary customer with
  two tabs open, or a slow payment flow racing a coupon auto-apply, can
  trigger it by accident. (An adversarial customer could of course trigger
  it deliberately and more reliably — open the gateway, wait, then modify
  the cart in another tab before paying.)
- The precondition ("gateway delete fails") is not a rare edge case; "the
  gateway already has a transaction attached" is close to Payrexx's normal
  behavior once a customer has started the actual payment step, not an
  unusual failure.

### What is NOT being claimed

- This is not a way to bypass the HMAC check or to inject an arbitrary
  status. It only lets an amount that *was* genuinely valid for *some*
  gateway that was legitimately created for this session get attributed to
  the session after the session's expected amount has moved on.
- It does not obviously let an attacker choose an arbitrary amount — only
  one of the amounts the session legitimately passed through during its
  lifetime (before/after an update).

## Secondary, unverified finding: `partially-refunded` amount semantics

`case "refunded": case "partially-refunded":` (service.ts, ~line 600) both
map to `action: "captured"` using `amountDecimal`, computed from
`webhookTransaction.amount`. Whether Payrexx's `amount` field on a
`partially-refunded` transaction reports the **original transaction total**
or the **refunded portion** was not verified against Payrexx's API
reference during this pass. If it is the original total, a partial refund
event would be reported to Medusa as a `captured` action carrying the full
original amount, not the refund delta — which looks like the wrong shape of
event entirely (a refund being reported as a capture) independent of the
amount question. This needs a real Payrexx sandbox test or a closer read of
`https://developers.payrexx.com/reference/rest-api` before drawing a firm
conclusion; flagging it here rather than guessing.

## Not attempted (deliberately, per task scope)

- No fix for either finding. Fixing the stale-gateway issue needs a design
  decision: e.g., have `getWebhookActionAndData()` reject/ignore webhooks
  whose gateway or transaction id doesn't match the *last* gateway id
  recorded for that `session_id` (would need somewhere to persist "current
  gateway id per session" that the webhook handler can read — it currently
  has none), or make `updatePayment()`'s delete non-best-effort (retry /
  hard-fail the cart update rather than silently proceeding with a
  possibly-still-live old gateway), or actually build the "real Price
  Manipulation Guard" the header comment already flags as missing, by giving
  the webhook handler read access to the payment session/cart total. Each
  has different failure modes and none is a small change — that is exactly
  why the task asked for analysis here rather than a fix.
- No fix for the `partially-refunded` question either, pending verification
  against Payrexx's actual API behavior.
