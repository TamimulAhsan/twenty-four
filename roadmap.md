# TwentyFour — Development Roadmap

How we get from a working deployment path to two live markets, in the order that
keeps revenue closest to the front and irreversible mistakes furthest from it.

Architecture reference: [`system-architecture.html`](system-architecture.html).
Decisions already taken and the rules this code must respect: [`CLAUDE.md`](CLAUDE.md).

---

## Where we are today

**Phase 0 is complete and verified.** A local k3s cluster runs the full deployment
path end to end:

| | Status |
|---|---|
| k3s + Traefik ingress | Running, Traefik is the default IngressClass |
| PostgreSQL 18, Redis 8, Kafka (KRaft) | Running, verified with real queries, not just pod status |
| `core` service | Built with podman → local registry → pulled by k3s → answering through Traefik |
| `/readyz` dependency probe | Reports `postgres: ok, redis: ok, kafka: ok` |
| Cluster dashboard | Live topology on `:8090`, edges derived from the cluster itself |

Nothing merchant-facing exists yet. That is correct for this point.

---

## Principles that govern the order

These are the reasons the phases are sequenced the way they are. They matter more
than the individual tickets.

1. **Do not automate a process nobody has run yet.** The Provisioning Orchestrator
   comes *after* ten merchants have been provisioned by hand. Automating first
   means automating guesses.
2. **The transactional outbox goes in with the first event, not the tenth.**
   Retrofitting event-driven behaviour into synchronous code is the single most
   expensive thing on this list to defer.
3. **Do not sell the 24-hour guarantee before Phase 3.** It is survivable manually
   for five merchants and a disaster at fifty.
4. **De-risk what you do not control first.** NAV reporting and payment-provider
   onboarding are external, legally gating, and slow. Everything else is code you own.
5. **Boundaries in code, not in deployments.** Six binaries, not twenty-nine. Split
   a service out when it earns it by needing separate scaling or release cadence.
6. **Contract tests before market two, not during.** They are how you find out the
   swappable-pod design actually worked.

---

## Phases at a glance

| Phase | Goal | Done when |
|---|---|---|
| **0** ✅ | Deployment path | Code reaches a browser through Traefik |
| **1** | First real sale | A Hungarian merchant takes a real card payment with a NAV-compliant receipt |
| **2** | Repeatable | A specialist onboards a merchant in a day with no engineering help |
| **3** | The guarantee | Provisioning is automated, measured against a 24-hour SLA, and retryable |
| **4** | Upsell | Growth and Max tiers sellable |
| **5** | Second market | Bangladesh live by swapping three pods |
| **6** | Deferred perks | Custom domain and API access ship |

---

## Phase 1 — One merchant, one real sale

**Goal:** a single Hungarian merchant on the Starter tier takes real money.

### Start immediately, in parallel with everything else

These are external dependencies with calendar time attached. Start them on day one
even if the surrounding code is a stub.

- **NAV Online Számla spike.** In Hungary you cannot legally complete a sale without
  issuing a compliant invoice and reporting it. Build a throwaway that submits one
  invoice and handles one rejection. Find out what you do not know now.
- **Payment provider onboarding.** Barion or SimplePay connected-account KYC takes
  real time. Open one test account this week.

### Build

| Binary | Contains |
|---|---|
| `core` | Auth (argon2id, PASETO), Tenant &amp; Business Profile |
| `commerce` | Catalog, POS &amp; Orders |
| `finance` | Payments (HU), Invoice &amp; Receipt (HU, NAV) |
| `gateway` | Token verification, tenant resolution, Merchant BFF |
| `web` | Merchant dashboard: catalog, till, day's takings |

Plus the **transactional outbox** and the first real events: `order.placed`,
`payment.succeeded`.

### Deliberately not built yet

Entitlement enforcement (one tier means nothing to gate), Provisioning Orchestrator,
admin console, Bookings, Inventory, CRM, marketing, ClickHouse. **Provisioning is a
SQL script and a written runbook.**

