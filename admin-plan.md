# One sign-in, and an admin console on real services

Two changes, planned together because the second depends on the first.

1. **One sign-in form.** Credentials go to Auth, Auth decides which plane the
   account belongs to, and the answer decides where you land: the merchant
   dashboard, or the admin console.
2. **The console reads the real services.** Every screen backed by the
   microservice that owns the data, instead of by the admin mock store.

Reference: [`system-architecture.html`](system-architecture.html) §1, §10, §14.
Rules: [`CLAUDE.md`](CLAUDE.md). Sequencing: [`backend-plan.md`](backend-plan.md),
[`frontend-plan.md`](frontend-plan.md).

---

## The good news, before the work

**Both planes are already in the contracts.** This is not a new concept being
retrofitted; it is a concept that was designed in and never wired up.

| Already there | Where |
|---|---|
| `Plane` enum, `PLANE_TENANT` / `PLANE_ADMIN` | `auth.proto`, `rbac.proto` |
| `User.plane` | `auth.proto` |
| `LoginRequest.plane`, `VerifyTokenRequest.expected_plane` | `auth.proto` |
| `Role.plane`, `CheckRequest.plane`, "the two never mix" | `rbac.proto` |
| TOTP enrol and confirm, "admin plane only, MFA is mandatory there" | `auth.proto` |
| `Identity.Plane` carried into every service | `packages/tenantctx` |
| `x-plane` header, set by the gateway from the verified token | `packages/tenantctx` |

What is missing is not the model. It is that `gatewayd/auth.go` hardcodes
`Plane_PLANE_TENANT` on login, and the admin console signs in against its own
mock.

**And the bigger finding for part two:** `GetProfileRequest`,
`GetEntitlementRequest` and provisioning's `GetRequest` are **empty messages**.
The tenant comes entirely from the `x-tenant-id` header. So an admin gateway
addressing any tenant is a matter of *setting that header*, not of adding a
tenant argument to thirty RPCs. Most of the per-tenant console needs no proto
change at all.

---

# Part one: one sign-in, two destinations

## The flow

```
                app.twentyfour/auth  ← one form, one pair of fields
                          │
                    POST /api/auth/login
                          │
                     Auth.Login  (plane unspecified: resolve it)
                          │
              ┌───────────┴────────────┐
   user.plane = TENANT          user.plane = ADMIN
              │                         │
   set tf_session                 mint a handoff code
   on the parent domain           (single use, 30s)
              │                         │
   → app.twentyfour/            → admin.twentyfour/session?code=…
                                        │
                             POST /admin/api/session/exchange
                                        │
                             set tf_admin_session, HOST-SCOPED
                                        │
                                 → admin.twentyfour/
```

## The three invariants

These are what keep "one form" from becoming "one plane". Everything else in
part one is mechanics.

**1. Audience binding.** The tenant gateway verifies with
`expected_plane: PLANE_TENANT`, the admin gateway with `PLANE_ADMIN`. A token is
valid on exactly one plane. The field already exists and is already checked;
this only means the admin gateway passes the other value.

**2. Cookie scope.** The merchant cookie stays on the parent domain, because the
dashboard, till, calendar and the Twenty CRM subdomain share it, which is the
point of the merchant origin. The admin cookie is **host-only**: no `Domain`
attribute, so it is never sent to a sibling subdomain. Two different cookie
names as well, so neither can be mistaken for the other in a log.

> This is the single line of code that keeps the planes apart in the browser.
> It should carry a comment saying so.

**3. MFA and the allowlist stay on the admin gateway.** The password becomes
shared machinery. The extra gates do not move and are not weakened: an admin
account has TOTP enrolled, `Login` refuses without a code, and the admin gateway
refuses a source address outside the allowlist regardless.

## Why a handoff code rather than a redirect with the token

The form is served from the merchant origin, so it cannot set a cookie for the
admin host. Something has to cross.

It must not be the token. A token in a URL lands in browser history, in the
`Referer` header, in the access log of every proxy on the path, and in whatever
the specialist's browser syncs to. So Auth mints a **single-use code**: 30
second TTL, bound to the resolved user and to the client address, stored in
Redis, deleted on first exchange. The admin gateway swaps it for the real token
server-side and sets the cookie itself.

