# Backend services: build plan

How the remaining backend gets built, in what order, and why that order.

Reference: [`system-architecture.html`](system-architecture.html) for the design,
[`CLAUDE.md`](CLAUDE.md) for the decisions this code must respect,
[`roadmap.md`](roadmap.md) for where this sits in the product.

---

## Where we are

| Service | State |
|---|---|
| Auth | Real. Signup, login, sessions, PASETO tokens, lockout, password reset |
| RBAC | Real. Roles, permissions, plane isolation, 7 system roles seeded |
| Gateway | Real. Terminates `/api`, verifies tokens, checks permissions, owns the session cookie |
| Foundations | Real. `packages/tenantctx`, `pg`, `outbox`, `grpcx`, all tested |
| Outbox Relay | Real. Discovers outboxes, drains them to Kafka, reports its backlog |
| Catalog | Real. Items, categories, prices, tax, keyset paging, priced through the gateway |
| Staff | Real. Members, roles, invitations, the seat quota, staff events |
| Inventory | Real. Levels, moves, reservations, thresholds, stock events |
| Payments | Real, with a provider where a person approves each payment on a page |
| POS & Orders | Real. Sales, tabs, refunds, voids, takings, day close, the floor |
| Tenant | Real. Profile, entitlement, the module registry, tiers and 43 industry profiles |
| Provisioning | Real. The saga, the 24-hour checklist, and the SLA timer |
| Everything else | A gateway stub returning an empty collection |

The frontend already calls 34 endpoints. Every one that is not `/auth/*`,
`/bootstrap` or `/roles` is currently answered by a stub.

---

## What gets built

Nine services, grouped by the domains in the architecture.

### Commerce

| Service | Owns | Depends on |
|---|---|---|
| **Catalog** | Items, categories, prices, tax rules | nothing |
| **POS & Orders** | Orders, lines, tender, voids, parked sales, day close | Catalog, Inventory, Payments |
| **Bookings** | Calendar, slots, resources, deposits, no-shows | Catalog, Staff, Payments. **Deferred** |
| **Kitchen Display** | A view over POS orders. Not a service: a trade capability inside POS, switched on by the industry profile | Built with POS |
| **Inventory** | Stock levels, reservations, adjustments, thresholds | Catalog |
| **Staff & Scheduling** | Staff records, roles, rotas, availability | nothing |

### Finance

| Service | Owns | Note |
|---|---|---|
| **Payments** | Intents, authorise, capture, refund | Swapped per market. A development provider implements the contract; no real processor in this pass |
| **Invoicing & Billing** | Customer documents, numbering, tax lines, and the tenant's own subscription charging | Swapped per market. One numbering format for both markets, see Decisions. **Deferred** |

### Platform

| Service | Owns | Note |
|---|---|---|
| **Reporting & Analytics** | Dashboard figures and charts | Reads ClickHouse |
| **Outbox Relay** | Drains every service's outbox into Kafka | Internal, no API |

**Not built:** no dashboard service. The dashboard is a frontend; the gateway
composes its data from the services that own each piece. Adding a service whose
job is "be the dashboard" would put one team's screen layout in another team's
deployment.

---

## Shared foundations, written once

Nine services repeating the same code nine times is nine chances to get tenant
scoping wrong. These go in `packages/` first.

- **`tenantctx`** reads `X-Tenant-Id` and `X-User-Id` from the gateway's headers
  into a request context, and refuses a request that carries neither. Every
  query in every service scopes by that tenant. This is the single most
  security-critical package in the backend: a missed scope is a cross-tenant
  data leak.
- **`outbox`** writes an event row in the same transaction as the state change,
  and reads a batch back for the relay.
- **`money`** holds the currency table and the rounding rule, so Catalog,
  Payments and the ledger cannot disagree about whether HUF has a subunit.
- **`pg`** opens a pool, runs migrations from an embedded FS, and exposes a
  `Tx` helper so a handler cannot forget to roll back. Named `pg` rather than
  `pgx` so a file using it can also import `jackc/pgx` without renaming one of
  them, which every handler taking a `pgx.Tx` needs to do.