### Exit criteria

- A real merchant takes a real card payment on real hardware.
- The receipt is NAV-compliant and accepted.
- `order.placed` is written to the outbox in the same transaction as the order, and
  the relay publishes it exactly once.
- The runbook to provision a tenant exists and a non-author can follow it.

### Risks

- **NAV integration is the schedule risk.** It is legally gating, externally owned,
  and the easiest thing to underestimate.
- Processor KYC can block go-live independently of any code being ready.

---

## Phase 2 — Repeatable by a specialist

**Goal:** onboarding no longer requires an engineer.

### Build

| Binary | Adds |
|---|---|
| `core` | RBAC, **Entitlement Service** + gateway enforcement, Redis policy cache |
| `commerce` | Bookings, Inventory, Staff &amp; Scheduling |
| `platform` | Notification (email + SMS via third-party providers), Media &amp; Document, Audit Log |
| `finance` | Ledger &amp; Reconciliation |
| `web` | Admin console v1 — tenant list, create tenant, module toggles |

Plus **industry profiles and term sets** once there are two or three trades to
generalise from — not before, or you will generalise from one example.

### Exit criteria

- A specialist provisions a merchant end to end in under a day without engineering help.
- The gateway rejects a call to a module the tenant does not hold, and the dashboard
  navigation is rendered from the same entitlement record.
- Staff seat limits are enforced in the Staff service (CRM enforcement comes with Phase 4).
- Three trades are live with different term sets and no code branching on trade.

### Risks

- Entitlement is a **security control**, not a UI concern. A missed check is a
  cross-tenant data leak. It goes at the gateway, once.

---

## Phase 3 — The 24-hour guarantee

**Goal:** automate the process Phase 2 proved, then start selling the guarantee.

### Build

- **Provisioning Orchestrator** — the saga, modelled as an explicit state machine on
  River. Every step idempotent and individually retryable.
- **Onboarding &amp; Intake** — self-serve signup with the business type selector, the
  24-hour checklist, and the SLA timer.
- **Module Registry** — module definitions, dependency graph, tier→module sets, and
  the `self-serve capable` flag per module.
- Admin console v2 — live provisioning status, per-step retry.

### Exit criteria

- Ten consecutive tenants provisioned automatically, measured, inside 24 hours.
- A deliberately failed step (e.g. processor KYC pending) can be retried from the
  admin console without unwinding earlier steps.
- Only now does the guarantee go on the pricing page.

### Risks

- Steps that cannot complete unattended — KYC, ad-account OAuth consent, hardware
  pairing — must escalate to a specialist rather than silently half-completing.

---

## Phase 4 — Growth and Max tiers

**Goal:** make the upsell real. None of this blocks Starter revenue.

### Growth

- **Website Builder** + Storefront SPA and BFF.
- **ClickHouse** + Kafka Connect/Debezium CDC pipeline.
- **Reporting &amp; Analytics API**.
- **AI Marketing Engine** + **Ad Account Sync** — the six-hour budget cycle driven by
  Scheduler, reading booked revenue from ClickHouse.

### Max

- **Twenty CRM fork** — own deployment, own PostgreSQL, workspace per tenant, owner as
  workspace super admin, shared session cookie on the parent domain.
- **CRM Sync Service** — bidirectional, with the platform↔Twenty ID mapping store.
  Build the mapping store first; it is what makes upserts idempotent.
- **AI Creative Generation**.

### Exit criteria

- A merchant upgrades tier from their subscription page and the new modules provision
  unattended, or escalate cleanly when they cannot.
- Staff seat limits are enforced **in both places** — Staff service and CRM Sync.
- Ad budget reallocation runs unattended for two weeks and every decision is in the
  audit log in plain language.

### Risks

- The Twenty fork brings a **Node runtime and a second build pipeline**. Budget for it.
- Upstream merges start here: every 15 days, named owner, treated as debt if skipped.

---