If the code is replayed, the second attempt fails. If it leaks, it has expired.

## Changes

| Where | Change |
|---|---|
| `auth.proto` | `LoginRequest.plane` unspecified now means "resolve from the account" rather than defaulting to tenant. Comment says so. |
| Auth service | `Login` with no plane looks the account up by email alone and answers with its plane. TOTP enforcement unchanged. |
| Auth service | New `ExchangeHandoff` RPC, or a Redis-backed code issued inside `Login`. Prefer the RPC: the code is Auth's to mint and Auth's to burn. |
| `gatewayd/auth.go` | Stop hardcoding `PLANE_TENANT`. Branch on `resp.User.Plane`: tenant sets the cookie and answers `{ session, redirect }`; admin sets no cookie and answers `{ redirect }` only. |
| Admin gateway | `POST /admin/api/session/exchange`, host-scoped cookie, then `GET /admin/api/auth/session` and `DELETE` as the console already expects. |
| `apps/auth` | One form. On success, `window.location.assign(response.redirect)`. Nothing else changes: the form already collects exactly email and password. |
| `apps/admin` | `AdminGate` stops rendering a sign-in. Signed out redirects to `app.twentyfour/auth`. `SignInPage.tsx` is deleted. |
| `packages/mock` | The admin mock's `signIn` becomes the exchange, so the dev-only role picker moves to the one form. |

The console loses a screen and gains nothing, which is the right trade: a second
sign-in form was always a second place for the password rules to drift.

## What this costs

**Staff sign in with a password, not SSO.** §1 says Google Workspace SSO for the
admin plane. This is a deliberate, temporary deviation, and it is cheap to
reverse: Auth is the thing that decides the plane either way, so SSO lands as
another credential Auth accepts and no caller changes. Recorded as a decision,
not as an oversight.

---

# Part two: the console on real services

The console's `/admin/api` contract is already written and does not change. What
changes is what answers it: an **Admin Gateway** that fans out to the services
that own the data, replacing the mock handler by handler.

`admin-gateway` is already in `deploy/inventory.tsv` as `later`.

## What backs each screen

| Console screen | Owned by | Available |
|---|---|---|
| Tenant → the business | Tenant `GetProfile` | **now** |
| Tenant → what they hold | Tenant `GetEntitlement` | **now** |
| Tenant → their trading | POS `GetTakings`, `ListOrders` | **now** |
| Tenant → seats | Staff `GetSeats`, `ListMembers` | **now** |
| Tenant → Sales | POS `ListOrders`, `GetOrder` | **now** |
| Tenant → Getting live | Provisioning `Get`, `RetryStep` | **now** |
| Tenant → tier change | Tenant `ApplyTier`, `ResolveTier` | **now** |
| Tenant → module override | — | new RPC |
| Tenant → suspend, reinstate | — | new RPC + a field |
| Tenants directory | — | new RPC |
| Getting live queue | — | new RPC |
| Tiers and modules, reading | Tenant `ResolveTier` | **now** |
| Tiers and modules, editing | Registry, inside Tenant | new RPC |
| Team and roles | Auth `ListUsers`, RBAC `ListRoles` | **now**, with a plane filter |
| Settings | Deployment config | **now** |
| Tenant → Billing | Invoicing | **deferred** |
| Platform billing | Invoicing, Ledger | **deferred** |
| Tenant → Audit, Audit log | Audit | **deferred** |
| Impersonation | Support | **deferred** |

Roughly two thirds can be real against services that exist today. The deferred
third stays on the mock **behind the same contract**, so those screens do not
change when their service lands.

## The rule for cross-tenant reads

Everything per-tenant works by setting `x-tenant-id` to whichever tenant the
specialist opened. Nothing about `tenantctx` changes, and the tenant boundary
holds exactly as it does for a merchant request.

The directory and the queue have **no tenant to put in the header**. They are
the genuinely new thing, and the temptation is to bypass `tenantctx` or invent a
platform tenant. Both are wrong: a wildcard tenant that reaches a `WHERE` clause
is a cross-tenant leak with a plausible explanation attached.