- **`grpcx`** builds a server with health, reflection and consistent logging,
  and a client with sane timeouts.

---

## The transactional outbox

Nothing in the stack gives atomic "write to Postgres and publish to Kafka".
Without the outbox a service either loses events, when the publish fails after
the commit, or emits phantom ones, when the publish succeeds and the transaction
rolls back. Inventory, the ledger and the CRM all derive their state from these
events, so both failures corrupt data that nobody is watching.

Every service gets the same table:

```sql
CREATE TABLE outbox (
    id            UUID PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    topic         TEXT        NOT NULL,
    key           TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    attempts      INT         NOT NULL DEFAULT 0,
    last_error    TEXT
);
```

`available_at` was not in the original sketch and earns its place. Without it a
row that can never be published is retried on every poll, forever, at the head
of the queue, and everything behind it waits. With it a failing row backs off
exponentially to five minutes and the rest keep moving.

The table is created by the `outbox` package rather than copied into each
service's migrations, under its own goose version table. Adding a column here
must not renumber anyone's migrations, and a service rolling its own schema back
must not take the outbox with it.

Writes look like this, and the two statements share one transaction:

```
BEGIN
  INSERT INTO orders ...
  INSERT INTO outbox (topic, payload) VALUES ('order.placed', ...)
COMMIT
```

**The relay** polls each service's outbox, publishes to Kafka, and marks rows
published. Delivery is at-least-once, so every consumer must be idempotent,
keyed on the event id or a natural key such as the order reference. That is a
property of the consumers, not something the relay can provide. The event id,
the tenant and the producing service ride along as Kafka record headers, so a
consumer can dedupe without parsing the payload.

Claim, publish and mark all happen in **one transaction**, which is what makes
at-least-once rather than at-most-once true: the rows are only marked published
after Kafka has acknowledged them, and a crash in between re-publishes rather
than drops. `SELECT ... FOR UPDATE SKIP LOCKED` is what keeps that safe if a
second relay is ever run.

It finds its work by reading a **directory of DSN files** projected from the
`service-dsn` Secret, and drains the databases that have an `outbox` table.
Auth and RBAC have none and are simply passed over. Adding the tenth service is
then a Secret change rather than a relay change, and a service that grows an
outbox later is picked up on the next scan.

### Topics

From the architecture's catalogue. Only the producers built in this pass are
listed.

| Topic | Producer |
|---|---|
| `order.placed`, `order.voided` | POS & Orders |
| `booking.created`, `booking.cancelled`, `booking.no_show` | Bookings |
| `payment.succeeded`, `payment.refunded` | Payments |
| `invoice.issued` | Invoicing & Billing |
| `stock.low`, `stock.adjusted` | Inventory |
| `staff.added`, `staff.removed` | Staff & Scheduling |

---

## The analytics pipeline

Analytics reads ClickHouse, never the operational stores. A reporting query
against the same database that is taking payments is how a busy Saturday becomes
an outage.

```
PostgreSQL -> Debezium -> Kafka -> Kafka Connect -> ClickHouse -> Analytics API
```

Three new workloads per market: Debezium, Kafka Connect and ClickHouse. That
cost is why the architecture insists ClickHouse is fed only by CDC and never
double-written by services: a service writing to both stores drifts the first
time one write succeeds and the other does not.

---

## Build order

Dependencies dictate this. Each phase is deployable and verifiable before the
next begins.

### 1. Foundations: done
`packages/tenantctx`, `pg`, `outbox`, `grpcx`. Plus the outbox relay, so the
first service that emits an event has somewhere for it to go.

Auth also gained the **merchant code**: a table, an assignment at signup, a
backfill for the tenants that predate it, and `GetMerchantCode` for Invoicing to
read it. Small, but it belonged in this phase because Invoicing cannot issue a
document without it.

