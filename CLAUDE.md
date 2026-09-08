# TwentyFour — Project Guide

## What this is

**TwentyFour** is an all-in-one business operating system for small and medium businesses —
website, bookings, point of sale, payments, marketing and CRM in one platform. The commercial
model is the product: a specialist runs a 40-minute intake call, configures the system for that
trade, and the business is **live within 24 hours or their first month is free**.

This repo currently holds the **marketing site** and the **platform architecture document**.
The platform itself is not built here yet.

> Not a git repository. No build step, no `package.json`, no test suite. Everything is
> hand-authored HTML/CSS/JS opened directly in a browser.

---

## Files

| File | What it is |
|---|---|
| `landing-page/index.html` | Marketing site. Single-file, four-page SPA (~93 KB). |
| `landing-page/styles.css` | All site styling. Vanilla CSS, `tf-` prefixed keyframes. |
| `landing-page/script.js` | All site behaviour. IIFE, no framework, no dependencies. |
| `pitch-deck.txt` | Plain-text pitch deck, 10 sections. Derived from the site copy. |
| `system-architecture.html` | **Platform architecture document.** 17 sections, 14 Mermaid diagrams, 15 reference tables. |
| `platform/` | **The implementation.** Go monorepo + k3s manifests. See `platform/README.md`. |
| `roadmap.md` | Development roadmap: phases, exit criteria, decision gates. |
| `backend-plan.md` | **Backend build plan.** What the remaining nine services are, in what order, and why. Phase 1 is done. |
| `frontend-plan.md` | Frontend build plan for the five applications across both planes. |
| `admin-plan.md` | **One sign-in for both planes, and wiring the admin console to real services.** A1 and A2 are done and running. |
| `.claude/settings.local.json` | Permission allowlist only. No project config. |

---

## The marketing site (`landing-page/`)

Client-side SPA with no router — `nav(page)` toggles `.active` on `.page` elements.
Pages are `#page-home`, `#page-pricing`, `#page-about`, `#page-contact`.

`script.js` is an IIFE holding one `state` object:

```js
state = { page, annual, demo, faq, plan, sent }
```

Functions: `nav`, `runCounters`, `revealObserve`, `setDemo`, `startDemoAutoplay`,
`toggleFaq`, `setBilling`, `setPlan`, `submitContact`.

### Pricing is owned by JavaScript

Prices are **not** hardcoded in the HTML. `script.js` is the single source of truth:

```js
const PRICES = { basic: 89, starter: 189, growth: 349 };   // EUR/mo, ex-VAT
const ANNUAL_DISCOUNT = 20;                                 // percent
```

`setBilling()` injects them into `#pBasic`, `#pStarter`, `#pGrowth`, applying the annual
discount. **To change a price, edit `script.js` only** — then update `pitch-deck.txt §6`,
which restates the same figures independently and will otherwise drift.

Other tunable constants: `DEMO_PATHS`, `COUNTER_TARGETS`.
Number formatting uses `toLocaleString('de-DE')` (EU market).

### Gotcha

The site loads **Google Fonts from the network** (Archivo, IBM Plex Mono). It is not
self-contained and will render with fallback fonts offline.

---

## `system-architecture.html` — the architecture document

The main deliverable. A self-navigating technical document with a sticky table of contents.

### Structure