Instead:

- Cross-tenant reads are **their own RPCs**, never a mode of an existing one.
- Each begins with `tenantctx.RequireAdmin(ctx)`, a new sibling of
  `tenantctx.Tenant(ctx)`, which refuses anything whose verified plane is not
  admin. Four lines, written once, for the same reason `Tenant` is: nine
  services writing their own is nine chances to get it wrong.
- Network policy allows these ports from the admin gateway only.

New RPCs, all admin-plane:

| RPC | Why |
|---|---|
| `TenantService.ListTenants` | The directory. Paged, filtered by status, tier, health. |
| `TenantService.SetStatus` | Suspend and reinstate. `Profile` gains a status field. |
| `TenantService.SetModuleOverride` | Grant or withdraw one module against the tier, with actor and reason. `Entitlement` gains the override list it currently resolves away. |
| `TenantService.SetTierGrants` | The registry write, with the ladder check. |
| `ProvisioningService.ListRuns` | The queue, ordered by deadline. |
| `AuthService.ListUsers` | A plane filter, so the admin staff list is a query rather than a second RPC. |

Every write carries actor and reason and writes its outbox row in the same
transaction. The console already requires a reason on all of them; this is where
that reason stops being decoration.

## The aggregate problem, named early

Platform MRR, and sales across thirteen tenants, are computed in the mock by
summing a list the console already fetched. That does not survive two hundred
tenants: it is an N+1 across services on every page load.

Three options, in the order they should be taken:

1. **Now.** The admin gateway fans out with a bounded concurrency and a short
   cache. Honest, and it caps the damage.
2. **Cheap.** Tenant holds denormalised counters, updated from Kafka. Removes
   the fan-out for the directory, which is the hot page.
3. **Properly.** Analytics over ClickHouse, phase 6 of the backend plan. This is
   what the architecture already says these queries are for.

What must not happen is the console keeping the sum client-side and nobody
noticing until a demo with real data.

---

## Build order

| Slice | What lands | Ends with |
|---|---|---|
| **A1 — done** | Auth resolves the plane; gateway branches; handoff code; a minimal admin gateway that does only sessions | One form. Signing in as a specialist lands you in the console, still on its mock. |
| **A2 — done** | Roles reconciled; `RequireAdmin`; the directory and the tenant record, real | Tenants and the tenant overview come from Tenant, Staff and Auth. |
| **A3** | POS trading figures, the provisioning queue and run, `ListRuns` | Sales and Getting live are real. |
| **A4** | The writes: tier change, module override, suspend, registry edit | The console can change things, and each change is a real outbox event. |
| **A5** | Whatever Invoicing, Audit and Support land with | Billing, the audit log and impersonation stop being mocked. No console change. |

A1 through A4 need no new service beyond the admin gateway. A5 is not scheduled
here; it follows those three services in `backend-plan.md`.

---

---

## A1, as built

All four decisions confirmed as recommended. What landed, and where it differs
from the plan above.

### The flow, as it actually runs

```
   app.twentyfour/auth          one form, one pair of fields
        POST /api/auth/login    caller_plane: TENANT
              │
        Auth.Login              resolve the account by address alone
              │
   ┌──────────┴───────────┐
 account is TENANT      account is ADMIN
   token + cookie         no token at all, a 30s single-use code
   { session, redirect:"/" }   { redirect: "https://admin…/session?code=…" }
                                        │
                          POST /admin/api/session/exchange
                                        │
                          tf_admin_session, host-only
```

### Three things came out better than planned

**The tenant gateway never holds an admin token.** The plan had it receive one
and decline to set it as a cookie. `LoginRequest` gained `caller_plane` instead:
the caller says which gateway is asking, and Auth returns a token only when the
account belongs to that plane. "The merchant gateway sets an admin cookie" is
now an impossible bug rather than an avoided one.

**No token is stored at rest.** The handoff row holds a session id, not a token,
and redeeming issues a fresh one against that session. A bearer token in a
backup was avoidable, so it was avoided. It also means a sign-out between
issuing and redeeming invalidates the code, because the session is checked again
on the way through.

