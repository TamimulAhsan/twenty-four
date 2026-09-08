# TwentyFour: Platform

Implementation of the architecture in
[`../system-architecture.html`](../system-architecture.html). Read
`../CLAUDE.md` first; it carries the decisions this code has to respect, and
[`../backend-plan.md`](../backend-plan.md) for what is being built next.

## What is real

| | |
|---|---|
| **Auth** | Signup, login, sessions, PASETO tokens, lockout, password reset, merchant codes |
| **RBAC** | Roles, permissions, plane isolation, seven system roles |
| **Gateway** | Terminates `/api`, verifies tokens, checks permissions, owns the session cookie |
| **Relay** | Drains every service's outbox onto Kafka |
| **Catalog** | Items, categories, prices, tax rules |
| **Staff** | Members, roles, invitations, and the seat quota |
| **Inventory** | Stock levels, moves, reservations, low-stock thresholds |
| **Payments** | Intents, capture, refund, with a provider where a person decides |
| **POS** | Sales, tabs, refunds, voids, the day's takings, the drawer count, the floor |
| **Tenant** | Business profile, entitlement, and the registry of modules, tiers and trades |
| **Provisioning** | The saga that turns a signup into a working business, and its checklist |
| **Web** | Four frontends: dashboard, till, bookings, sign-in |
| **Core** | The Phase 0 service that proved the deployment path. Kept as a canary |

Everything else the frontend calls is still a gateway stub returning an empty
collection.

## Local setup

Local mirrors production: **k3s** (not compose, not Docker), with **podman** for
image builds only.

One-time, requires root:

```bash
# Arch does not support partial upgrades. Installing podman onto a system that is
# behind pulls in binaries your libraries cannot satisfy (libsubid.so.6 missing).
sudo pacman -Syu
sudo pacman -S --needed podman kubectl

# Note the flag: --write-kubeconfig-mode. "node" is not a flag and k3s crashloops.
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644

# Copy the file rather than pasting a heredoc: pasted heredocs lose the
# "mirrors:" key, and k3s then hangs on "cannot unmarshal ... into registries.Registry".
sudo mkdir -p /etc/rancher/k3s
sudo cp deploy/k3s/registries.yaml /etc/rancher/k3s/registries.yaml
sudo systemctl restart k3s
```

`make preflight` checks all of the above and prints the fix for whatever is wrong.

Then:

```bash
make preflight   # verify toolchain, cluster, registry
make up          # registry + infra + build + deploy + verify
```

`make help` lists everything.

## Cluster dashboard

```bash
make dashboard        # builds the UI, serves on http://localhost:8090
make dashboard-dev    # Go API on :8090 + Vite hot reload on :5173
```

Read-only. It shells out to `kubectl`, so it uses whatever kubeconfig you already
have and can never mutate the cluster.

What it shows:

- **Live topology**, laid out by longest path from the ingress, so the cascade
  reads top to bottom: `ingress → svc/core → pod/core → svc/{postgres,redis,kafka} → their pods`.
  Tier rows are labelled by what they contain, and the canvas is sized to the
  widest tier so cards never overlap.
- **Real edges, not a hand-drawn picture.** Ingress→Service comes from Ingress
  rules, Service→Pod from EndpointSlices, and Pod→Service **from the container's
  own env vars**: `POSTGRES_ADDR` and friends are parsed back into dependency
  arrows. Change what a pod depends on and the graph follows.
- Per-pod phase, ready count, restarts, image, node, pod IP, age, ports, and
  live CPU/memory from metrics-server.
- Select a node to isolate its connections; the rest dims and its edges animate.
  The panel lists what it talks to and what talks to it, each clickable.
- A **"How to read this"** legend explaining every node type, every edge type and
  how each is derived, plus what the status dots and restart badges mean.
- `show kube-system` toggles the k3s internals in and out. Off by default: the
  application view is the point.
- **Pan and zoom.** Click-and-hold anywhere to drag the canvas; scroll to zoom
  toward the cursor. Buttons for zoom in/out, `fit` (frames the whole graph) and
  `1:1`, with a live percentage. It auto-fits on load and whenever the visible
  node set changes, so toggling kube-system reframes automatically.
  Dragging never selects: a pointer that moves more than 4px is a pan, not a click.