*Verified: a row written into a service outbox reached the Kafka topic with its
event id, tenant and source headers intact, and signup assigned and returned a
merchant code.*

Auth and RBAC were **not** retrofitted onto the new packages. They work, they
predate the packages, and rewriting a working service to use one is churn. Every
service from Catalog onwards uses all four.

### 2. Catalog: done
Nothing depends on it that does not exist, and POS, Bookings and Inventory all
depend on it. Its pricing arithmetic and proto were already written and tested.

*Verified: a dish created in the Menu editor appeared on the till immediately,
with the browser and the Go pricing package agreeing on the net figure.*

Three things settled here that the next seven services inherit:

**No request carries a tenant.** The proto has no `tenant_id` field at all.
Auth and RBAC still have theirs, because they predate the interceptor and some
of their calls genuinely have no tenant yet; every service from here on leaves
the field out, so scoping from the request body is not a rule to remember but a
thing that cannot be written.

**Ownership is checked in the statement, not before it.** A category is keyed by
ID alone, so the foreign key alone would happily accept another tenant's
category. The guard is part of the INSERT, which also closes the window where
the category is archived between a check and a write.

**Paging is keyset, not OFFSET.** A till scrolling its catalogue while a
colleague adds a product is exactly the case where OFFSET shows an item twice,
and "the coffee appeared twice" is the kind of bug nobody reports.

Catalog has **no outbox**. The architecture lists no catalog topics: ClickHouse
gets these tables through CDC, not events. The relay reads its DSN directory,
finds no outbox table in the catalog database, and passes over it, which is the
first real use of that design.

### 3. Staff and Inventory: done
Independent of each other, both depending only on Catalog. Staff also enforces
the seat limit, which is the first tier quota that bites.

*Verified: the Team page lists three real people with their real roles and
seat states, and the Inventory page shows a real level with a low-stock
warning. All four topics carry real events.*

**The relay needed no change.** Two new databases appeared with outbox tables
in them and it started draining both within a minute, from a Secret update
alone. That was the point of the DSN-directory design and it is now proven
rather than asserted.

Three things settled here:

**A member's ID is their Auth user ID.** Staff holds the employment view of a
person; the login is Auth's and the role is RBAC's. One person, one identifier
everywhere, which is what makes "one seat is one person across both surfaces" a
statement about a number rather than about a join. When CRM Sync exists it
refuses the Twenty workspace member from that same number.

**An invitation holds a seat.** A seat that frees up while someone is slow to
read their email is a seat that gets sold twice. Deactivating releases one and
keeps the person's history. Auth grew `InviteUser`, `AcceptInvite`,
`ReissueInvite`, `ReactivateUser` and a narrow `DeleteUser` that refuses anyone
who has ever signed in, because their name is on documents.

**Stock is a ledger, not a counter.** Every change is a move with a reason and
the level is derived, so "why is this number 3" has an answer. The level, the
move and the event commit together. `stock.low` fires on the crossing and
re-arms when the level climbs back, because a warning that arrives forty times
is a warning nobody reads.

One PostgreSQL trap worth recording: **`INSERT ... ON CONFLICT DO UPDATE`
evaluates CHECK constraints against the tuple the INSERT proposes**, before it
discovers the conflict and switches to the update path. An upsert applying a
delta of -2 therefore failed `reserved >= 0` on the proposed row even though the
resulting row was valid. The fix is ensure-then-update: two statements in one
transaction, so the constraint sees the final value. Any service applying a
signed delta to a constrained column will hit this.

### 4. Payments: done
Contract-first, with a **development provider** behind it where a person
approves or declines each payment on a page. Nothing upstream can tell it is not
a real processor, which is exactly the property the market-swap design depends
on.

*Verified: cash captures with no page, a card payment waits for a person and
settles to whatever they chose, a repeated idempotency key never charges twice,
refunds are partial then full and cannot exceed the payment, and both events
reach Kafka.*

