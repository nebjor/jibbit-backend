# Multi-tenant architecture — selling jibbit as a subscription SaaS

Status: design proposal, 2026-08-01
Goal: sell the Medusa backend + storefront as a monthly subscription, with **each tenant's data in its own database**.
Design priorities, in order: **security → reliability/uptime → effortless onboarding**.

---

## TL;DR

1. **Database-per-tenant means process-per-tenant.** Medusa v2 bootstraps its DI container and MikroORM connection once from a single `databaseUrl`; there is no per-request connection switching. Every decision below follows from that.
2. **The onboarding you described needs no custom auth work.** Medusa ships an admin invite system (`medusa user --invite`, accepted at `/app/invite?token=…`). You pre-build the store, hand over an invite link, the customer sets a password and lands in their own admin with their own database already attached. §4.
3. **Four principles hold the design together** (§3): control plane off the request path · defense in depth · pre-provisioned, claim-based onboarding · blast radius of one tenant.
4. **Three live bugs in the design as first drafted** — Caddy route persistence, storefront's runtime dependency on the control plane, and the on-demand-TLS `ask` endpoint. All fixed below (§6.2); all would have caused outages.
5. **MFA is a real gap.** Medusa admin ships no TOTP. Options in §5.3 — don't ship the platform without deciding.
6. **Uptime you can actually promise:** per-tenant failures are contained, but one shared Postgres means a server-level failure is all-tenants. Honest RTO/RPO in §6.4 — don't sell HA you haven't built.

---

## 1. The constraint (settled)

Medusa v2 has no native multi-tenancy, and shared-database multi-tenancy would mean adding `store_id` to nearly every core entity and overriding the matching services and routes — breaking on every upgrade. **The silo model (one process + one database per tenant) is therefore not the expensive option; it is the only one that doesn't fork core.**

### Verified against the framework source (2026-08-01)

This is no longer an inference. `@medusajs/framework/dist/database/pg-connection-loader.js` in the installed 2.13.6:

- reads a single `configModule.projectConfig.databaseUrl` (line 18),
- creates **one** knex connection pool from it (line 38),
- registers it in the DI container with `asValue(pgConnection)` (line 65) — a process-lifetime singleton, handed unchanged to every consumer,
- and returns the existing registration if one is already present (lines 13–15).

There is no per-request connection switching and no seam to add one without patching the framework. **Database-per-tenant ⇒ process-per-tenant is a proven constraint.**

**Undocumented finding:** `projectConfig.databaseSchema` *is* supported (line 22, defaulting to `"public"`) even though it appears in neither the config reference nor the shipped type definitions. So schema-per-tenant is technically possible — but the schema is also fixed at bootstrap, so it would still need one process per tenant while giving weaker isolation than a separate database (no separate credential, no independent restore). **Database-per-tenant remains the right call**; this is recorded only so the option isn't rediscovered later and mistaken for a shortcut.