## Phase 5 — Bangladesh

**Goal:** prove the architecture by standing up a second market.

### Build

- **Contract test suite (Pact)** for Payments, Invoice &amp; Receipt and Billing —
  written *before* the Bangladesh implementations, so they have something to pass.
- Bangladesh implementations of those three services: bKash / Nagad / SSLCOMMERZ,
  NBR Mushak documents and reporting, local subscription collection.
- Second VPS, second k3s, second everything. Bangladeshi legal entity, own ledger.
- **Release fan-out automation** — Argo CD driving both environments from one codebase.

### Exit criteria

- Bangladesh runs the identical stack with only three pods different.
- **If anything outside those three services needed changing, the abstraction leaked** —
  find exactly where and fix the contract, not the caller.
- A release reaches both environments from one merge with no manual steps.

### Risks

- This is the phase that tests every "market-neutral" claim made so far. Expect to
  find at least one assumption that only held in Hungary.

---

## Phase 6 — Deferred perks

Both are advertised as *coming soon* on the pricing page, so both carry a public promise.

- **Custom domain** (Max) — per-tenant TLS issuance and renewal at Host NGINX.
  Note the security constraint: the CRM session cookie is scoped to the parent domain,
  so no tenant-controlled hostname may ever sit beneath it.
- **API access** (Enterprise) — a gateway surface plus a service issuing keys, scopes
  and per-tenant rate limits.

---

## Parallel workstreams

These do not fit in a phase; they run continuously from the point they start.

| Workstream | Starts | Notes |
|---|---|---|
| **Observability** | Phase 1 | OpenTelemetry traces from the first multi-service request. A request crossing gateway → BFF → 3 services is undebuggable without trace IDs. |
| **CI/CD** | Phase 1 | GitHub Actions → registry → Argo CD. This *is* the release fan-out mechanism later. |
| **Secrets** | Phase 1 | OpenBao. Payment credentials never live in env files or git. |
| **Backups** | Phase 1 | CloudNativePG with PITR. Fiscal documents have multi-year legal retention. |
| **Contract tests** | Phase 4 | Written before Phase 5 needs them. |
| **Twenty fork merges** | Phase 4 | Every 15 days. |
| **Security review** | Phase 2 | Admin plane isolation, impersonation scoping, entitlement enforcement. |

---

## Decision gates

Things that must be settled before the phase that depends on them.

| Decision | Needed by | Impact if late |
|---|---|---|
| Prices per tier, final seat counts | Phase 3 | Registry values — no code impact, but blocks selling |
| Which modules are self-serve capable | Phase 3 | Blocks self-serve upgrades entirely |
| Trade capabilities beyond Kitchen Display | Phase 2 | Each needs a profile flag and a service |
| Group consolidation owner | Phase 5 | With one ledger per entity, nothing sees the group |
| Bangladeshi legal entity | Phase 5 | Long lead time — start well before the code is ready |

---

## Deliberately out of scope, for now

Recorded so they are not quietly re-added.

- **Per-tenant deployments.** All services run once and are shared. Provisioning is
  data, not deployment.
- **Multi-entity ledger.** One environment, one entity, one currency, one set of books.
- **Country logic in code.** Market variation is handled by swapping three pods, never
  by branching.
- **A search engine.** PostgreSQL full-text until a specific query is demonstrably too slow.
- **Keycloak.** The shared session cookie removes the need.
- **Self-hosted SMTP.** Deliverability is a full-time job unrelated to the product.
- **Temporal.** River until a second long-running workflow earns the upgrade.

---

## The shortest path to revenue

If everything else slipped, this is the irreducible spine:

```
NAV spike + processor KYC   (start today, external clock)
        ↓
Auth → Tenant → Catalog → POS → Payments → Invoicing
        ↓
Merchant dashboard: catalog, till, takings
        ↓
Manual provisioning runbook
        ↓
One Hungarian merchant taking real money
```

Everything after that is making it repeatable, then automatic, then wider.