**Approval is deliberately manual rather than deterministic.** The plan said a
dev provider that "approves or declines deterministically"; making it a person
instead is a stronger version of the same idea. A provider that always answered
instantly would let callers grow a dependence on synchronous success, and the
first real card terminal would break them. A till that has been made to wait for
a human is a till that will cope with a card machine.

Three things settled here:

**There is no Approve RPC.** `PaymentsService` has no such call because no real
provider has one. The approval desk is a separate HTTP surface on the same pod,
exactly where a hosted payment page sits. Keeping it off the contract is what
stops a caller ever writing code that only works against this provider.

**Cash skips the desk**, because cash needs nothing outside the software. That
is what `requires_external_action` on a method means, and the till renders its
buttons from `ListMethods` rather than hardcoding "cash or card".

**`packages/money` now holds the currency table and the rounding rule**, moved
out of Catalog. Payments needed to know whether HUF has a subunit, and two
currency tables is two answers to that question. The money rules are not
guidance: an amount rounded one way on a receipt and another way in the books is
a reconciliation problem that surfaces months later.

### 5. POS and Orders: done

The first service that composes several others: prices from Catalog, money
through Payments, stock through Inventory. It holds none of their data, with one
exception that matters: the priced lines are copied onto the order and never
re-read, because a sale must not change because somebody edited a price
afterwards.

*Verified: a cash sale, a card sale that waited for a person and completed when
approved, a decline that left no sale and no stock movement, a tab parked,
edited, and settled, a full refund that went back through the card that paid,
the day closed 60 short, and `order.placed` on the bus.*

Five things settled here:

**Money first, then the record.** Price, take payment, write the sale. Writing
the order first would leave a sale on the books for money that was never taken
when a terminal declines; taking the money last means a crash between the two
leaves a sale nobody paid for. Money first is the recoverable order, because the
idempotency key finds the payment again on a retry.

**If any tender fails, the ones already taken are refunded.** A customer who
paid half in cash and was then declined on the card must not be left having paid
half. The sale did not happen, so neither did any part of the payment.

**The till blocks while a card is approved.** That is what a card terminal
actually feels like: press Charge, the machine beeps, everybody waits. Returning
early with "pending" would mean the screen has to poll and the sale sits in a
state nobody can explain to a customer at the counter. POS bounds the wait
itself at three minutes.

**Money goes back the way it came.** A refund is split across the payments that
took it, in proportion. Refunding it all to the card because that is easier
would leave the drawer over and the card statement short, and somebody would
spend an afternoon on it at month end. Expected cash at day close is derived
from what was actually tendered in cash, never from the day's total.

**Stock moves on the sale, not on the payment.** Parking reserves, settling
consumes the reservation, a walk-in consumes unreserved, and a void or refund
puts it back. That is the callout the architecture keeps in §6: decrementing on
`payment.succeeded` alone silently breaks cash sales, comps and unpaid bookings.

Two bugs the verification caught, both in the gateway rather than in POS:

- **The Traefik errors middleware was on `/api`.** It exists to serve the
  "temporarily unavailable" page when a frontend is scaled to zero. On the API
  it replaced every genuine 5xx with that HTML page, so a JSON client could not
  read the error it was given. A card payment nobody approved came back as "the
  service is down".
- **`DeadlineExceeded` mapped to 503.** Nobody approving a payment is not an
  outage. It is now 408 with the message saying where the payment is still
  waiting.

### Signup and auto-provisioning: done

A merchant fills in the form and lands on a working dashboard. Auth creates the
account, tenant ID and merchant code; Provisioning resolves what they bought and
runs the saga; the gateway signs them in.

*Verified: a pizzeria on Growth got twelve modules, both trade capabilities, a
seeded menu, twelve tables and a checklist; a bookshop on Starter got nine
modules, no capabilities, a retail catalog and no floor step at all.*