Sources: [Discussion #14247](https://github.com/medusajs/medusa/discussions/14247) · [#12304](https://github.com/medusajs/medusa/discussions/12304) · [Rigby on Medusa multi-tenancy](https://www.rigbyjs.com/blog/multi-tenancy-in-medusa)

---

## 2. Architecture

> **The routing domain is not secured.** The diagram below routes on
> `*.jibbit.app`, but a live availability check (2026-08-01) found `jibbit.app`
> **unavailable to purchase**, and nothing ties it to Joris — no matching
> certificate, no content. `jibbit.com` and `jibbit.io` are also taken
> (`jibbit.io` redirects to an unrelated company). Only `jibbit.ch`, the
> existing shop, is confirmed his. Treat `*.jibbit.app` below as a placeholder
> until the platform domain is chosen and bought — every tenant subdomain,
> the on-demand TLS setup (§6.2c) and every transactional email link depend on
> it. Alternatives confirmed purchasable: `jibbit-shop.com`, `getjibbit.com`,
> `jibbitplatform.com`. Worth a quick trademark sanity check too — "Jibbitz" is
> an existing Crocs brand, which may be why three TLDs are already gone.
> Details and options in `jibbit-platform/docs/human-tasks.md` §6.

```
                        ┌─────────────────────────────┐
   *.jibbit.app  ─────► │  Caddy (on-demand TLS)      │
   custom domains       │  host → tenant upstream     │
                        └──────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
      │ medusa-t001   │    │ medusa-t002   │    │ medusa-t003   │   DATA PLANE
      │ own secrets   │    │               │    │               │   1 container
      │ own Payrexx   │    │               │    │               │   1 network
      │ mem/cpu limit │    │               │    │               │   per tenant
      └───────┬───────┘    └───────┬───────┘    └───────┬───────┘
              │                    │                    │
        ┌─────▼────────────────────▼────────────────────▼─────┐
        │  PostgreSQL — one server, one DB + role per tenant  │
        │  db_t001 / db_t002 / db_t003, no cross-connect      │
        └─────────────────────────────────────────────────────┘

      ┌──────────────────────────────────────────────────────┐
      │  Storefront — ONE Next.js deployment, ≥2 replicas     │  shared runtime
      │  tenant resolved by Host header, config pushed        │
      └──────────────────────────────────────────────────────┘

      ┌──────────────────────────────────────────────────────┐
      │  CONTROL PLANE — registry, provisioning, secrets,     │  OFF the
      │  invites, billing, migration orchestration            │  request path
      └──────────────────────────────────────────────────────┘
```

---

## 3. Four principles

**P1 — The control plane is never on the request path.** If it is down, every existing tenant keeps selling. Provisioning and the customer portal stop; storefronts, checkouts and admins do not. This is the difference between "our dashboard is down" and "our customers can't take orders."

**P2 — Defense in depth: no single barrier between tenants.** Network segmentation *and* credential separation, so that neither one being wrong is sufficient to cross a boundary.

**P3 — Pre-provisioned, claim-based onboarding.** Nothing is created at signup time. The store exists, fully built, before the customer ever authenticates. Their first action is claiming it, not waiting for it.

**P4 — Blast radius of one.** A tenant's container, database, secrets and resource limits are theirs alone. One tenant's crash, memory leak, bad import or compromised credential reaches nobody else.

---

## 4. Onboarding — what the customer experiences

This is the part you care most about, and Medusa gives it to you natively.

### 4.1 The flow

```
   YOU                                          CUSTOMER
   ───                                          ────────
1. Provision tenant
   (DB + role + container + route)
2. Clone store template → customize
   products, theme, content, domain
3. Tenant state: ready_for_handover
4. Click "Hand over" ──────────────────────►  📧 "Your store is ready"
      │                                          │
      │ medusa user --invite kunde@shop.ch       │
      │ → invite token                           ▼
      │ → branded email w/ link            Clicks link
      └──────────────────────────────►    /app/invite?token=…
                                                 │
                                                 ▼
                                          Sets name + password
                                                 │
                                                 ▼
                                    ✅ Lands in THEIR admin
                                       Store already live
                                       Own DB already attached
                                       Products already there
```

No provisioning wait, no empty-store first impression, no configuration wizard. They log in and the thing they bought is already running.

Medusa's CLI creates the invite and prints the token; the customer accepts it either in the admin UI at `/app/invite?token=<token>` or via `POST /admin/invites/accept` (`email`, `first_name`, `last_name`, `invite_token`). Nothing custom required.

Sources: [Medusa CLI `user` command](https://docs.medusajs.com/resources/medusa-cli/commands/user) · [Manage invites](https://docs.medusajs.com/user-guide/settings/users/invites) · [Invite user email subscriber](https://docs.medusajs.com/resources/commerce-modules/user/invite-user-subscriber)

### 4.2 Invite expiry — get this right or the first impression breaks

**Medusa invites expire one week after creation by default.** In your model — build the store first, hand over later — an invite generated at *provisioning* time is very likely dead by the time the customer clicks it. The first thing they'd ever see is a broken link.

Rules:
- **Generate the invite at handover, never at provisioning.** They are different lifecycle events; treat them as such.
- **"Re-send invite" is a one-click control-plane action**, not an SSH session. You will need it constantly.
- Show invite status and expiry per tenant in the control plane, so you can see a stale one before the customer does.
- If a customer is slow, re-issue proactively rather than waiting for the support email.

*(Not verified: whether Medusa stores the invite token hashed at rest. Worth checking before you treat the token as a secret with strong storage guarantees — assume it is sensitive and keep it out of logs regardless.)*

### 4.3 "The store I built for them" — clone a template, don't hand-build

Two readings of this, and they scale very differently:

| Approach | Provisioning | Scales to |
|---|---|---|
| Bespoke per customer | hand-built content each time | a handful |
| **Template clone + customize** *(recommended)* | `createdb` → restore golden template dump → migrate to current → apply customer's branding/products | dozens |

Maintain one or more **golden template databases** (a base shop, fully configured: shipping options, regions, tax, payment provider config, sample catalogue, theme defaults). Provisioning restores that dump into the new tenant database and then applies per-customer customization. Rebuilding the template is then a single job that improves every *future* tenant.

**Assumption flagged:** the plan below assumes template-cloning. If every store is genuinely bespoke, provisioning stays manual and the economics change — worth deciding explicitly.

### 4.4 The sibling paths that must also work

- **Password reset.** The claim flow's twin. It needs working per-tenant SMTP — if outbound mail isn't configured for a tenant, a locked-out customer is stuck and you're doing manual resets. Verify SMTP as part of provisioning, not at first incident.
- **Custom domains, self-serve.** Customer adds a CNAME to `shop.theirbrand.ch`; on-demand TLS issues the certificate automatically on first request (§6.2). This is a genuinely delightful, near-free feature — surface it in the admin with a copyable DNS record and a live status check.
- **Onboarding checklist** in their admin: connect payment provider, set shipping, add bank details, go live. Small effort, large reduction in "how do I…" emails.
- **Support access.** Decide now how you help a customer inside their store. Adding yourself as a second admin user per tenant is the simple answer; an impersonation feature is the one that will cross a tenant boundary carelessly if you build it in a hurry.

---

## 5. Security

### 5.1 Isolation — every barrier, per tenant

| Layer | Control | Why |
|---|---|---|
| **Auth secrets** | Own `JWT_SECRET` + `COOKIE_SECRET` per tenant | **Highest severity on this page.** Shared secrets mean a token minted for tenant A may validate against tenant B. Generate at provisioning, never reuse |
| **Database** | Own DB + login role; `REVOKE CONNECT ON DATABASE … FROM PUBLIC` | A stolen connection string reaches one database |
| **Network** | Own Docker network per tenant | A compromised container cannot reach another tenant's container at all — P2, so neither network nor credentials is the sole barrier |
| **Resources** | cgroup memory + CPU limits per container | This is what actually delivers noisy-neighbour containment. Without limits, one tenant's runaway import degrades everyone on the host |
| **PSP credentials** | Tenant's own Payrexx account (§8) | No cross-tenant payment exposure, and no platform money-handling |
| **Uploads** | Own volume, or S3 with per-tenant prefix + scoped credentials | |
| **CORS** | Per-tenant `STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS` | Already per-container env — just don't wildcard it |

### 5.2 The control plane is the crown jewel

It holds every tenant's database password and Payrexx API secret. **Treat its compromise as total compromise of the platform.**

- Secrets encrypted at rest with a key that is *not* stored beside them (SOPS/age, or a secrets manager).
- Not internet-facing except the customer portal — admin surface on a private network or behind an identity proxy.
- Append-only audit log of every provisioning, secret-read, invite and suspend action.
- Its own backups, encrypted, restore-tested — losing the registry means orphaned containers and databases you can't map back to customers.

### 5.3 MFA — a real gap, decide before launch

Medusa admin ships **no TOTP/MFA**. Your customers' admin accounts control real money movement. Options:

1. **Proxy-level enforcement** — Caddy `forward_auth` to an identity proxy in front of `/app`. Strongest, adds a component and a second login step.
2. **Custom Medusa auth provider** — native-feeling, real implementation and maintenance cost.
3. **Interim: strong password policy + aggressive login rate limiting + login alerting.** Acceptable to launch on, not acceptable to leave indefinitely.

Recommendation: launch on (3) with (1) planned, and be honest about it if a customer asks.

### 5.4 Baseline hardening

- **Rate-limit admin login and the invite-accept endpoint** at Caddy — per-IP and per-tenant. Brute force against a known subdomain is the obvious attack.
- Keep the existing security headers; extend the CSP per tenant when they get custom domains.
- **Pin image digests and the Medusa version.** A supply-chain surprise across every tenant simultaneously is the worst-case update.
- Payrexx webhook signature validation is already implemented — keep it, and never log tokens, invite tokens or API secrets.
- Automate certificate and dependency patching; per-tenant containers mean patching is a fleet operation, not a single server.

---

## 6. Reliability & uptime

### 6.1 Blast radius

| What fails | Who notices | Contained? |
|---|---|---|
| One tenant's container | that tenant only | ✅ P4 |
| One tenant's database | that tenant only | ✅ |
| One tenant's runaway resource use | that tenant only, **if cgroup limits are set** | ✅ via §5.1 |
| **Postgres server** | **all tenants** | ❌ shared — §6.4 |
| **Caddy** | **all traffic** | ❌ shared — §6.3 |
| Storefront deployment | all storefronts (admins keep working) | ⚠️ mitigate with ≥2 replicas |
| **Control plane** | **nobody customer-facing** | ✅ **by design — P1** |

### 6.2 Three live bugs to fix in the design

These are not nice-to-haves; each is an outage waiting for its trigger.

**(a) Caddy route persistence.** Routes added via the admin API autosave, but if the Caddy container is replaced or the volume is lost, **every tenant route disappears at once**. Fix: the control plane is the source of truth and re-renders the full routing config on boot; the admin API is used for incremental updates only, never as the system of record.

**(b) Storefront's runtime dependency on the control plane.** If the storefront fetches tenant config per request, the control plane is silently on the request path — violating P1 and making it a platform-wide SPOF. Fix: **push** config to the storefront (build-time or a pushed edge config), or cache with a **last-known-good fallback that survives a control-plane outage indefinitely**. A cache with a TTL that fails closed is the same bug with a delay.

**(c) On-demand-TLS `ask` endpoint.** Caddy asks before issuing a certificate for an unknown hostname. Pointed at the control plane, a blip stops certificate issuance for legitimate new domains. Fix: cached allow-list with a stale-serving fallback. The `ask` guard itself is **mandatory** — without it you're an open certificate-issuance proxy for anyone who points DNS at you.

### 6.3 Shared components

- **Caddy** — one instance is fine; make config reproducible (6.2a), health-check it, and keep the render-from-control-plane path tested. Config regeneration must be idempotent.
- **Storefront** — stateless: run ≥2 replicas behind Caddy, deploy rolling. Cache aggressively so a backend hiccup degrades to stale pages rather than errors.
- **Redis** — a small instance per tenant (~10–20 MB) is defensible at this scale and removes a class of cross-tenant collision bugs. The alternative, one Redis with logical DBs, caps out at 16.

### 6.4 Postgres — where to be honest

One server means a server-level failure is an all-tenants outage. Don't sell HA you haven't built. Baseline:

- **WAL archiving + PITR**, plus per-tenant `pg_dump` (cheap and independently restorable — the thing separate databases buy you).
- **Restore-test on a schedule.** An untested backup is a hypothesis.
- **PgBouncer** before you reach double digits — every Medusa process holds a pool and `max_connections` is a hard wall you hit suddenly.
- **State RTO/RPO from a measured restore, not a guess.** Roughly: RPO minutes with WAL archiving; RTO tens of minutes for a full server rebuild, and much less to restore a single tenant. Measure both before quoting anything to a customer.
- If uptime becomes a selling point: managed Postgres with HA, or a streaming replica with tested failover. Both cost real money — price it into the subscription rather than discovering it later.

### 6.5 Operations

- **Per-tenant synthetic checks** against each tenant's actual subdomain — storefront loads, product page renders, admin responds. "Is the host up" tells you nothing about whether tenant 17 is broken.
- Container health checks + restart policies (your compose already does this for Postgres/Redis — extend per tenant).
- **Per-tenant log separation**, so support means reading one tenant's logs, not grepping a shared stream.
- **Status page** — cheap, and it converts "is it just us?" emails into self-service.

### 6.6 Migrations across N databases

On every Medusa upgrade you migrate every tenant database. Design it, don't loop it:

- **Version recorded per tenant.** Tenants can legitimately sit on different versions mid-rollout.
- **Back up immediately before migrating** each tenant.
- **Canary → batch:** your own store first, then a small batch, then the rest.
- **Halt on failure.** One tenant failing must stop the rollout, not leave 40 tenants in unknown states.
- Image version and schema version move together per tenant, or new code runs against an old schema.

---

## 7. Provisioning & tenant lifecycle

Model provisioning as a state machine on the tenant row, every step check-then-act, the whole sequence safely re-runnable:

```
pending → db_created → migrated → template_restored → secrets_stored
        → container_running → route_registered → ready_for_handover
        → invited → active
                      ├─► suspended   (non-payment: stop container, KEEP database)
                      └─► offboarding (export → retention window → delete)
```

Half-provisioned tenants are the standard mess in this kind of platform; resumability is what prevents it. A failure at `container_running` re-runs from there — it does not recreate the database.

`medusa db:migrate` and `medusa exec ./src/scripts/seed.ts` both read `DATABASE_URL` from the environment, so pointing them at a fresh tenant database is just an env var.

**Suspension keeps the database.** A customer who lapses and returns three weeks later should get their store back, not condolences. Define the retention window explicitly and put it in the terms.

---

## 8. Payments — architectural requirement

**Each tenant holds their own Payrexx merchant contract, settling directly to their own bank account.** The platform stores credentials and never touches the money. If tenants' revenue landed in your account and you paid it onward, that is money transmission — a licensing question for a lawyer, not something to engineer around.

This fits your code: `PayrexxPaymentProviderService` takes `instance`/`apiSecret`/`webhookSecret` as module options resolved from env at registration. Per-tenant containers give per-tenant credentials with **no change to the module**. A shared-process design would need them resolved per request — a module rewrite, and a much better opportunity to leak one tenant's secret into another's transaction. The in-memory `processedWebhooks` Set gains the same way, becoming correctly per-tenant instead of a cross-tenant hazard (it still needs Redis for restart-safety).

**Onboarding consequence:** every tenant needs their own Payrexx acceptance, and Payrexx may decline some — jibbit.ch's own ruling is still open. So payments onboarding cannot be instant. Plan for a "connect your payment provider" step that can sit pending for days while the store is otherwise usable and billable, and make that state visible in their admin checklist rather than a silent blocker.

### 8.1 The platform's own billing — a second, separate merchant relationship

Everything above concerns tenants collecting money from *their* customers. It says nothing about how **jibbit charges tenants** the monthly subscription, and that is a distinct merchant account with its own KYC and its own bank verification.

Keep the two strictly separate:

| | Tenant checkout | Platform subscription |
|---|---|---|
| Who is paid | the tenant | jibbit |
| Account holder | the tenant | Joris |
| Provider | tenant's own Payrexx | Stripe (or Payrexx, if they underwrite SaaS billing) |
| Money touches the platform? | **never** | yes, it is our own revenue |

Practical notes: the Stripe integration wiring is quick (installable through the Vercel Marketplace, keys pulled straight into env), but the underlying account still needs human KYC — so open it early. It is also worth asking Payrexx, in the same email as the §3 pre-check, whether they underwrite recurring SaaS subscriptions; one merchant relationship instead of two would be materially simpler. Tenant #1 can be invoiced manually as a bridge; tenant #2 cannot.

---

## 9. Compute economics

A Medusa process in `shared` worker mode is roughly **0.5–1 GB RSS**:

| Host RAM | Realistic tenants |
|---|---|
| 16 GB | ~10–12 |
| 32 GB | ~25–30 |
| 64 GB | ~55–65 |

Run this against your subscription price before building. At CHF 49–99/month it works comfortably; at CHF 19 the density has to be much higher and the design changes.

**Scale-to-zero is a trap for checkout.** A 10–30s cold start is survivable while browsing (the storefront serves cached pages) but not when a customer clicks pay and waits on a Payrexx redirect. If you hibernate idle tenants, keep any tenant with an active cart warm.

---

## 10. Phased path

**Phase 0 — prove it (days).** Parameterize the compose stack per tenant. Provisioning shell script: create DB + role → migrate → restore template → generate secrets → start container → add Caddy route. Run **two** tenants on one host, hand one over to yourself via the invite flow end to end. This surfaces port allocation, secret generation, Caddy reload, connection counts and the invite UX for very little work.

**Phase 1 — control plane (1–2 weeks).** Tenant registry + provisioning state machine (§7), Caddy config rendering (§6.2a), multi-tenant storefront with pushed config (§6.2b), one-click handover and re-invite (§4.2).

**Phase 2 — commercial (1–2 weeks).** Subscription billing, suspend/resume, retention policy, self-serve custom domains, onboarding checklist.

**Phase 3 — operations (ongoing).** Migration orchestration (§6.6), per-tenant synthetic monitoring, restore drills, MFA (§5.3), status page.

Don't skip Phase 0. The temptation is to design the control plane first; the compose script teaches you what it actually needs to do.

---

## 11. Open items

- **`backend/node_modules` is empty** — dependencies were never installed, so `medusa db:migrate` and `medusa user --invite` can't run yet. That is step one of any provisioning script.
- Uncommitted change in `modules/payrexx/client.ts`.
- **Decide: template clone vs. bespoke** (§4.3) — changes provisioning and the economics.
- **Decide: MFA approach** (§5.3) before customers hold real revenue.
- **Verify: Medusa invite token storage** (§4.2) before treating it as a strong secret.
- **Verify: Redis module namespace support** in 2.13, if you'd rather share one Redis than run one per tenant.
- **Scope honesty:** this is a second product alongside jibbit.ch, weeks not days — while jibbit's own payment acceptance is still unresolved.

---

## Sources

- [Medusa — Native Multi-Tenancy Support (#14247)](https://github.com/medusajs/medusa/discussions/14247) · [Feature Request (#12304)](https://github.com/medusajs/medusa/discussions/12304) · [Add Multi-Tenant Feature (#11671)](https://github.com/medusajs/medusa/discussions/11671)
- [Medusa CLI — `user` command (invites)](https://docs.medusajs.com/resources/medusa-cli/commands/user)
- [Medusa Admin — Manage invites](https://docs.medusajs.com/user-guide/settings/users/invites)
- [Medusa — Send invite user email notification](https://docs.medusajs.com/resources/commerce-modules/user/invite-user-subscriber)
- [Medusa config reference (`workerMode`, database options)](https://docs.medusajs.com/resources/references/medusa-config)
- [Rigby — Multi-tenancy in Medusa with Postgres RLS](https://www.rigbyjs.com/blog/multi-tenancy-in-medusa)

*Regulatory points in §8 are flags for a lawyer, not legal advice.*