- Updates stream over SSE every 2s; the browser reconnects on its own.

## Signing in

**One form, two destinations.** The same sign-in serves merchants and
TwentyFour specialists. Auth reads the address, finds which plane the account
belongs to, and the answer decides where the browser goes. Nobody picks a
plane, and an address exists on one plane only, which is what makes the
question answerable.

| Account | Credentials | Lands on |
|---|---|---|
| Merchant | `merchant@example.com` / `1234` | The dashboard, `app.twentyfour.localhost` |
| Specialist | `admin@example.com` / `1234` | The admin console, `admin.twentyfour.localhost` |

```bash
make seed-account    # the merchant
make seed-staff      # the specialist
```

Either takes overrides: `make seed-account EMAIL=you@example.com PASSWORD=...
NAME="Your Name" BUSINESS="Your Shop"`, and `make seed-staff EMAIL=... PASSWORD=...
NAME=... ROLE=support`. The admin roles are `platform_admin`, `specialist` and
`support`; the first is the default and the only one that may edit the tier
registry.

The two are separate origins on purpose. The merchant applications share one
host so the session cookie carries between them; the admin console is the
surface that can see every merchant, so its cookie is host-only and never
reaches that namespace.

Two development-only switches make that short password and a fully populated
dashboard possible:

- `authd -min-password=4`. The default is 12. A four-character password must
  never be accepted anywhere real.
- `gatewayd -permissive=true`. Every RBAC check passes, so the whole dashboard
  can be walked before the services behind it exist. This removes the only
  control keeping one role out of another's screens.

Both are set in `deploy/apps/`, both log a warning at startup, and both must be
off before this is exposed to anyone.

The admin gateway has no equivalent of `-permissive`, deliberately. It enforces
RBAC for real, so a specialist seeded with the `support` role genuinely cannot
write anything, and the console shows what that refusal looks like. A bypass on
the plane that can see every merchant is the one place it should not exist. Its
IP allowlist is empty in local development, which it also warns about.

Read endpoints whose services are not built yet return an empty collection
rather than 501, so the dashboard renders its own empty states instead of an
error on every card. Writes still refuse: accepting an order and discarding it
would be worse than refusing it.

## Running the system

```bash
make system-up        # everything: data tier, backend services, all frontends
make system-status    # what is up, what is down, what each route returns
make system-down      # scale everything to zero, keeping volumes and data
make system-restart    # down then up, reusing the images already built
```

By default a bring-up reuses whatever is already in the registry, which takes
under a minute. `REBUILD=1 make system-up` builds every image from source
instead, which takes several.

### One surface at a time

A command names a **product surface**, not a deployment.

| Command | Moves |
|---|---|
| `make pos-up` | The till: its frontend and the POS service behind it |
| `make bookings-up` | The booking UI and the Bookings service |
| `make auth-up` | The sign-in page and Auth |
| `make admin-up` | The admin console and the admin gateway behind it |
| `make dashboard-up` | The merchant dashboard, frontend only |
| `make catalog-up`, `make rbac-up`, `make relay-up` ... | One backend service |

The till is not a useful thing to half-start, so `pos-up` moves both halves.
So is the admin console: it answers to a gateway that exists only to serve it.
The dashboard is different: it reads from a dozen services and owns none of
them, so they keep their own commands and it moves alone.

`make admin-down` scales both halves to zero. The console's routes then serve
the unavailable page, and its gateway stops answering, which is what
`make system-status` reports separately: a frontend that is down is showing a
page, and a gateway that is down is not answering at all.

When a name means both halves, address them separately:

```bash
make pos-web-up      make pos-api-up
make pos-web-down    make pos-api-down
```

Whole tiers, and everything:

```bash
make web-up   make web-down   make web-status
make api-up   make api-down   make api-status
make system-up  make system-down  make system-status
```

`make help` prints the current lists. Nothing is hand-maintained: a service
becomes commandable the moment it has a `Containerfile`, so building the next
one is enough to give it `catalog-up`, `catalog-down` and `catalog-build`.

Until a paired surface's backend exists, its target says so and brings up the
half that does:

```
$ make bookings-up
    web-bookings is up
    bookings has no server yet; nothing to bring up
```