**Two services, not one, and not five.** The architecture lists five control
services. Provisioning is genuinely its own, because a saga is its own kind of
thing: steps that run in order, fail halfway, retry, and sometimes need a
person. That state has to survive a crash, be resumable, be inspectable by a
specialist and readable by a merchant, and none of that is true of a tenant
record, which is simply a set of facts. Entitlement lives inside Tenant because
a tenant's module set is not separable from the tenant: written in one
transaction, read in one call. The Module Registry is a table inside Tenant,
because a deployment whose job is to hold constants earns nothing. Onboarding's
checklist lives inside Provisioning because it is literally the saga's rows.

**The checklist and the saga are the same rows.** Two lists of the same work
disagree the first time one is wrong, and the one the merchant is reading is the
one nobody notices is stale.

**`selfServeCapable` does real work.** Payments needs KYC and marketing needs ad
account consent, so both are granted `pending` and queued to a specialist, on
the checklist from the first minute rather than as a surprise on day two. A
specialist completing the step clears the pending flag, which is verified.

**Trade capabilities come from the profile, not from a picker.** A pizzeria gets
kitchen display and table management and a floor plan step; a bookshop gets
none of the three and never sees that they exist. There is one input: business
type.

**The registry exists twice and is tested against itself.** Go here, TypeScript
in `services/web/packages/entitlement`, which the dashboard renders from. The
Go tests read the TypeScript and assert the module IDs, the tier grants and the
industry list agree, so a change on one side that is not made on the other fails
rather than drifting into a merchant seeing a module the gateway then refuses.

Two bugs the verification caught:

- **An unknown industry created an orphan account.** Provisioning failing is
  survivable by design and the account stays, but a business type that does not
  exist is not a failure, it is a request that was never going to work. The
  gateway now resolves the tier and trade before creating anything.
- **The password rule disagreed with the form.** The client hardcoded ten
  characters; Auth enforces twelve by default and four in development. Auth now
  serves the number it actually enforces at `GET /api/auth/policy`.

### Deferred: Invoicing & Billing, Bookings

Set aside for now, not abandoned. Everything they need exists: Catalog prices,
Inventory reserves and consumes, Payments takes money and announces it, POS
announces `order.placed`, Staff says who is working.

**Invoicing and Subscription Billing merged into one service.** Both issue
fiscal documents under a market's rules; both need numbering, layout, mandatory
fields and local tax treatment. The only real difference is who the document is
addressed to. Two services would have meant two implementations of the same
machinery in every market. That makes the market-swapped set **two pods, not
three**. The risk: dunning and cycle charging are genuinely different work from
issuing a receipt, so if that half grows a life of its own it splits back out.
The seam to keep clean is that nothing outside the service knows which kind of
document it asked for.

### 6. Analytics and the CDC pipeline
ClickHouse, Debezium, Kafka Connect, and the reporting API over them.

*Done when: the Financials page shows figures derived from real orders.*

---

## Rules every service follows

- **Own schema, own database.** No service reads another's tables. It calls the
  owning service or consumes its events.
- **Tenant scoping on every query.** From `tenantctx`, never from a request body.
  A tenant id a client can set is a tenant id a client can change.
- **Money is integer minor units plus an ISO currency code.** Never a float,
  including inside event payloads.
- **No country logic.** Market variation is deployment, never a branch.
- **A display term is never a key.** `catalog_item`, never `room`.
- **Services do not authenticate.** The gateway did that. They trust the headers
  because network policy means nothing else can reach them.
- **Fail closed.** An error in a permission or entitlement check denies.

---

## Deployment

Each service follows the pattern the existing ones use: its own Containerfile
built from the workspace root, its own Deployment and Service, self-migrating on
start, gRPC health probes.

```bash
make catalog-up          # one service, reusing its image
make catalog-up REBUILD=1  # rebuild from source first
make system-up           # everything
make system-status       # what is up, and whether it is running current images
```

Per-market pod count rises by nine services plus three pipeline workloads. At
one replica each in development that is twelve more pods; at production replicas
it is roughly twenty-five. That is the cost the architecture already accounts
for in its deployment topology.

---

## Decisions taken

Recorded here so they are not relitigated mid-build.

