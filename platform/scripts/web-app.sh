#!/usr/bin/env bash
# Build, deploy, stop or start one frontend application.
#
# Each application is its own image and its own Deployment, so acting on one
# never touches the others. Taking one down scales it to zero rather than
# deleting it: Traefik then has no endpoint, returns 503, and the errors
# middleware serves the "temporarily unavailable" page in its place.
set -euo pipefail
. "$(dirname "$0")/kubeconfig.sh"

WEB=services/web
NS=twentyfour
REG=localhost:5000/twentyfour

usage() {
  echo "usage: web-app.sh <build|deploy|up|down|status> <$(apps | tr '\n' '|')unavailable|all>"
  exit 2
}

# Every frontend application, discovered rather than listed, with the same rule
# service.sh uses for the backends: a Containerfile is what makes something
# buildable. This was a hand-written list of five while everything around it was
# derived, which meant the sixth application would have been built by
# system-up, routed by Traefik, and invisible to `make web-status` and to every
# per-application command here.
#
# unavailable is excluded from the acting list on purpose. It is the page every
# other application falls back to when it is down, so it is not a surface
# anybody starts and stops; "all" must never scale it to zero, or a system-down
# would take away the page that explains the system is down. It is still
# addressable by name for a rebuild, and status still reports it.
apps() {
  local d n
  for d in "$WEB"/apps/*/; do
    n=$(basename "$d")
    [ "$n" = unavailable ] && continue
    [ -f "$d/Containerfile" ] && echo "$n"
  done
  return 0
}

[ $# -ge 2 ] || usage
action=$1 app=$2

expand() { [ "$app" = all ] && apps || echo "$app"; }

# Builds only when asked, or when there is nothing to reuse. Bringing an
# application back up after a "down" is the common case and needs no build:
# the image in the registry is already the one that was running.
build_one() {
  local a=$1
  if [ "${REBUILD:-0}" != 1 ] && image_present "web-$a"; then
    echo "    reusing the image already in the registry (REBUILD=1 to build)"
    return 0
  fi
  echo "==> building web-$a"
  podman build -f "$WEB/apps/$a/Containerfile" -t "$REG/web-$a:dev" "$WEB"
  podman push --tls-verify=false "$REG/web-$a:dev"
}

# Whether the registry already holds a :dev tag for this repository. Podman
# pushes OCI manifests, so that media type has to be requested by name.
image_present() {
  curl -sf -o /dev/null \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    "http://localhost:5000/v2/twentyfour/$1/manifests/dev" 2>/dev/null
}

deploy_one() {
  local a=$1
  kubectl apply -f "deploy/web/" >/dev/null
  kubectl -n $NS rollout restart "deployment/web-$a" >/dev/null
  kubectl -n $NS rollout status  "deployment/web-$a" --timeout=120s
}

case "$action" in
  build)  for a in $(expand); do build_one "$a"; done ;;
  deploy) for a in $(expand); do deploy_one "$a"; done ;;
  up)
    for a in $(expand); do
      build_one "$a"
      kubectl apply -f "deploy/web/" >/dev/null
      kubectl -n $NS scale "deployment/web-$a" --replicas=1 >/dev/null
      kubectl -n $NS rollout restart "deployment/web-$a" >/dev/null
      kubectl -n $NS rollout status  "deployment/web-$a" --timeout=120s
      echo "    web-$a is up"
    done ;;
  down)
    for a in $(expand); do
      kubectl -n $NS scale "deployment/web-$a" --replicas=0 >/dev/null
      echo "    web-$a is down; its routes now serve the unavailable page"
    done ;;
  status)
    printf '  %-12s %-10s %s\n' APP REPLICAS STATE
    for a in $(apps) unavailable; do
      want=$(kubectl -n $NS get deploy "web-$a" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo -)
      have=$(kubectl -n $NS get deploy "web-$a" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
      [ -z "$have" ] && have=0
      if   [ "$want" = "-" ]; then state="not deployed"
      elif [ "$want" = "0" ]; then state="down"
      elif [ "$have" = "$want" ]; then state="up"
      else state="starting"; fi
      printf '  %-12s %-10s %s\n' "$a" "$have/$want" "$state"
    done ;;
  *) usage ;;
esac
