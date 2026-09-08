#!/usr/bin/env bash
# Bring the whole system up or down: infrastructure, backend services and every
# frontend application.
#
# Each step reports as it finishes rather than at the end, because a full build
# takes minutes and silence for minutes is indistinguishable from a hang.
set -uo pipefail

NS=twentyfour
REG=localhost:5000/twentyfour
WEB=services/web
HOST=app.twentyfour.localhost
# The admin console is a different origin, deliberately: it is the plane that
# can see every merchant, so it is not inside the cookie namespace the merchant
# applications share. Probing it means probing a second host.
ADMIN_HOST=admin.twentyfour.localhost
LOG=$(mktemp -t twentyfour-system.XXXXXX)
trap 'rm -f "$LOG"' EXIT

# Every service directory that can produce an image, discovered rather than
# listed: adding a service's Containerfile is enough for system-up to include
# it. Order is alphabetical and does not matter, because every gRPC client here
# dials lazily and every service migrates its own schema on start.
BACKEND=$(for d in services/*/; do
  [ -f "$d/Containerfile" ] && basename "$d"
done | tr '\n' ' ')
FRONTEND="unavailable dashboard auth pos bookings admin"
INFRA_WORKLOADS="statefulset/postgres deployment/redis statefulset/kafka"

# Frontend and backend both have an "auth", and they are different images.
web_image() { echo "web-$1"; }

GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
TICK="${GREEN}✓${RESET}"; CROSS="${RED}✗${RESET}"

failed=0

group() { printf '\n  %s%s%s\n' "$BOLD" "$1" "$RESET"; }

# Runs a step, showing it as pending first so a long build is visibly working.
# The pending line is only drawn on a terminal: overwriting with \r into a pipe
# or a log file produces unreadable output.
step() {
  local label=$1; shift
  [ -t 1 ] && printf '    %s  %-24s %s...%s' "$DIM·$RESET" "$label" "$DIM" "$RESET"
  if "$@" >"$LOG" 2>&1; then
    [ -t 1 ] && printf '\r'
    printf '    %s  %-24s %s%s%s\n' "$TICK" "$label" "$DIM" "${NOTE:-done}" "$RESET"
    NOTE=""
    return 0
  fi
  [ -t 1 ] && printf '\r'
  printf '    %s  %-24s %sfailed%s\n' "$CROSS" "$label" "$RED" "$RESET"
  sed 's/^/        /' "$LOG" | tail -6
  failed=1
  NOTE=""
  return 1
}

note() { NOTE=$1; }

# ---------- individual actions ----------------------------------------------

# Service routing is what everything else depends on: without it no pod can
# reach Postgres, the API server or another service. Podman rewriting nftables
# during an image build has been enough to clear these rules on this machine.
#
# On single-node k3s the NAT rules live in the host network namespace, so the
# host can test a ClusterIP directly. That is far faster and far more reliable
# than scheduling a pod, which needs an image pull before it can answer.
check_clusterip() {
  local ip
  ip=$(kubectl -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}' 2>/dev/null) || return 1
  [ -n "$ip" ] || return 1
  # Any HTTP response proves routing works. 401 is the expected answer here:
  # the request reached the API server and was refused for lack of credentials.
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 "https://$ip:443/healthz" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

ensure_registry() {
  curl -sf http://localhost:5000/v2/ >/dev/null 2>&1 && return 0
  ./scripts/registry.sh
}

ensure_secrets() {
  # The DSNs and the token key are generated here rather than committed. A key
  # in git is a key in every clone, and a rotated one would break every session.
  kubectl -n $NS get secret service-dsn >/dev/null 2>&1 || \
    kubectl -n $NS create secret generic service-dsn \
      --from-literal=rbac='postgres://twentyfour:devpassword@postgres:5432/rbac?sslmode=disable' \
      --from-literal=auth='postgres://twentyfour:devpassword@postgres:5432/auth?sslmode=disable' \
      --from-literal=catalog='postgres://twentyfour:devpassword@postgres:5432/catalog?sslmode=disable' \
      --from-literal=inventory='postgres://twentyfour:devpassword@postgres:5432/inventory?sslmode=disable' \
      --from-literal=staff='postgres://twentyfour:devpassword@postgres:5432/staff?sslmode=disable' \
      --from-literal=payments='postgres://twentyfour:devpassword@postgres:5432/payments?sslmode=disable' \
      --from-literal=pos='postgres://twentyfour:devpassword@postgres:5432/pos?sslmode=disable' \
      --from-literal=tenant='postgres://twentyfour:devpassword@postgres:5432/tenant?sslmode=disable' \
      --from-literal=provisioning='postgres://twentyfour:devpassword@postgres:5432/provisioning?sslmode=disable'
  kubectl -n $NS get secret auth-token-key >/dev/null 2>&1 || \
    kubectl -n $NS create secret generic auth-token-key \
      --from-literal=key="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

build_frontend() {
  local a=$1 img
  img=$(web_image "$a")
  if [ "${REBUILD:-0}" != 1 ] && image_present "$img"; then
    return 0
  fi
  podman build -f "$WEB/apps/$a/Containerfile" -t "$REG/$img:dev" "$WEB" \
    && podman push --tls-verify=false "$REG/$img:dev"
}

# Whether the registry already holds a :dev tag for this repository. Podman
# pushes OCI manifests, so that media type has to be requested by name.
image_present() {
  curl -sf -o /dev/null \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    "http://localhost:5000/v2/twentyfour/$1/manifests/dev" 2>/dev/null
}

roll() { # roll <deployment>: restart and wait, so we know the new image is live
  kubectl -n $NS rollout restart "deployment/$1" >/dev/null \
    && kubectl -n $NS rollout status "deployment/$1" --timeout=180s
}

wait_infra() {
  for w in $INFRA_WORKLOADS; do
    kubectl -n $NS rollout status "$w" --timeout=240s || return 1
  done
}

ensure_databases() {
  kubectl -n $NS delete job ensure-databases --ignore-not-found >/dev/null 2>&1
  kubectl apply -f deploy/infra/40-databases.yaml >/dev/null
  kubectl -n $NS wait --for=condition=complete job/ensure-databases --timeout=180s
}

scale_all() { # scale_all <replicas>
  local n=$1
  for d in $(kubectl -n $NS get deploy -o name 2>/dev/null); do
    kubectl -n $NS scale "$d" --replicas="$n" >/dev/null
  done
  for s in $(kubectl -n $NS get statefulset -o name 2>/dev/null); do
    kubectl -n $NS scale "$s" --replicas="$n" >/dev/null
  done
}


# The per-service scripts are the single implementation of "build this and roll
# it out". system-up wraps them in its own progress display rather than keeping
# a second copy that can drift from what "make relay-up" does.
deploy_backend() { ./scripts/service.sh up "$1"; }

deploy_frontend() {
  local a=$1
  build_frontend "$a" || return 1
  kubectl -n $NS scale "deployment/web-$a" --replicas=1 >/dev/null || return 1
  roll "web-$a"
}

# ---------- commands ---------------------------------------------------------

cmd_up() {
  printf '\n  %sTwentyFour%s  bringing the system up\n' "$BOLD" "$RESET"
  if [ "${REBUILD:-0}" = 1 ]; then
    printf '  %sREBUILD=1: rebuilding every image from source%s\n' "$DIM" "$RESET"
  else
    printf '  %sreusing the images in the registry; REBUILD=1 to build from source%s\n' "$DIM" "$RESET"
  fi

  group "cluster"
  step toolchain    ./scripts/preflight.sh || return 1
  step networking   check_clusterip || {
    printf '\n      %sPods cannot reach ClusterIPs, so nothing can talk to Postgres.%s\n' "$DIM" "$RESET"
    printf '      %sk3s rebuilds those iptables rules on start:%s  sudo systemctl restart k3s\n\n' "$DIM" "$RESET"
    return 1
  }
  step registry     ensure_registry
  step namespace    kubectl apply -f deploy/infra/00-namespace.yaml
  step secrets      ensure_secrets

  group "data"
  step manifests    kubectl apply -f deploy/infra/
  step postgres     kubectl -n $NS rollout status statefulset/postgres --timeout=240s
  step redis        kubectl -n $NS rollout status deployment/redis --timeout=240s
  step kafka        kubectl -n $NS rollout status statefulset/kafka --timeout=240s
  step databases    ensure_databases
  step reachable    ./scripts/infra-check.sh

  group "backend"
  kubectl apply -f deploy/apps/ >"$LOG" 2>&1
  for s in $BACKEND; do step "$s" deploy_backend "$s"; done

  group "frontend"
  kubectl apply -f deploy/web/ >"$LOG" 2>&1
  for a in $FRONTEND; do step "$a" deploy_frontend "$a"; done

  # A failed build leaves the previous pod running, so "status" would report
  # the service as up while the change that was being deployed is nowhere. Say
  # so explicitly rather than letting a green status imply a green deploy.
  if [ $failed -ne 0 ]; then
    printf '\n  %sSomething did not build.%s Anything that failed above is still\n' "$RED" "$RESET"
    printf '  running its previous image, so "system-status" will show it as up.\n'
  fi

  if [ $failed -eq 0 ]; then
    printf '\n  %s%s ready%s  http://%s\n\n' "$GREEN" "✓" "$RESET" "$HOST"
  else
    printf '\n  %s%s some steps failed%s  the rest of the system is running\n\n' "$RED" "✗" "$RESET"
    return 1
  fi
}

cmd_down() {
  printf '\n  %sTwentyFour%s  taking the system down\n' "$BOLD" "$RESET"
  printf '  %sVolumes are kept. Data survives; nothing is deleted.%s\n' "$DIM" "$RESET"

  group "frontend"
  for a in $FRONTEND; do
    note "scaled to 0"
    step "$a" kubectl -n $NS scale "deployment/web-$a" --replicas=0
  done

  group "backend"
  for s in $BACKEND; do
    note "scaled to 0"
    step "$s" kubectl -n $NS scale "deployment/$s" --replicas=0
  done

  group "data"
  note "scaled to 0"; step postgres kubectl -n $NS scale statefulset/postgres --replicas=0
  note "scaled to 0"; step redis    kubectl -n $NS scale deployment/redis --replicas=0
  note "scaled to 0"; step kafka    kubectl -n $NS scale statefulset/kafka --replicas=0

  printf '\n  %s✓ down%s  bring it back with "make system-up"\n\n' "$GREEN" "$RESET"
}

cmd_status() {
  printf '\n  %sTwentyFour%s  system status\n' "$BOLD" "$RESET"

  # image_row compares the digest a pod is running against the digest the tag
  # currently points at. Tags are mutable, so the digest is the only honest
  # answer to "is this pod running the build I just made". They differ when a
  # build failed, or when an image was pushed but never rolled out, and neither
  # case is visible from replica counts.
  registry_digest() {
    # Podman pushes OCI manifests, so that media type has to be requested by
    # name; the older Docker types 404 here.
    curl -sf -o /dev/null -D - \
      -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
      "http://localhost:5000/v2/twentyfour/$1/manifests/dev" 2>/dev/null \
      | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
  }

  # The digest a pod is running against the digest the tag points at. Tags are
  # mutable, so the digest is the only honest answer to "is this the build I
  # just made". They differ when a build failed, or when an image was pushed
  # but never rolled out, and neither is visible from replica counts.
  image_state() { # image_state <registry repo> <app label>
    local repo=$1 app=$2 running want
    running=$(kubectl -n $NS get pods -l "app=$app" \
      -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' 2>/dev/null)
    want=$(registry_digest "$repo")
    if   [ -z "$want" ];    then echo " (no image)"
    elif [ -z "$running" ]; then echo ""
    elif [ "${running##*@}" = "$want" ]; then echo " (current)"
    else echo " (older than the registry)"
    fi
  }

  show() { # show <label> <kind/name> [image-repo]
    local label=$1 res=$2 repo=${3:-} want have state mark img
    want=$(kubectl -n $NS get "$res" -o jsonpath='{.spec.replicas}' 2>/dev/null)
    have=$(kubectl -n $NS get "$res" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
    [ -z "$have" ] && have=0
    if   [ -z "$want" ];        then state="not deployed"; mark="$DIM·$RESET"
    elif [ "$want" = 0 ];       then state="down";         mark="$DIM·$RESET"
    elif [ "$have" = "$want" ]; then state="up";           mark="$TICK"
    else                             state="starting";     mark="$RED!$RESET"; fi

    img=""
    [ -n "$repo" ] && img=$(image_state "$repo" "${res#*/}")
    printf '    %s  %-24s %-8s %s%s%s\n' "$mark" "$label$img" "$have/${want:-0}" "$DIM" "$state" "$RESET"
  }

  group "data"
  show postgres statefulset/postgres
  show redis    deployment/redis
  show kafka    statefulset/kafka

  group "backend"
  # Driven by the inventory rather than by what happens to be built, so a
  # service that does not exist yet shows as such instead of quietly not
  # appearing. This view lists what is running and what this build pass is
  # working towards; everything further out is one summary line, because
  # thirty-two rows is not a status display. "make api-status" prints all of it.
  while IFS=$'\t' read -r name domain phase purpose; do
    [ -n "$name" ] || continue
    case "$phase" in later|external) continue ;; esac
    if [ -f "services/$name/Containerfile" ]; then
      show "$name" "deployment/$name" "$name"
    else
      printf '    %s  %-24s %-8s %snot built yet, phase %s%s\n' \
        "$DIM·$RESET" "$name" "-" "$DIM" "$phase" "$RESET"
    fi
  done < <(grep -v '^#' deploy/inventory.tsv | grep -v '^[[:space:]]*$')

  deferred=$(awk -F'\t' '!/^#/ && ($3=="later"||$3=="external")' deploy/inventory.tsv | wc -l)
  printf '    %s  %-24s %-8s %s%s%s\n' "$DIM·$RESET" "and $deferred more" "-" \
    "$DIM" "in the architecture, not in this pass: make api-status" "$RESET"

  group "frontend"
  for a in $FRONTEND; do show "$a" "deployment/web-$a" "web-$a"; done

  group "reachable"
  # Host and path together, because the admin console answers on a different
  # origin. Probing only the merchant host would report everything healthy
  # while the console was unreachable.
  for route in "$HOST /" "$HOST /auth/" "$HOST /pos/" "$HOST /bookings/" \
               "$ADMIN_HOST /" "$ADMIN_HOST /admin/api/auth/session"; do
    host=${route% *} path=${route#* }
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 -H "Host: $host" "http://localhost$path" 2>/dev/null)
    # An API route and a bundle route fail differently, and saying so matters:
    # a frontend scaled to zero is meant to serve the unavailable page, while an
    # API answering 5xx is simply down. Only the frontends carry that middleware.
    case "$path:$code" in
      *:200)          mark="$TICK";  what="serving" ;;
      # The session endpoint answers 200 with null when nobody is signed in.
      # That is the gateway working, and it is what this probe is checking.
      /admin/api/*:5*) mark="$CROSS"; what="the admin gateway is not answering" ;;
      *:5*)           mark="$TICK";  what="down, showing the unavailable page" ;;
      *)              mark="$CROSS"; what="unexpected" ;;
    esac
    label=$path
    [ "$host" = "$ADMIN_HOST" ] && label="admin $path"
    printf '    %s  %-24s %-8s %s%s%s\n' "$mark" "$label" "$code" "$DIM" "$what" "$RESET"
  done
  echo
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: system.sh <up|down|status>"; exit 2 ;;
esac