| # | Section | Contains |
|---|---|---|
| 1 | Request routing | 3 planes, edge topology diagram, BFF reach table |
| 2 | **Deployment topology** | One VPS per market, what it buys and costs. **Read this first.** |
| 3 | Service inventory | All 29 services: responsibility, store, type |
| 4 | **Module catalog** | Every module, dependency graph, tiers-vs-modules, **trade-neutrality rule, trade vocabulary** |
| 5 | Core Platform | Identity + tenancy diagram, entitlement rationale |
| 6 | Commerce Operations | POS, Bookings, Catalog, Inventory, Staff, Builder |
| 7 | Finance Engine | Market-swapped pods, the contract table, HU/BD comparison |
| 8 | Marketing & Sales | AI marketing, ad sync, Twenty CRM boundary |
| 9 | Platform Services | Notification, Files, Analytics, Scheduler, Audit, Support + data tier table |
| 10 | Modules & entitlement | Provisioning diagram and step table (catalog lives in §4) |
| 11 | Zero to live in 24h | Sequence diagram mapped to HOUR 0/4/12/24 |
| 12 | Twenty CRM integration | Multi-tenancy, shared-session identity, data pipeline |
| 13 | Event flow & topics | Kafka diagram + topic catalog |
| 14 | Dashboard scope | Merchant vs Admin console ownership |
| 15 | Cross-cutting concerns | Isolation, security, money rules, failure semantics |
| 16 | Decisions & open items | What was settled, and what remains |
| 17 | **Stack & infrastructure** | Every component, licence, and why. **Read before adding a dependency.** |

17 sections, 14 diagrams. Section 2 (Deployment topology) frames everything else — read it first; §4 is the fastest way to see what the product is made of.

### Architecture in one page

Read this before editing `system-architecture.html`, so you do not contradict it.

**Two decisions everything follows from:**
1. **Modules, not microservices, are the unit of sale.** "POS" is a commercial bundle that
   switches on several services and auto-enables its dependencies (Catalog, Inventory,
   Payments). The Module Registry owns that dependency graph.
2. **Provisioning is data, not deployment.** No pods per merchant. All services run once and
   are shared. Provisioning writes an entitlement record, seeds tenant data from an industry
   template, and connects external accounts.

**Edge topology** (corrected once already — do not regress):
`Clients → Host NGINX (TLS, custom domains, proxy ONLY — serves nothing) → K8s Ingress
Controller →` splits three ways: host routes → **NGINX frontend pod** (which serves the SPA
bundles), `/api/*` → Tenant Gateway, `/admin/api/*` → Admin Gateway.