**The exchange is one path in both environments.** The plan had the admin
gateway answer `GET /session` with a redirect, which keeps the code out of
JavaScript and is marginally better. It is also a path a Vite dev server cannot
perform, so development would have run a different flow from the one that ships.
The console owns `/session` and calls `POST /admin/api/session/exchange`
instead, and clears the code from the address bar before anything else happens.
One path both environments take was worth more than the margin.

### What A1 needed that the plan did not mention

**Nothing could create an admin account.** Auth's `CreateUser` was only ever
called with `plane: "tenant"`, so there were no specialists to sign in as. Added
`AuthService.CreateStaff` and `make seed-staff`. An admin account has a nil
tenant id, which `tenantctx` refuses, so an admin token cannot reach a
tenant-scoped RPC unless the admin gateway names a tenant explicitly. That is
the A3 boundary, enforced from day one by accident of the type.

**Two gateway internals became shared packages.** `httpx` and `session` lived
under `services/gateway/internal/`, which Go makes unimportable from anywhere
else. They are now `packages/httpx` and `packages/websession`. The second one
carries the cookie-scoping rule in its own docblock, which is where it belongs:
it is the whole browser-side separation of the two planes, and it should be
readable in one place rather than inferred from two call sites.

**`admin` is a surface, not a frontend plus a service.** The Makefile's own
philosophy is that a target names a surface, and the admin gateway exists only
to serve the console. `make admin-up` now moves both halves; `admin-web-up` and
`admin-api-up` address one.

### What A1 deliberately did not do

The IP allowlist is implemented and empty. The service logs a warning while it
is, and refuses nothing. Local development has no meaningful network boundary to
enforce, and a real environment sets the office ranges and the VPN.

MFA is enforced by Auth when an account has TOTP enrolled, and `CreateStaff`
does not enrol it. So a seeded specialist signs in with a password alone today.
`EnrollTotp` and `ConfirmTotp` exist; making enrolment mandatory before a staff
account can be used is a small, separate change and belongs with the team screen
in A4.

### One thing A2 hits immediately

**The console and RBAC disagree about what an admin role is.** The console's
`AdminRole` is `platform_owner | provisioning | support | finance | auditor`,
which came from the design import. RBAC's admin-plane system roles are
`platform_admin | specialist | support`. The admin gateway's session endpoint
returns the RBAC key, so the first screen to read a real session will get a role
the console's type does not cover.

The registry wins, by the same rule that removed the console's invented module
list: RBAC is what the gateway enforces against. Reconciling it is the first
task in A2, not a footnote in it.

---

---

## A2, as built

### The sequencing in the plan above was wrong

A2 was scoped as "the per-tenant reads" and A3 as "the directory". That does not
ship: the directory is how a specialist reaches a tenant at all, so per-tenant
reads with a mocked list would have meant real pages nothing could navigate to,
addressed by ids the mock invented. `ListTenants` moved into A2. A3 is now the
trading figures and the saga.

### What is real now

| Screen | Answered by |
|---|---|
| Tenant directory | Tenant `ListTenants`, Auth `ListMerchantCodes`, Staff `GetSeats` |
| Tenant overview | Tenant `GetProfile` and `GetEntitlement`, Staff `GetSeats` |
| Environment and settings | The admin gateway's own deployment flags |

Everything else still answers from the mock, behind the same contract.

### Three things the data model did not have

**Nothing stored an address, a tax number or a status.** The tenant record had a
name, a trade, a tier, a locale and opening hours. An invoice needs the first
two and the console's whole suspend flow needs the third, so `tenants` gained
`address`, `city`, `tax_id`, `status`, `status_reason`. Empty for every existing
tenant, because backfilling a guess is worse than a field a specialist can see
is empty.

**The tier registry carries no prices.** Seat counts are set; prices are not.
So there is no MRR anywhere in the platform, and the gateway returns null rather
than inventing one. `TenantSummary.mrr` is nullable, the directory's MRR column
and platform-MRR tile render only when a price exists, and the console says "not
recorded" rather than showing a figure nobody agreed. This is the honest state
until prices land in the registry.