Taking a frontend down scales its Deployment to zero. Traefik then has no
endpoint for that route, returns 503, and the errors middleware serves the
unavailable page. Taking an API down scales it to zero too; the frontend shows
its own empty or error state. Either way the other surfaces are unaffected.

### If nothing can reach anything

`system-up` checks ClusterIP routing before it does any work. If that check
fails, no pod can reach Postgres, the API server or another service, and the fix
is:

```bash
sudo systemctl restart k3s
```

k3s rebuilds its iptables NAT rules on start. This has been needed after podman
rewrites nftables during an image build on the same host.

### After changing code

```bash
make pos-up REBUILD=1        # rebuild the till, both halves, and roll it out
make pos-web-up REBUILD=1    # only the frontend changed
make relay-up REBUILD=1      # one backend service
```

Without `REBUILD=1` a target reuses the image already in the registry, which is
what you want after a `down`. With it, about 50 seconds per image: a build, a
push, and a rolling restart. Nothing else restarts.

For a tight frontend edit loop use `npm run dev:pos` in `services/web`, which is
instant but runs against the mock gateway rather than the real services.

`make system-status` includes an `images` section comparing the digest each pod
is running against the digest the registry tag points at. They diverge when a
build failed or an image was pushed without a rollout, and neither case is
visible from replica counts alone.

## Layout

```
platform/
├── proto/          Service contracts. buf generate writes gen/
├── gen/            Generated Go: one module, imported by every service
├── packages/       Shared foundations, written once (see below)
├── deploy/
│   ├── k3s/        registries.yaml: install to /etc/rancher/k3s/
│   ├── infra/      Postgres, Redis, Kafka (dev-grade; prod differs: §17)
│   ├── apps/       Backend deployments, services, Traefik ingress
│   └── web/        Frontend deployments and the unavailable fallback
├── scripts/        preflight, registry, build-push, system, web-app, seed-account
└── services/
    ├── auth/       Identity: credentials, sessions, tokens, merchant codes
    ├── rbac/       Authorisation: roles, permissions, plane isolation
    ├── gateway/    The tenant API gateway
    ├── relay/      The outbox relay
    ├── catalog/    Pricing arithmetic and contract; no server yet
    ├── core/       Phase 0 canary
    ├── admin/      The admin API gateway
    ├── tenant/      Business profile, entitlement record and module registry
    ├── provisioning/ The 24-hour saga, whose rows are the merchant's checklist
    ├── dashboard/  The cluster monitor (a tool, not a product service)
    └── web/        The five frontend applications
```

## Shared foundations: `packages/`

Nine services repeating the same code nine times is nine chances to get tenant
scoping wrong. These are written once and imported by everything after them.

| Package | What it is |
|---|---|
| `tenantctx` | Reads the gateway's identity headers into a context and refuses a request without a tenant. The whole of the tenant boundary lives here |
| `pg` | Pool, embedded migrations, and a `Tx` helper a handler cannot leave open. Named `pg` so a file can also import `jackc/pgx` without renaming one of them |
| `outbox` | Writes an event row in the caller's transaction, and drains batches for the relay |
| `grpcx` | Server with health, reflection, panic recovery and consistent logging; client with sane keepalives |

A service that touches tenant data uses all four. Auth and RBAC predate them and
have not been retrofitted: they work, and rewriting a service that works to use
a package is churn, not progress.

## Taking a payment

Payments runs a development provider: a payment that needs something outside the
software waits for **you** to approve it, on a page that stands in for a card
terminal.

```bash
make pay-desk     # opens a browser tab for each payment needing a decision
```

Leave it running. Every card or transfer payment opens a tab showing the amount
and what it is for, with Approve and Decline. Cash never opens one, because cash
needs nothing outside the software. Everything waiting is also listed at
`http://app.twentyfour.localhost/pay/`.

That is not a shortcut. A provider that approved instantly would let callers
grow a dependence on synchronous success, and the first real card terminal would
break them. There is deliberately **no Approve RPC**: no real provider has one,
so the desk is a separate HTTP surface, exactly where a hosted payment page
sits.

To raise one by hand while POS is still deferred:

```bash
curl -H 'Host: app.twentyfour.localhost' -b cookies -H 'Content-Type: application/json' \
  -d '{"amount":{"minor":"8900","currency":"HUF"},"method":"card",
       "idempotencyKey":"try-1","referenceType":"order","referenceId":"o-1"}' \
  http://localhost/api/payments/intents
```

