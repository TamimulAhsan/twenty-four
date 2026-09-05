# TwentyFour: Platform

Implementation of the architecture in [`../graph.html`](../graph.html).
Read `../CLAUDE.md` first; it carries the decisions this code has to respect.

## Phase 0: prove the deployment path

The only thing here right now is a trivial `core` service. That is deliberate: the
job of Phase 0 is to make `git push → build → registry → k3s → Traefik → response`
work while the thing being deployed is disposable.

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

```
admin@example.com
1234
```

`make seed-account` creates it, or `make seed-account EMAIL=you@example.com
PASSWORD=... NAME="Your Name"` for another.

Two development-only switches make that short password and a fully populated
dashboard possible:

- `authd -min-password=4`. The default is 12. A four-character password must
  never be accepted anywhere real.
- `gatewayd -permissive=true`. Every RBAC check passes, so the whole dashboard
  can be walked before the services behind it exist. This removes the only
  control keeping one role out of another's screens.

Both are set in `deploy/apps/`, both log a warning at startup, and both must be
off before this is exposed to anyone.

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

`SKIP_BUILD=1 make system-up` skips the image builds and deploys what is already
in the registry. A full build is several minutes; a skip-build bring-up is under
one.

Individual applications keep their own controls, so one can be cycled without
touching the others:

```bash
make pos-up      make pos-down
make bookings-up make bookings-down
make dashboard-up  make auth-up
make web-status
```

Taking one down scales its Deployment to zero. Traefik then has no endpoint for
that route, returns 503, and the errors middleware serves the unavailable page
in its place. The other applications are unaffected.

### If nothing can reach anything

`system-up` checks ClusterIP routing before it does any work. If that check
fails, no pod can reach Postgres, the API server or another service, and the fix
is:

```bash
sudo systemctl restart k3s
```

k3s rebuilds its iptables NAT rules on start. This has been needed after podman
rewrites nftables during an image build on the same host.

### After changing frontend code

```bash
make pos-up          # rebuilds only the till and rolls it out
make dashboard-up    # and so on
```

About 50 seconds: an image build, a push, and a rolling restart. Nothing else
restarts. For a tight edit loop use `npm run dev:pos` in `services/web`
instead, which is instant but runs against the mock gateway rather than the
real services.

`make system-status` includes an `images` section comparing the digest each pod
is running against the digest the registry tag points at. They diverge when a
build failed or an image was pushed without a rollout, and neither case is
visible from replica counts alone.

## Layout

```
platform/
├── deploy/
│   ├── k3s/        registries.yaml: install to /etc/rancher/k3s/
│   ├── infra/      Postgres, Redis, Kafka (dev-grade; prod differs: graph.html §17)
│   └── apps/       Service deployments, services, Traefik ingress
├── scripts/        preflight, registry, build-push
└── services/
    └── core/       Phase 0 service: health, readiness, graceful shutdown
```

## Deployment shape

Six binaries, not twenty-nine. The architecture defines **boundaries**; the
deployment split comes later, when a service earns it by needing separate scaling
or release cadence.

| Binary | Will contain |
|---|---|
| `gateway`  | Tenant gateway + BFFs |
| `core`     | Auth, RBAC, Tenant, Entitlement |
| `commerce` | POS, Catalog, Inventory, Bookings, Staff |
| `finance`  | Payments, Invoicing, Ledger |
| `platform` | Notification, Files, Audit |
| `web`      | React SPAs behind NGINX |

Boundaries stay strict **in code**: separate packages, no cross-schema table
access, services talk via calls or events even inside one process. Splitting one
out later is then mechanical.

## Rules this codebase holds to

- **Transactional outbox from the first event.** No service publishes to Kafka
  directly; it writes to its outbox in the same transaction as its state change.
- **No country logic anywhere.** Market variation is deployment, never code.
- **A display term is never a key.** `catalog_item`, never `room`.
- **Money is integer minor units + ISO currency code.** Never floats.