**The entitlement record knew why a module was held and never said so.** Every
row already carried `source` (tier, profile, override); the wire type did not.
`Entitlement.grants` now carries it, alongside the plain id list the gateway and
the dashboard read. The console shows "why do they hold this", which is the
question a specialist actually has, and the override list it used to keep
separately is gone: it was the same information, derived twice.

### The role vocabulary is reconciled

The console's five invented roles are replaced by RBAC's three, which is what
the gateway enforces:

| Role | Grants | In the console |
|---|---|---|
| `platform_admin` | `*:*:*` | Everything, including the tier registry |
| `specialist` | tenant, provisioning, entitlement, impersonation, audit | Everything except the registry |
| `support` | the same, read-only | Reads every tenant, changes none |

RBAC's permission catalogue gained two keys it was missing: `tenant:directory:read`,
because reading one tenant and reading every tenant are different powers, and
`registry:tier:manage`, because a specialist holding `entitlement:*:*` must
still not be able to reprice the platform. Specialist keeps "can provision, not
change pricing" without a special case anywhere.

### Cross-tenant reads have their own gate

`tenantctx.RequireAdmin` sits beside `tenantctx.Tenant`, and `ListTenants` is the
first caller. The alternative was a wildcard tenant, which is a cross-tenant read
with an explanation attached and would be indistinguishable from a bug.

Everything else needs no gate at all, and this is the part worth repeating:
`GetProfile`, `GetEntitlement` and `GetSeats` take empty request messages and
read their tenant from the header. The admin gateway addresses any tenant by
naming it in one function, `downstream`. No domain service relaxed anything.

An admin account's tenant id is the nil UUID, which `tenantctx.Tenant` refuses,
so the identity that authorises a specialist cannot itself reach a tenant's
rows. That is now covered by a test rather than left as a happy accident.

### One N+1 taken deliberately, one avoided

Merchant codes were going to be a call per row, so Auth gained
`ListMerchantCodes`: one call for a page.

Seat counts still are a call per row, because Staff has no batch read. It is
bounded to eight at a time on a two-second budget, and it degrades rather than
failing: a tenant whose count does not arrive renders its limit alone.
`seatsUsed` is nullable in the contract to say so. A batch read on Staff, or a
counter off the event stream, is the fix.

### Development is a switch, not a mix

`npm run dev:admin` runs the console on its mock, as before.
`npm run dev:admin:live` points it at a real admin gateway through a Vite proxy
and stands the mock down entirely.

All or nothing on purpose. A mock sign-in and a real data call disagree about
who is signed in, and the result is a console that looks authenticated and is
refused by everything it asks for. Same-origin through a proxy rather than a
different host, because the admin cookie is host-only.

### Three bugs that only running it could find

Everything above typechecked, built and passed 312 tests before any of these
surfaced. Each is a case where the test and the deployment disagreed about what
"working" meant.

**The console's image could never be built.** `apps/admin` was added as an npm
workspace and `package-lock.json` was never regenerated, so `npm ci` refused the
build with "Missing: @twentyfour/admin from lock file". Local builds worked
throughout, because `npm run build --workspace` reads the workspace glob and
never consults the lockfile. Nothing but `make admin-up` would have found it.

**`RequireAdmin` was unreachable.** The gRPC interceptor refuses any call whose
tenant header is nil, *before* any handler runs, so every cross-tenant RPC
answered "no tenant in request context" whichever plane asked. The gate I added
in A2 could never be consulted.

The unit test passed because it built its context with `With(...)`, which is how
a handler test reaches a handler and is not how a request arrives. The fix is
that an admin identity with no tenant is now attached rather than refused:
`Tenant()` still rejects it, so no tenant-scoped query can run, and
`RequireAdmin()` becomes the thing that decides. The replacement test drives the
interceptor with the metadata a gateway actually sends, and it immediately
caught a flaw in the fix itself: a *malformed* tenant id was being read as *no*
tenant. Absent and garbled are different answers, and only the first is allowed.

**An unfiltered directory returned nothing while counting everything.** An
absent filter arrives as a NULL array rather than an empty one, and
`cardinality(NULL)` is NULL, so `cardinality($1) = 0 OR status = ANY($1)`
evaluated to NULL and every row was filtered out. The `total` came back as 4 and
the list as empty, which is the shape of the bug: the count and the page
disagreed, and only one of them was wrong.