The response carries `externalActionUrl` when a person is needed. A till opens
it and waits; it never assumes a payment completed because the call returned.

## Signing up

Signup provisions the business. One form, and the merchant lands on a working
dashboard:

```bash
curl -H 'Host: app.twentyfour.localhost' -H 'Content-Type: application/json' \
  -d '{"email":"anna@pizzeriaroma.hu","password":"correct-horse-battery",
       "displayName":"Anna Kovacs","businessName":"Pizzeria Roma",
       "industry":"pizzeria","tier":"growth"}' \
  http://localhost/api/auth/signup
```

What that does, in order: Auth creates the account, the tenant ID and the
merchant code. Provisioning asks Tenant what that tier and trade resolve to,
plans a checklist from the answer, and runs the platform-owned steps. The
gateway signs them in.

A pizzeria on Growth ends up with twelve modules, both trade capabilities, a
seeded menu, twelve tables across two areas, and a ten-step checklist. A
bookshop on Starter gets nine modules, no capabilities, a retail catalog and no
floor plan step, because one input decides everything trade-specific.

**Payments and marketing are granted `pending`.** KYC and ad-account consent
cannot be completed unattended, so they are queued to a specialist and appear on
the checklist from the first minute rather than surprising somebody on day two.
`POST /api/onboarding/steps/payments_kyc/complete` is what a specialist does,
and it clears the pending flag.

The registry lives twice: `services/tenant/internal/registry` and
`services/web/packages/entitlement`. Its Go tests read the TypeScript and assert
they agree, so a change on one side that is not made on the other fails rather
than drifting.

## Ringing up a sale

The till is real. `make pay-desk` in one terminal, then sell something:

```bash
curl -H 'Host: app.twentyfour.localhost' -b cookies -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"lines":[{"itemId":"<id>","quantity":2}],
       "tenders":[{"method":"card","amount":{"minor":"1560","currency":"HUF"}}]}' \
  http://localhost/api/orders
```

A cash tender completes immediately. **A card tender blocks**: a tab opens, and
the request does not return until somebody approves or declines it. That is what
a card terminal feels like from the till, and it is why there is no write
timeout on the gateway's HTTP server. POS bounds the wait itself at three
minutes; past that it answers 408 saying where the payment is still waiting.

What the sale moves, in order: prices from Catalog, money through Payments,
stock through Inventory, then the order and its `order.placed` event in one
commit. If any tender fails, the ones already taken are refunded before the
error comes back, so a customer who paid half in cash and was then declined on
the card is not left having paid half.

## Watching the cluster

```bash
make monitoring-up      # → http://localhost:8090
make monitoring-down
```

A live topology of the running cluster: what is up, what it is wired to, and
what is failing. It reads pods, services, EndpointSlices and Traefik's
IngressRoutes, and draws the request path top to bottom — route, service, pod,
and then each pod's own dependencies.

Two things it derives rather than being told:

- **The routes** come from Traefik `IngressRoute` objects, which is what every
  route here is written as. Both hosts appear, and they are the two planes:
  `app.twentyfour` for the merchant applications, `admin.twentyfour` for the
  console.
- **The dependency arrows** come from the flags each container was started
  with. Every service is told where its neighbours are with
  `-auth=auth.twentyfour.svc.cluster.local:9102`, so the graph is the real
  wiring rather than a diagram of it that has to be kept in step.

Clicking a pod says **what that workload is for** — backend purposes come from
`deploy/inventory.tsv`, so there is no second list to keep in step — and offers
**stop, start, restart and rebuild**.

Those act on the *deployment*, not the pod, and the panel says so. Stopping a
pod on its own does nothing you would want: the ReplicaSet makes another one and
the button looks broken. Each action runs the script the Makefile already runs
(`service.sh`, `web-app.sh`) and streams its output, so a rebuild shows you the
same log a terminal would. One at a time, because two rebuilds of one image
racing each other is a coin toss over what the registry ends up with. A
datastore offers restart only: the image is not ours to build and the volume
outlives the pod.

**It runs on your machine, not in the cluster.** That is the point: a monitor
that is itself a pod in the thing it monitors cannot tell you why the thing is
down. It collects with `kubectl get` through your own kubeconfig, so it needs no
image, no ServiceAccount and no RBAC — and the actions can reach exactly what a
shell on this machine could reach and nothing more.