### No real processor yet

Payments ships with a **development provider where a person decides**. It
implements the same contract a real one will, so nothing upstream can tell the
difference, which is the property the market-swap design depends on. Integrating
Barion, SimplePay, bKash or anything else is a later pass and touches one pod.

The one thing this defers rather than removes: **KYC and connected-account
onboarding take real calendar time**, and no amount of engineering shortens
them. Whichever provider is chosen, that clock should start well before the
service is ready to talk to it.

### Invoice numbering

One format in every market:

```
2026-7QK3M9-110
year-merchantcode-sequence
```

- **year** resets the sequence, so a merchant's numbering restarts each January.
- **merchantcode** is six alphanumeric characters, assigned once at provisioning
  and never reissued. See below.
- **sequence** is gapless and per tenant per year, allocated inside the same
  transaction that issues the document so two concurrent sales cannot take the
  same number.

Gapless is the hard constraint, not the format. It rules out allocating the
number before the document is committed, because a rolled-back transaction would
leave a hole, and Hungarian rules treat a hole as something to explain to an
auditor. The allocation is therefore a row lock on a per-tenant counter, not a
Postgres sequence.

#### The merchant code

Six alphanumeric characters, assigned once when the tenant is created and never
changed. It appears on every document that tenant will ever issue, so it has to
outlive everything except the tenant itself.

**It lives in Auth for now.** Tenant & Business Profile will own it eventually,
but that service is not in this pass and the code needs a home with a uniqueness
constraint today. Auth already mints the tenant id at signup, so it is the only
service that knows a tenant exists at the moment one is created.

Moving it later is a migration plus a lookup change, so keep the seam clean:
nothing outside Auth reads the column directly. Invoicing asks for the code
through an RPC, which is the same call it will make once the column has moved.

Three decisions inside that:

**Assigned, not derived.** A code derived from the tenant id would need no
registry, but it would also be unreadable and unchosen. Assigning it means the
uniqueness constraint does the work, and a merchant can be told their code.

**Never reissued, even after offboarding.** A tenant that leaves keeps its code
reserved. Documents it issued remain valid and are still referenced by tax
authorities and its own accountants; reusing the code would make two businesses
indistinguishable on paper.

**Ambiguous characters excluded.** The alphabet is Crockford base32:

```
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

with `I`, `L`, `O` and `U` removed. `I` against `1` and `O` against `0` are read
wrong when a code is copied off a printed invoice, which is exactly how these
are used. `U` is dropped because a random six-character string will otherwise
occasionally spell something a merchant has to see on every invoice.

That leaves 32^6, about a billion codes, so random assignment with a uniqueness
check will effectively never collide. The service retries on the unique
violation rather than pre-checking, because a check followed by an insert is a
race.

Whether the code is shown to merchants or only appears on documents is a product
decision, not an architectural one. It costs nothing to expose later.

**This is a deliberate deviation.** `system-architecture.html` §7 lists the
numbering scheme as free to differ per market, precisely because Hungary and
Bangladesh prescribe formats independently. Using one format everywhere is
simpler to build and simpler to explain, and it is easy to reverse: the format
lives in the market-swapped Invoice service, so a market that rejects it changes
one pod. The risk is that a tax authority requires something specific and this
has to be unpicked after documents have been issued under it, and an issued
invoice is immutable.

Worth confirming with local accountants in both markets before the first real
document is issued, rather than before the code is written.

## Open questions

Worth settling before the phase that depends on each.

1. **Whether Kitchen Display ships in this pass.** It is a trade capability
   rather than a module, switched on by the industry profile. POS can emit what
   it needs without it existing.
2. **Retention on the outbox.** Published rows accumulate. Dropping them loses
   the audit trail; keeping them forever grows the table without bound. The
   relay ships with retention **off** and a `-retain` flag, so the decision is
   taken deliberately rather than by whatever the default happened to be. It
   needs an answer before a market has enough volume for it to matter, not
   before the next phase.