### Four more that only the browser could find

curl exercised every endpoint and all of it passed. Then the same flow in
Chrome failed at the first step, four times over, each for a reason a request
made by hand cannot reach.

**The sign-in page ignored the redirect it was given.** The gateway returned the
handoff correctly; the deployed `web-auth` bundle predated the change and still
did `window.location.assign(returnTo())`, so a specialist landed on the merchant
dashboard. Only `web-admin` had been rebuilt. Every frontend embeds the shared
packages, so a change to `@twentyfour/api` means rebuilding all of them.

**Nothing routed to the handoff page.** `HandoffPage` was written, typechecked
and built, and no route ever pointed at it: the edit that added the route sat
behind a `git rm` that failed, and `&&` swallowed it. Typecheck passed because
an unreferenced component is still a valid component. The page reported "the
console could not reach its gateway", which was the gate running where the
handoff should have been.

**The detail contract required fields no service can fill.** `parseDetail`
insisted on `quotas`, `revenue` and `subscription`, which the mock always
supplied and the real gateway has no source for. The page died on "quotas was
not an array". The parser now treats absent and empty as the same answer, and
`subscription` is nullable: these arrive one service at a time, and a parser
that insists on all of them keeps every screen broken until the last one ships.

**A figure the wire omits is undefined, not null.** `orders30d` was checked with
`=== null` and arrived absent, so the check passed and `.toLocaleString()` threw
on undefined. Fixed at both ends: the gateway states the absence, and
`parseSummary` normalises it, so past the boundary a screen sees a number or a
null and never a third thing.

### Verified in a browser

```
merchant@example.com  →  { session, redirect: "/" }        + tf_session
admin@example.com     →  { redirect: ".../session?code=" } + no cookie at all
                         exchange → tf_admin_session, no Domain attribute
                         replay   → 401
```

| Check | Result |
|---|---|
| Merchant cookie on the admin gateway | 401 |
| Admin cookie on the merchant gateway | 401 |
| No cookie | 401 |
| The directory, as a specialist | 4 tenants, from Tenant, Auth and Staff |
| `make admin-down` | both halves to zero, routes serve 503 |

And in Chrome, end to end: `admin@example.com` signs in at the merchant form,
lands on the console, and the directory and a tenant's record both render from
Tenant, Auth and Staff. `merchant@example.com` at the same form lands on the
dashboard. Fields nothing has filled read "not recorded" rather than blank, and
the seat quota, which is the one quota anything actually knows, draws.

---

## Decisions taken

| Question | Decision |
|---|---|
| One email on both planes | **Forbidden.** Unique on the address alone. A specialist who also runs a shop uses a second address. |
| Staff sign-in | **Password until SSO exists.** Auth decides the plane either way, so SSO lands as another credential Auth accepts and no caller changes. |
| Impersonation across planes | **Deferred.** A support token is a tenant-plane token minted by the admin gateway; it gets its own design pass. |
| Admin console origin | **Its own subdomain**, `admin.twentyfour…`, never a path under the merchant host. |

## Decisions I need from you

1. **One email cannot exist on both planes.** This is what makes "where do I go"
   answerable at all. A specialist who also runs a shop on the platform uses a
   second address. The alternative is a "which one?" step after the password,
   which is a worse form for a rarer case. **Recommend: forbid it, unique on
   email alone.**

2. **Staff sign in with a password until SSO exists.** §1 says Google Workspace.
   Nothing about the shape changes when SSO lands. **Recommend: accept, record
   as a decision.**

3. **Impersonation crosses the plane boundary on purpose.** When Support lands, a
   support token is a *tenant-plane* token minted by the admin gateway on behalf
   of a specialist. It is the one place the two planes deliberately touch, and it
   deserves its own design pass rather than being folded in here.

4. **The admin cookie is host-scoped.** Confirm you want the console on its own
   host. Everything in part one assumes it; if the console moved under
   `app.twentyfour/admin` instead, the merchant cookie namespace would cover the
   plane that can see every merchant, and the separation would be gone.