`make monitoring-dev` runs it with hot reload. `MON_PORT=8091` moves it.
`MON_READ_ONLY=1 make monitoring-up` serves the view with every action refused.

## The service inventory

`deploy/inventory.tsv` names every backend service that has, or will have, its
own pod, with its domain, its build phase and a one-line purpose. Status
displays read it, so a service that has not been written yet shows as **not
built yet** rather than quietly not appearing. During a build, what is missing
is the more useful half of the answer.

**One row is one deployment**, which is deliberately not the same list as
`system-architecture.html` §3. That section names capabilities; this names
things you can start and stop. The entitlement record and the module registry
are tables inside Tenant, and the onboarding checklist is literally the
provisioning saga's own rows: none of the three has a lifecycle of its own, so
none of them is a pod, and a row here for something that can never be brought
up would be noise in a display whose whole job is what is up and what is down.
Where each one lives is written into its host's purpose.

```
$ make api-status
  SERVICE       DOMAIN    PHASE   STATE         PURPOSE
  gateway       edge      built   up            Terminates /api, verifies tokens, ...
  admin         edge      built   up            Terminates /admin/api on its own host ...
  catalog       commerce  built   up            Items, services, prices, tax rules ...
  pos           commerce  built   up            Registering a sale: cart, tender, ...
  analytics     platform  6       not built yet Dashboard queries over ClickHouse ...
  notification  platform  later   not built yet Templates, branding, channel preference ...

  13 built, 16 still to come, 29 services in all.
  Build order and reasoning: backend-plan.md
```

The `phase` column is the honest answer to "where is POS":

| Phase | Meaning |
|---|---|
| `built` | Running now |
| `2` to `8` | The build order in `backend-plan.md`. POS is phase 5, because it composes Catalog, Inventory and Payments and cannot be written before them |
| `later` | In the architecture, not in this pass |
| `external` | Not written here. Twenty CRM is a fork with its own deployment and its own PostgreSQL |

`make system-status` shows what is running and what this pass is working
towards, then one summary line for the rest. Thirty-two rows is a catalogue, not
a status display.

Adding a service means one line here and its `Containerfile`. Nothing else is
hand-maintained.

## The event pipeline

Nothing writes to Kafka except the relay.

```
service transaction ─┬─ INSERT INTO orders
                     └─ INSERT INTO outbox      one commit, both or neither
                                  │
                            relay polls
                                  │
                                Kafka
```

That is what makes "a broker outage must never block a sale" true rather than
aspirational: with Kafka down, orders still commit and events queue in Postgres.

The relay finds its work by reading a directory of DSN files projected from the
`service-dsn` Secret, and drains the databases that have an `outbox` table. A
database without one, like Auth's, is simply passed over. Adding the tenth
service is therefore a Secret change, not a relay change.

`kubectl -n twentyfour port-forward svc/relay 9110:9110` then `curl
localhost:9110/stats` shows the backlog per source: how far behind the bus is,
and whether anything is stuck retrying.

Delivery is at-least-once. The relay can publish a batch and fail before
recording that it did. **Every consumer must be idempotent**, keyed on the
`event-id` header or on a natural key such as the order reference.

## Deployment shape

One deployment per service, and one image per service. The Phase 0 note about
collapsing several services into one binary did not survive contact with the
work: `make pos-up` without touching the dashboard is the property that makes
this repo pleasant to develop in, and that property comes from the split.

Each service follows the same pattern: its own Containerfile built from the
workspace root, its own Deployment and Service, self-migrating on start, and
gRPC health probes.

## Rules this codebase holds to

- **Transactional outbox from the first event.** No service publishes to Kafka
  directly; it writes to its outbox in the same transaction as its state change.
- **Own schema, own database.** No service reads another's tables. It calls the
  owning service or consumes its events.
- **Tenant scoping on every query**, from `tenantctx` and never from a request
  body. A tenant ID a client can set is a tenant ID a client can change.
- **No country logic anywhere.** Market variation is deployment, never code.
- **A display term is never a key.** `catalog_item`, never `room`.
- **Money is integer minor units + ISO currency code.** Never floats.
