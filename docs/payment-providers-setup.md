# Payment providers for jibbit.ch — TWINT, Payrexx, Powerpay

Status: research + plan, 2026-08-01
Assortment: **rolling papers, filters/tips, grinders**. No tobacco, no nicotine, no CBD/THC, no vapes/e-liquids, no bongs/water pipes/vaporizers.

---

## TL;DR

1. **The code is not the blocker — the contract is.** `backend/src/modules/payrexx/` already implements a full Medusa v2 payment provider against the Payrexx Gateway API, including TWINT and Powerpay support, HMAC webhook validation, capture and refund. What's missing is a *live Payrexx account*.
2. **Before applying, get a written acceptance ruling.** Payrexx's published prohibited list bans tobacco sales, paraphernalia (bongs, vaporizers, water pipes) and CBD/THC — but **does not name papers, filters or grinders**. Genuine gray zone; only Payrexx compliance can close it. Ready-to-send email in §3.
3. **"Sign up at Payrexx *and* TWINT" is probably wrong.** With Payrexx Pay you get TWINT under a single contract, no separate TWINT signup. A separate TWINT contract only becomes necessary on the fallback path (§2).
4. **Powerpay: consider deferring.** Most likely of the three to decline, most onboarding effort, worst economics at a CHF 15–40 basket. The code already supports it, so it costs nothing to add later.
5. Disclose the assortment fully and precisely. A decline before launch costs a week. A termination after launch freezes your settlement funds and your checkout simultaneously.

---

## 1. The constraint that shapes everything

Payrexx publishes a list of business models it does not support for **Payrexx Pay / Payrexx Pay Plus** (their payment-facilitator product). Relevant entries:

- *"Alle Dienstleistungen, die den Verkauf von Tabak bezwecken"* — all services aimed at selling tobacco (cigarettes, cigars, vapes, shisha, e-liquids)
- Drug paraphernalia: **bongs, vaporizers, water pipes**
- *"Verkauf von CBD- oder THC-Produkten"*
- Marijuana dispensaries **and related businesses**
- Legal substances mimicking illegal drugs (Salvia, Kratom)