**Three planes, never sharing an auth path:** Storefront (merchant's customers), Merchant
Dashboard (merchant staff), Admin Console (TwentyFour specialists, behind its own gateway with
staff SSO + MFA + IP allowlist).

**Entitlement is enforced once, at the gateway**, from a Redis policy cache invalidated by
`module.enabled` / `module.disabled` events (not TTL). Domain services never check who is
calling. The merchant dashboard builds its nav from the same record.

**Twenty CRM is a fork of the open-source product**, not a service written here. It keeps its
own deployment and its own PostgreSQL (schema-per-workspace, one workspace per tenant). Reached
only through the CRM Sync Service via GraphQL + webhooks — **never by writing into its tables**.
Served from `crm.twentyfour` and authenticated by **sharing the session cookie** issued on the
parent domain — no second login, no redirect flow, and cheaper than OIDC because Twenty is a fork
you control. That cookie is readable by every subdomain beneath the parent, so keep that namespace
under your control and never put a tenant-controlled hostname under it. Staff live in the platform's Staff
service and propagate to Twenty; the owner is created as workspace super admin during provisioning.

**Kafka carries far more than payments.** Auth, Provisioning, Entitlement, POS, Bookings, Staff,
Payments, Inventory, Scheduler and CRM Sync all publish. An earlier draft had inventory
decrementing only on `payment.succeeded`, which silently broke cash sales, comps, manual
adjustments and unpaid bookings. That callout is kept visible in §6 (Commerce Operations) on purpose.

**ClickHouse is fed only by a CDC/sink connector off Kafka** — never double-written by services.

**Market variation is handled by deployment, never by code.** This is the single most important
constraint to preserve. The platform is deployed **once per market, on its own VPS** — Hungary on
Hungarian infrastructure, Bangladesh on Bangladeshi. They share a codebase and share nothing at
runtime: no database, no event bus, no traffic, no tenant.

Every environment runs the identical stack **except three pods**, which are swapped for that
market's implementations:

| Swapped per market | Not swapped |
|---|---|
| Payments · Invoicing & Billing | Everything else, including the Ledger |

**Invoicing and Subscription Billing are one service.** They were two. Both
issue fiscal documents under a market's rules, both need numbering, layout,
mandatory fields and local tax treatment, and the only real difference is who
the document is addressed to: the merchant's customer, or the merchant. Two
services would have meant two implementations of the same numbering and layout
machinery in every market. The risk taken is that dunning and cycle charging are
genuinely different work from issuing a receipt, so if that half grows a life of
its own it splits back out; the seam to keep clean is that nothing outside the
service knows which kind of document it asked for.

That makes the swapped set **two pods, not three**.

**There is no country logic anywhere in the codebase.** No country codes, no adapters selected at
runtime, no `if country == …`. The deployed Payments service simply *is* the Hungarian one. If you
find yourself adding a country parameter, the design has been broken — the answer is a different
deployment, not a branch.

An earlier draft of this document had country packs and runtime adapter routing. **That was wrong
and has been removed.** Do not reintroduce it.

### The contract is what makes swapping work

The value lives entirely in the interface those three services expose. It must be stable,
market-neutral, and free of assumptions that only hold in the first market built. No field named
for a card; no assumption that a payment settles instantly; no assumption that an invoice number
is issued locally; no currency-specific rounding in a caller. POS asks for a payment and gets a
result — it never learns that Bangladesh answered with a mobile wallet and Hungary with a card.

`system-architecture.html` §7 carries the full contract table per service.

### Consequences

- **One ledger per environment** — one market, one legal entity, one currency, one set of books.
  No multi-entity bookkeeping inside the product.
- **Data residency is satisfied by topology**, not policy.
- **Infrastructure multiplies.** Each market is a full stack: ~35 workloads, 75–85 pods at
  production replicas. Two markets is two of everything.
- **Releases fan out.** A change to shared code must reach every environment. Automate this from
  the first day of the second market or the environments will drift.
- **Nothing sees across markets.** Group consolidation and cross-market MRR need a separate
  reporting step.

### Money rules (non-negotiable, every market)

- Integer minor units + explicit ISO currency code, everywhere, including event payloads. Never floats.
- Rounding belongs to the market's own implementation, not a language default. HUF and BDT differ.
- An invoice is immutable once issued; corrections are new documents referencing the original.
- Historic documents re-render exactly as issued — store the artifact, do not recompute it.
- **A third party being down must never block a sale.** Provider or tax authority alike: queue,
  retry, keep trading.

### Trade capability: the third category

Trade-specific behaviour lands in one of **three** places, not two. The test is whether a merchant
would ever choose it, and whether it has a surface of its own:

| Category | Chosen by | Example |
|---|---|---|
| **Sold module** | The merchant, via a tier | CRM, Marketing & Ads, AI Creative |
| **Trade capability** | Nobody — the industry profile switches it on | **Kitchen Display**, inside POS & Orders, for food service only |
| **Profile setting** | Nobody — terminology, fields, rates, layout | Whether the catalog is a menu, price list or treatment list |

Kitchen Display is **not** a sold module and is never shown in a picker. A candy shop buying POS
gets a till; a restaurant buying the same POS gets a till and prep screens. The principle survives:
POS still means "register a sale" everywhere.

### The industry profile

One input decides everything trade-specific: **business type**. A specialist records it at intake;
a self-serve merchant picks it from a **selector on the onboarding form**. It resolves to an
industry profile carrying four things: trade capabilities, term set, catalog template, and
documents/tax categories.

**What lands on the entitlement record:**

```
entitlement = tier module set  ∪  industry profile capabilities  ∪  manual overrides
```

The tier is chosen and paid for. The profile follows from business type and costs nothing.
Overrides are recorded per tenant by a specialist. The gateway checks the resulting set and neither
knows nor cares which source put an entry there — which is what stops a trade capability needing
its own enforcement path.

### Core modules must be trade-neutral

The platform ships 40+ industry configurations, so **a module that assumes one trade is wrong for
most tenants**. `POS` means "register a sale" — nothing more. A candy shop, a boutique and a salon
all need it and none of them has a kitchen.

Trade-specific capability goes one of two places, and the test is whether it has its own surface:

| Test | Where it goes | Example |
|---|---|---|
| Own screen, device or workflow | **A separate module** depending on the core one | Kitchen Display requires POS; sold only to food service |
| Only terminology, fields, rates or layout | **The industry profile**, applied from the trade template at provisioning | Whether the catalog is called a menu, a price list or a treatment list |

**If a description of a core module names a trade, that is the bug.** An earlier draft described POS
as including a kitchen display and tickets; that was corrected, and Kitchen Display became its own
module. Watch for the same leak in Bookings, Catalog and Website Builder when editing.

### Trade vocabulary — labels per industry

A hotel calls a catalog item a *Room*, a spa a *Service*, a restaurant a *Dish*, a shop a *Product*.
Same concept, same tables, same API — different word on screen. Handled as a **term set**: a map
from a stable semantic key to a word, layered over the language bundle.

**Keep the two axes separate.** Language is ordinary i18n. Trade vocabulary is an overlay on top of
it, so trades multiply by languages as *content*, never as code paths.

Resolution is a cascade, most specific wins:

```
base term set  →  industry term set  →  tenant override
   "Items"           "Rooms"              "Suites"
```

A new trade defines only the dozen terms that differ from base. Onboarding trade 41 is a content
change, not a release.

Delivery:
- **Term sets are content, not a service.** Versioned with the industry templates. Tenant Profile
  stores only the trade and any overrides — no new deployment, no network hop to render a word.
- **The dashboard fetches them once at login**, in the same bootstrap call as entitlements, cached
  in Redis the same way.
- **Services that render text need them too** — Invoicing, Notification, the storefront, and the
  Twenty object blueprint. Invoices say "Room", not "Item".
- **The admin console needs a term set editor**, so a specialist onboards a trade instead of filing
  an engineering ticket.

**The rule that makes it safe: a display term is never a key.** Database columns, API paths, event
payloads, analytics dimensions and search fields stay semantic — `catalog_item`, never `room`. If
`/api/rooms` ever exists, the hotel vocabulary is welded into the platform. Terms are presentation
only: renaming one must never imply a migration or change what a report counts.

### Pricing: tiers, not modules

**There is no per-module pricing.** A tenant sits on a subscription tier; the tier defines the
module set. Entitlement is still evaluated *per module* — that is what the gateway checks and what
the dashboard renders from — but the module count never enters a price calculation. Changing tier
is what changes the bill.

**Four tiers:**

| Tier | Modules granted | Auto-pulled | Seats | Also |
|---|---|---|---|---|
| Starter | POS & Orders, Bookings, Payments (the industry tool set) | Catalog, Inventory, Staff & Rota | 3 | Deployment and training |
| Growth | *+ Starter* + Website & Storefront, Marketing & Ads | Advanced Analytics | 5 | Budget reallocation across Meta/Google/TikTok |
| Max | *+ Growth* + AI Creative, CRM | — | 15 | Custom domain ⏳ |
| Enterprise | *+ **Max*** | — | Negotiated | Account team, SLA, custom integration, API access ⏳ |

⏳ = shipped as **"coming soon"** on the tier page rather than deferred silently. The Registry carries that state per perk, so the label disappears when the work lands — no release needed.

Seat counts are provisional; prices are unset. Both are Registry values — no code impact.

**Staff seats are a quota, not a module.** The limit lives on the entitlement record alongside the
module set, and is unrelated to the Staff & Rota module (shifts and availability, a Bookings
dependency in every tier). One seat = one person **across both surfaces**, so the limit is enforced
twice from one number: the Staff service refuses the seat, *and* CRM Sync must refuse to provision
the matching Twenty workspace member. Enforce it only in the dashboard and the CRM drifts past the
tier silently.

**Two perks still to build**, both advertised as coming soon: **custom domain** (Max) needs
per-tenant TLS issuance and renewal at Host NGINX; **API access** (Enterprise) needs a gateway
surface plus a service issuing keys, scopes and per-tenant rate limits.

**Module boundary changes the tiers forced:** AI Creative was split out of Marketing & Ads into its
own module (Growth gets budget reallocation, Max gets creative generation), and Marketing & Ads no
longer depends on CRM — only on Advanced Analytics. Budget reallocation reads booked revenue from
ClickHouse; it never needed CRM records.

Deviating from a tier is an entitlement override recorded against the tenant, visible in the admin
console and audit log, and deliberately does not move the price. Enterprise is simply the case
where the override *is* the tier.

**The marketing site now matches.** `landing-page/index.html`, `landing-page/script.js` and `pitch-deck.txt` all sell
Starter / Growth / Max / Enterprise. `PRICES` is keyed `{ starter, growth, max }`, the price
elements are `#pStarter` / `#pGrowth` / `#pMax`, and the comparison table, tier teaser, plan pills
and staff limits (3/5/15/Custom) were rebuilt to match. Prices carried over positionally as
placeholders — **89 / 189 / 349 monthly are not final.**

### Buying a tier: both routes

Merchants self-serve a tier change from their subscription page; specialists do it from the admin
console. **Both converge on the same Registry resolution and the same provisioning saga** — there
is no separate self-serve code path.

But they are not interchangeable per module. A self-serve upgrade completes unattended only if
every provisioning step it triggers can. KYC approval, ad-account OAuth consent and hardware
pairing cannot. So the Registry carries a **self-serve capable** flag per module; when a self-serve
upgrade pulls in a module that is not, payment is taken, everything that provisioned cleanly is
granted, and the rest is queued to a specialist with the tenant told what is still coming. It never
silently half-completes.

### Diagram conventions

Every diagram repeats the same five `classDef` blocks. Keep them identical:

```
client   fill:#eef4ff stroke:#3b6fd4   client / edge / frontend
service  fill:#f1f7ed stroke:#4f8a3d   microservice
control  fill:#ffeef0 stroke:#c0392b   control plane
infra    fill:#fff6e8 stroke:#c98420   data store / bus
external fill:#f7f0fa stroke:#8557a8   external provider / forked OSS
```

Solid arrow = synchronous call. Dotted (`-.->`) = asynchronous event.

**Mermaid authoring rules:**
- Quote every label: `Node["Label"]`. Unquoted parentheses break the parser.
- Write `&` as `&amp;` — the block is HTML, so entities are decoded before Mermaid sees them.
- `<br/>` works inside quoted labels for multi-line nodes.
- Edge labels: `-->|"text"|`.

---

## Stack

All open source, all self-hosted. Full table with licences in `system-architecture.html` §17.

**Go** for every service we write. **React + TypeScript** for the SPAs: four on the merchant
plane and the admin console on its own. **NestJS/TypeScript**
for the Twenty CRM fork — that one is not Go, and it brings a Node runtime and a second build
pipeline with it.

| | |
|---|---|
| Data | PostgreSQL · Redis (**pin ≥ 8.0**) · Kafka in KRaft mode · ClickHouse · MinIO |
| Kafka support | Apicurio (schema registry) · Debezium + Kafka Connect (CDC → ClickHouse) |
| Platform | k3s · Argo CD · goose · River · OpenBao · Unleash · Gotenberg · CloudNativePG |
| Observability | OpenTelemetry · Prometheus · Loki · Tempo · Grafana · GlitchTip |
| Testing | Pact — contract tests gate every market implementation |

### Proxies: three of them, two are NGINX

| Slot | Software | Why |
|---|---|---|
| Host proxy (TLS, custom domains) | **NGINX** | Throughput, static config is fine here |
| In-cluster ingress | **Traefik** | Watches the K8s API and reconfigures live; ships with k3s |
| Frontend pod (SPA bundles) | **NGINX** | Best-in-class static serving |

**Do not use `ingress-nginx`** — the Kubernetes project retired it. It worked by regenerating
`nginx.conf` and reloading, which is exactly the wrong model for a dynamic cluster.

### Licence notes

- **Redis 7.4 is RSAL/SSPL only.** The AGPLv3 option starts at 8.0 — pin accordingly.
- **AGPL components** (Redis, MinIO, Grafana, Loki, Tempo) are used as intended: self-hosted and
  unmodified. No special handling needed.
- **Rejected on licence grounds:** Redpanda (BSL), Confluent Schema Registry (Confluent Community),
  Vault (BSL — use OpenBao), Sentry (FSL — use GlitchTip).

### Not added, on purpose

Keycloak (shared session cookie removes the need), a search engine (Postgres FTS until proven
insufficient), self-hosted SMTP (deliverability is a full-time job).

### Patterns no dependency gives you

- **Transactional outbox** — nothing provides atomic "write to Postgres and publish to Kafka".
  Without it you lose events or emit phantom ones. Highest-value thing to get right first.
- **Contract tests** — the market-swappable pod design is only real if a new market's implementation
  must pass a suite before deploying.
- **River now, Temporal later** — Temporal is better at durable workflows but is several services
  plus its own datastore, per market VPS. Move when a second long-running workflow earns it.

**Third-party by necessity:** SMTP, SMS, card/wallet processing, ad platforms, LLM API. These sit
**inside the market-swappable boundary** — Hungary and Bangladesh will not share an SMS aggregator.

## Previewing and verifying `system-architecture.html`

`system-architecture.html` loads Mermaid from `cdn.jsdelivr.net`, so **rendering requires network access**.

### `file://` does not work

The Chrome automation tooling refuses `file://` URLs. Serve over localhost:

```bash
cd /home/windows/projects/twenty-four
python3 -m http.server 8917 --bind 127.0.0.1
# then open http://127.0.0.1:8917/system-architecture.html
```

Kill it afterwards with `pkill -9 -f "http\.server 8917"`.

### Screenshots are unreliable on this page

The page is ~21,000 px tall and the screenshot capture frequently returns blank or
half-painted frames. **Assert against the DOM instead** — it is faster and trustworthy:

```js
const blocks = [...document.querySelectorAll('.mermaid')];
const svgs   = [...document.querySelectorAll('.mermaid svg')];
({
  rendered: svgs.length,                     // must equal blocks.length (10)
  errors: blocks.filter(e => /Syntax error|Parse error/i.test(e.textContent)).length,
  scales: svgs.map(el => {
    const vb = el.getAttribute('viewBox').split(/\s+/).map(Number);
    return +(el.getBoundingClientRect().width / vb[2]).toFixed(2);
  })
})
```

### The readability rule

`scale` is rendered width ÷ intrinsic width. Below **~0.75** the 15 px labels become unreadable.

**If a diagram scales below 0.75, flip its orientation** (`flowchart LR` ↔ `flowchart TD`) and
re-measure. Wide-and-short diagrams shrink badly; the fix is almost always to make them tall
and narrow. If flipping does not help, the diagram is carrying too much — **move the detail into
a table** rather than shrinking the picture. That is why the BFF reach matrix, the provisioning
steps and the Kafka topic list are tables and not arrows.

Current state: all 10 diagrams scale **0.76–1.0**.

The sequence diagram is the one exception — it renders at natural size
(`sequence: { useMaxWidth: false }`) inside `<div class="diagram natural">`, which scrolls
horizontally in its own box. Squeezing 11 participants to fit made the text illegible.

---

## Backend conventions

Written once in `platform/packages/` and used by every service from Catalog
onwards. Auth and RBAC predate them and were deliberately not retrofitted.

| Package | What it is |
|---|---|
| `tenantctx` | Reads the gateway's identity headers into a context and refuses a request without a tenant. This is the whole of the tenant boundary; a missed scope is a cross-tenant leak |
| `pg` | Pool, embedded migrations, and a `Tx` helper a handler cannot leave open. Named `pg`, not `pgx`, so a file can also import `jackc/pgx` |
| `outbox` | Writes an event row in the caller's transaction; drains batches for the relay |
| `money` | The one place the platform knows what a currency is and how to round it. Catalog, Payments and eventually the ledger share it, because two currency tables is two answers to "does HUF have a subunit" |
| `grpcx` | Server with health, reflection, panic recovery and consistent logging; client with sane keepalives |

### Commands name surfaces, not deployments

`make pos-up` moves the till: its frontend *and* the POS service behind it. Same
for `auth` and `admin`. `make dashboard-up` moves the frontend alone, because
the dashboard reads from a dozen services and owns none of them, so each of
those keeps its own command. `-web-up` and `-api-up` address one half.

**Which names are paired is derived, not listed.** A name is a surface with two
halves when it has both `services/<name>/Containerfile` and
`services/web/apps/<name>/Containerfile`; one half makes it web-only or
api-only. So `bookings` moves its frontend alone today and will start moving
both the day the bookings service is written, with no list to remember to edit.
`system-up` picks a service up the moment it has a Containerfile, the same way.

The cluster monitor reads the same rule off the same directories, which is why
its buttons mean what the targets mean. They disagreed once: the monitor acted
on one Deployment, so stopping "pos" from it left the frontend serving a dead
API. Two lists, one of them wrong. There is now one rule and two readers.

`platform/deploy/inventory.tsv` names every backend service that has, or will
have, its own pod, built or not. Status displays read it, so an unbuilt service
shows as "not built yet" rather than not appearing. Keep it in step with
`backend-plan.md`.

**One row is one deployment**, which is not the same list as §3: that names
capabilities, this names things you can start and stop. Entitlement and the
module registry are tables inside Tenant; the onboarding checklist is the
provisioning saga's own rows. A row for something that can never be brought up
would be noise in a display about what is up. Do not add one back because §3
lists it; add one when something earns a deployment.

**Services do not authenticate.** The gateway verified the token, resolved the
tenant and checked the permission before anything downstream saw the request.
Network policy is what makes trusting those headers safe.

**Nothing writes to Kafka except the relay.** A service writes to its own outbox
in the transaction that made the change, and stops caring. That is what makes "a
third party being down must never block a sale" true rather than aspirational:
with the broker down, sales still commit and events queue in Postgres.

The relay claims, publishes and marks published in **one transaction**, so
delivery is at-least-once. **Every consumer must be idempotent**, keyed on the
`event-id` header or a natural key such as the order reference. It discovers its
work by reading a directory of DSN files projected from the `service-dsn`
Secret and draining the databases that have an `outbox` table, so adding a
service is a Secret change, not a relay change.

### The development payment provider

Payments ships with a provider where **a person decides**. A payment that needs
something outside the software is created `pending` with an `external_action_url`
pointing at an approval page; a human clicks Approve or Decline, and that is the
answer the till receives. `make pay-desk` opens each one in a browser tab.

That is not a shortcut, and it is worth defending. A provider that always
approved instantly would let callers quietly grow a dependence on synchronous
success, and the first real card terminal would break every one of them. A till
that has been made to wait for a human is a till that will cope with a card
machine.

Two things about its shape:

- **The approval page is not on `PaymentsService`.** There is no `Approve` RPC,
  because no real provider has one. What a real provider has is a hosted page
  the customer is sent to, and the desk sits in exactly that place: a separate
  HTTP surface on the same pod, outside the contract.
- **Cash is the one method that skips it**, because cash genuinely needs nothing
  outside the software. The money is in the drawer by the time the button is
  pressed.

The desk is unauthenticated: whoever is at the terminal is the customer, not a
merchant user, and knowing the payment's UUID stands in for holding the card.
That is thin, and is why this provider must never be deployed anywhere real.

### The merchant code

Six characters of Crockford base32 (`I`, `L`, `O`, `U` excluded, because the
first three are misread off a printed invoice and the fourth makes codes spell
things). Assigned once at signup, never changed, and **never reissued even after
a tenant leaves**: its documents are still referenced by tax authorities, and
reusing the code would make two businesses indistinguishable on paper.

It lives in **Auth** for now, because Auth mints the tenant ID at signup and is
the only service that knows a tenant exists at the moment one is created. Tenant
& Business Profile will own it eventually, so **nothing outside Auth reads the
table**: callers use `GetMerchantCode`, which is the same call they will make
once the rows have moved.

It is the middle field of the invoice number, which is one format in every
market: `2026-7QK3M9-110`, year-merchantcode-sequence. That is a **deliberate
deviation** from §7, which lists numbering as free to differ per market. It is
easy to reverse, since the format lives in the market-swapped Invoice service.

## Decisions taken

Recorded here so they are not relitigated. Full table in `system-architecture.html` §16.

| Question | Decision |
|---|---|
| Pricing model | **Tier-based subscription.** Starter, Growth, Max, Enterprise. No per-module pricing. |
| Tier contents | **Set** (see above). Seat counts 3/5/15 provisional; prices unset. |
| Tier structure | Starter/Growth/Max fixed sets; **Enterprise custom-provisioned per customer**. |
| Module purchase | **Both** self-serve and specialist-led, converging on one saga. |
| Release fan-out | **One central codebase**, built once and rolled out to each environment. |
| Admin console | **One per market**, seeing only that environment's tenants. |
| Twenty fork | **Owned by TwentyFour, merged from upstream every 15 days.** |
| Market variation | **One market per VPS**; Payments, Invoicing, Billing pods swapped per market. |
| Legal entity | **One entity per market**, matching the deployment boundary. |
| Ledger | **One ledger per environment** — one entity, one currency, one set of books. |
| CRM presentation | **Subdomain + shared session cookie.** Not OIDC, not an iframe. |
| Custom domains | **Deferred.** Keep the shape future-proof; build later. |
| Merchant code | **Six Crockford base32 characters**, assigned at signup, never reissued. Held in Auth, read through an RPC. |
| Invoice numbering | **One format in every market**: `year-merchantcode-sequence`. Gapless per tenant per year, allocated under a row lock. |
| Sign-in | **One form, on the merchant origin.** Auth resolves the plane from the address and answers with a destination. An address exists on one plane only. |
| Admin plane origin | **Its own subdomain and its own gateway.** Host-only cookie, never the parent domain. |
| Payment provider | **None yet.** A dev provider implements the contract deterministically; integrating a real one is a later pass touching one pod. |

## Still open

1. **Build custom domain** — per-tenant TLS issuance/renewal at Host NGINX. Advertised on Max as
   coming soon.
2. **Build API access** — gateway surface plus a key/scope/rate-limit service. Advertised on
   Enterprise as coming soon.
3. **Which modules are self-serve capable** — Registry flag per module. KYC, OAuth consent or
   hardware pairing must escalate to a specialist.
4. **Prices per tier, and final seat counts** — Registry values, no architectural impact.
5. **Which trade capabilities exist beyond Kitchen Display** — table and floor-plan management is
   the obvious next. Each needs a profile flag and a service, not a module.
6. **Group consolidation** — with one ledger per entity, nothing sees the group.