Source: [Payrexx — Nicht unterstützte Geschäftsmodelle](https://docs.payrexx.com/merchant/konto-verifizierung/nicht-unterstuetzte-geschaeftsmodelle)

### How this reads for the jibbit assortment

| Product | On the ban list? | Realistic risk |
|---|---|---|
| Rolling papers | Not named | Medium — an underwriter may read them as tobacco accessories |
| Filters / tips | Not named | Medium — same |
| Grinders | Not named | Medium–high — the item most often coded as "paraphernalia" |
| *(bongs, vapes, CBD)* | **Explicitly banned** | Immediate decline — we don't sell these, so say so loudly |

The phrase to watch is **"and related businesses"** under marijuana dispensaries — that's the discretionary clause an underwriter reaches for. The defence is precise and true: no tobacco, no nicotine, no cannabis, no CBD, no vapes, no water pipes. Accessories only, all legally sold in every Swiss kiosk.

Behind this sits the card-scheme reality: smoking accessories tend to land in **MCC 5993 (Cigar Stores and Stands)**, which acquirers treat as high-risk (age restrictions, regulatory volatility, chargeback ratios). Classification under **MCC 5999 (Misc. Retail)** makes everything downstream easier. **Ask which MCC gets assigned** — the single most useful question in the process.

---

## 2. Two paths — and which one we're on isn't our choice

### Path A — Payrexx Pay (payment facilitator)
One contract covers **cards, TWINT and PostFinance Pay**. Payrexx verifies, Payrexx pays out. No separate TWINT contract.

- Onboarding: submit by 16:00 → same-day review (Payrexx's own marketing claim — verify)
- Cost: list price **1.25% + CHF 0.18** per transaction on Standard; free plan with no monthly fee, Standard from ~CHF 15/month. Confirm in writing.
- **This is the path the prohibited list governs.** Compliance says no → Path A closes.

### Path B — Payrexx as gateway only (own contracts)
Payrexx supports 30+ external providers; we hold the merchant contract with each, Payrexx just routes.

- Cards: Stripe, Datatrans, Mollie, PostFinance Checkout, Worldline (Saferpay), Braintree
- Alternative: **TWINT**, PayPal, Klarna, CembraPay, **POWERPAY**, iDEAL
- Manual: invoice, prepayment, Reka-Check

Trade-offs: **each provider underwrites us separately** — more paperwork and more chances to be declined, but also more chances to be *accepted*. Each pays out directly, and Payrexx adds **0.25–1%** on top of the provider's own fees depending on plan.

Source: [Payrexx — Externe Zahlungsanbieter](https://docs.payrexx.com/merchant/bezahldienste/externe-zahlungsanbieter)

**A Payrexx Pay decline is not the end of the road** — it moves us to Path B, where we shop the business to individual acquirers, some of whom have more risk appetite than a facilitator's blanket policy allows. Good news: the existing code works on **either** path, since both terminate in the same Payrexx Gateway API.

---

## 3. Step 0 — the written pre-check (do this first, this week)

Get Payrexx compliance to classify us in writing before anything else. Send to support@payrexx.com or via their contact form, and keep the reply.

```
Betreff: Voranfrage Akzeptanz — Onlineshop Raucherzubehör (ohne Tabak/CBD)

Guten Tag

Wir planen einen Schweizer Onlineshop (jibbit.ch) und möchten vor der
technischen Inbetriebnahme verbindlich klären, ob unser Sortiment über
Payrexx Pay akzeptiert wird.

Unser Sortiment umfasst ausschliesslich:
- Rolling Papers / Zigarettenpapier
- Filter und Tips
- Grinder / Mühlen

Ausdrücklich NICHT im Sortiment:
- keine Tabakwaren, keine Zigaretten, keine Shisha
- keine Nikotinprodukte, keine E-Zigaretten, keine E-Liquids, keine Nicotine Pouches
- keine CBD- oder THC-Produkte, keine Hanfprodukte jeglicher Art
- keine Bongs, Wasserpfeifen oder Vaporizer
- keine Samen, Dünger oder Growing-Equipment

Uns ist bekannt, dass Ihre Liste der nicht unterstützten Geschäftsmodelle
Tabakverkauf, Bongs/Vaporizer sowie CBD/THC-Produkte ausschliesst. Unser
Sortiment enthält keine dieser Kategorien. Die genannten Artikel sind in
der Schweiz frei verkäuflich und in jedem Kiosk erhältlich.

Unsere zwei Fragen:
1. Wird dieses Sortiment unter Payrexx Pay akzeptiert (inkl. TWINT und
   Kreditkarten)?
2. Welcher MCC würde unserem Konto zugewiesen (5993 oder 5999)?

Falls eine Akzeptanz über Payrexx Pay nicht möglich ist: wäre eine Nutzung
von Payrexx als Gateway mit eigenen Verträgen (z. B. eigener TWINT-Vertrag,
eigener Acquirer) in unserem Fall zulässig?

Gerne stellen wir die vollständige Sortimentsliste und den Shop-Entwurf
zur Verfügung.

Freundliche Grüsse
```

**Do not soften the description to get through underwriting.** Misrepresentation is grounds for termination with funds held — and that arrives exactly when there are live orders.

Send the same question to **TWINT Acquiring AG** and **Wallee** in parallel to get a Path B read early.

---

## 4. What each provider needs

### Payrexx — account verification

Per [Payrexx's documentation](https://docs.payrexx.com/merchant/konto-verifizierung/dokumente-verifizierung):

**Einzelfirma**
- Handelsregisterauszug, Gewerbeanmeldung, Steuerregistrierung or official registration confirmation — *mandatory in Switzerland above CHF 100,000 annual revenue*
- Per authorised person / beneficial owner: full name, DOB, email, phone, **colour ID copy** (passport, ID card or driving licence only), residential address, **proof of address ≤ 6 months old**

**GmbH / AG**
- **Handelsregisterauszug** or certified registration document — mandatory
- Same personal documents for **all shareholders ≥ 25%** and all legal representatives

Practical: collect every ≥25% shareholder's ID and a fresh proof-of-address *before* opening the form. Chasing a co-founder for a utility bill is the usual reason a "same-day" review takes two weeks.

### TWINT

- **Path A: nothing to do.** TWINT is bundled into Payrexx Pay.
- **Path B:** own TWINT merchant contract (TWINT Acquiring AG or your bank), then connect it in Payrexx under *Stores → Online-Shop → Add → Integration type: PSP → Payrexx*, and enable it under *Payment Providers → Alternative Payment Methods*.
- Requires Swiss domicile and normally a Handelsregister entry.

Sources: [TWINT for online shops](https://www.twint.ch/en/business-customers/products/twint-for-online-shops/) · [TWINT via PSP](https://www.twint.ch/en/faq/connecting-twint-to-e-commerce-via-a-payment-service-provider-psp/) · [Payrexx TWINT docs](https://docs.payrexx.com/merchant/bezahldienste/externe-zahlungsanbieter/wallets-and-alternative/twint)

### Powerpay (MF Group AG, St. Gallen) — recommend deferring

Always a **separate contract with MF Group**, connected to Payrexx as an external provider. Merchant terms and pricing aren't public — quoted individually.

Three reasons to postpone to phase 2:

1. **Economics.** Papers/filters/grinders is a CHF 15–40 basket. BNPL fees are percentage plus fixed; on a CHF 25 order that's a real slice of margin for a method that largely duplicates TWINT.
2. **Underwriting.** BNPL providers are the *most* conservative of the three — they carry credit risk, so age-adjacent assortments get extra scrutiny.
3. **Service load.** The merchant carries all customer contact for goods, delivery, returns, complaints and refunds; MF Group handles only payment questions. Per the [Powerpay consumer AGB](https://terms.mfgroup.ch/agbfiles/Powerpay_Checkout_de.pdf) the customer bears default risk (14.9% p.a. late interest, CHF 18–38 dunning fees) — but reputational blowback from dunning letters lands on the shop.

Also ask about **TWINT "Später bezahlen"** in the same email — it may cover the same need with no extra contract on Path A.

---

## 5. Fallbacks if Payrexx Pay declines

1. **Payrexx as gateway + own acquirer** (Path B). Same checkout, same code, different underwriter. Talk to **Datatrans** or **Worldline/Saferpay** — they assess case by case rather than by blanket list.
2. **Wallee** (St. Gallen) — Swiss gateway, same bring-your-own-acquirer model.
3. **Mollie** — own restricted list; pre-check the same way.
4. **A specialist high-risk acquirer** that explicitly underwrites MCC 5993. Higher rate, possible rolling reserve — but stable beats cheap-and-terminated.
5. **Stripe: probably a dead end.** Stripe prohibits tobacco, e-cigarettes and e-liquid, and disallows pipes, bongs and glassware. Papers and grinders aren't named — same gray zone, but with a processor known for abrupt freezes in this category. I would not build on it. ([Stripe restricted businesses](https://stripe.com/en-ca/legal/restricted-businesses))

**Always keep a second live payment method.** Prepayment/bank transfer (Vorauskasse) costs nothing and keeps the shop taking orders on the day a provider pauses the account. Enable it at launch, not after the incident.

---

## 6. Shop hygiene that materially changes underwriting outcomes

Underwriters look at the live site. Cheap, and they move the needle:

- **No cannabis imagery or vocabulary.** No leaf icons, no "weed", "stoner", "420", "Kiffer", no green-and-Rasta styling. Present as rolling accessories or lifestyle goods.
- **Avoid the word "Headshop"** on the site and in the business description. It's a category flag — "Raucherzubehör" / "Rolling accessories" reads very differently for identical products.
- **Neutral product copy.** "Grinder, Aluminium, 4-teilig, 55mm" — not "perfect for your herb".
- **Legal pages complete before applying.** ✅ Already in place: `app/impressum`, `app/agb`, `app/datenschutz`, `app/widerrufsrecht`. Verify the Impressum carries the full company address.
- **Consider a voluntary 18+ confirmation at checkout.** Whether Swiss law formally requires it for *accessories* (as opposed to tobacco products under the TabPG) is worth confirming with a lawyer — but having it visibly in place is a strong good-faith signal to any underwriter and costs one checkbox.
- **Keep the SKU list ready as a PDF.** Every provider asks; answering within the hour keeps the application at the top of the pile.

---

## 7. Technical state — what's built, what's left

The integration is **already largely done**. `backend/src/modules/payrexx/` implements a Medusa v2 `AbstractPaymentProvider` over the Payrexx Gateway API:

- ✅ Gateway creation → hosted payment page redirect (keeps us out of PCI scope)
- ✅ `psp[]` parameter wired for **TWINT and Powerpay** selection
- ✅ HMAC-SHA256 webhook signature validation, timing-safe, with format/length guards
- ✅ Redis-backed idempotency on webhook retries; amount plausibility checks
- ✅ capture / refund / cancel / update (immutable gateways → delete + recreate)
- ✅ Hardened webhook endpoint `POST /hooks/payment/payrexx` (401 on a forged
  signature, 500 so Payrexx retries) plus a return-reconciliation endpoint
  `POST /store/payrexx/return`. Both converge on the same decision and the
  same idempotency key, so a customer who never reaches the return page still
  gets a correctly paid order.
- ✅ Amount cross-check against the gateway currently registered for the session
- ✅ Swiss shipping module (CHF 9 flat, free ≥ CHF 100), unit tests for both modules

### Open items before go-live

> Betreiber-Anleitung (Zugangsdaten, Webhook-URL, PSP-IDs, Prüfschritte):
> **[`payrexx-go-live.md`](./payrexx-go-live.md)**.

| # | Item | Where | Severity |
|---|---|---|---|
| 1 | **`PAYREXX_ENABLED_PSPS` is empty** — fill with real TWINT/Powerpay PSP IDs from [Retrieve all payment providers](https://developers.payrexx.com/reference/retrieve-all-payment-providers) once the account exists. Empty = no PSP restriction sent. | `backend/.env` | blocker (needs account) |
| 2 | **`STORE_URL=http://localhost:8000`** — must become the real domain, or redirects and webhooks break in production. | `backend/.env` | blocker |
| 3 | **Live Payrexx credentials** (`ZAHLS_INSTANCE`, `ZAHLS_API_SECRET`, `ZAHLS_WEBHOOK_SECRET`) | `backend/.env` | blocker (needs account) |
| 4 | Idempotency store is in-memory — **erledigt.** Redis-backed, atomares `SET NX EX`, pro Tenant genamespact, mit `release()`, damit ein gescheiterter Folgeschritt Payrexx' Retry nicht verschluckt. | `modules/payrexx/idempotency-store.ts` | done |
| 5 | Webhook amount isn't compared to the session amount — **erledigt.** Der Gateway-Betrag wird pro Session festgehalten (`session-store.ts`) und bei jedem Webhook abgeglichen. Eine Abweichung wird nie automatisch abgeschlossen, sondern als `ZAHLS AMOUNT MISMATCH — MANUAL REVIEW REQUIRED` geloggt. | `modules/payrexx/webhook.ts` | done |
| 6 | **Powerpay `waiting` → `authorized`** — we'd treat an unsettled invoice as authorized and ship the goods. That's likely correct *if* MF Group assumes the del credere risk on approval; **confirm against the merchant contract** before enabling Powerpay. | `modules/payrexx/webhook.ts` | confirm at contract |
| 7 | **Payrexx' Webhook-Retry-Fenster ist unbekannt** — die Idempotenz-TTL von 48 h ist eine grosszügige Annahme, kein bestätigter Wert. Bei Payrexx-Support erfragen. | `modules/payrexx/webhook.ts` | ask provider |
| 8 | **Event-Bus und Workflow-Engine laufen in-memory** — die Payrexx-Webhook-Route ist davon bewusst unabhängig (sie verarbeitet synchron), alles andere Asynchrone überlebt aber keinen Neustart. `@medusajs/event-bus-redis` + `@medusajs/workflow-engine-redis` erwägen. | `medusa-config.ts` | fix before launch |

Items 1–3 need the account. Item 6 only matters if we pursue Powerpay at all.

---

## 8. Suggested sequence

| # | Step | Blocking? |
|---|---|---|
| 1 | Send the Payrexx compliance pre-check (§3) | **yes — blocks 5–7** |
| 2 | Same question to TWINT Acquiring + Wallee in parallel | no, but do it now |
| 3 | Gather verification docs: HR-Auszug, colour IDs for ≥25% owners, proof of address ≤6 months | no |
| 4 | Move webhook idempotency to Redis (§7 item 4); review §7 item 5 | no |
| 5 | Review shop positioning against §6 before anyone underwrites the live site | no |
| 6 | On written acceptance → open account, fill PSP IDs + credentials + real `STORE_URL`, test in sandbox | after 1 |
| 7 | Enable prepayment as a permanent second method | after 1 |
| 8 | Powerpay / BNPL — revisit post-launch if demand shows up (confirm §7 item 6 first) | no |

Steps 2–5 all run while waiting on step 1. Only 6 and 7 truly block.

---

## Sources

- [Payrexx — Nicht unterstützte Geschäftsmodelle](https://docs.payrexx.com/merchant/konto-verifizierung/nicht-unterstuetzte-geschaeftsmodelle) *(primary — the decisive document)*
- [Payrexx — Dokumente für die Konto-Verifizierung](https://docs.payrexx.com/merchant/konto-verifizierung/dokumente-verifizierung) *(primary)*
- [Payrexx — Externe Zahlungsanbieter](https://docs.payrexx.com/merchant/bezahldienste/externe-zahlungsanbieter) *(primary)*
- [Payrexx — TWINT integration docs](https://docs.payrexx.com/merchant/bezahldienste/externe-zahlungsanbieter/wallets-and-alternative/twint) *(primary)*
- [TWINT für Online-Shops](https://www.twint.ch/en/business-customers/products/twint-for-online-shops/) · [TWINT via PSP](https://www.twint.ch/en/faq/connecting-twint-to-e-commerce-via-a-payment-service-provider-psp/)
- [POWERPAY](https://www.powerpay.ch/de) · [MF Group](https://www.mfgroup.ch/de) · [Powerpay Checkout AGB (consumer)](https://terms.mfgroup.ch/agbfiles/Powerpay_Checkout_de.pdf)
- [Payrexx — Kauf auf Rechnung Schweiz: Modelle & Kosten](https://payrexx.com/guides/purchase-on-account-models-costs-switzerland) *(vendor content)*
- [Payrexx pricing comparison](https://payrexx.com/comparison) *(vendor list pricing — confirm in writing)*
- [Stripe — Prohibited and Restricted Businesses](https://stripe.com/en-ca/legal/restricted-businesses)
- [MCC 5993 — Cigars, Tobacco (Rapyd)](https://www.rapyd.net/blog/mcc-5993/)

*Not legal advice. Swiss age-restriction rules for smoking accessories under the TabPG are worth confirming with a lawyer before launch.*
