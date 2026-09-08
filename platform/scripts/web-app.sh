#!/usr/bin/env bash
# Build, deploy, stop or start one frontend application.
#
# Each application is its own image and its own Deployment, so acting on one
# never touches the others. Taking one down scales it to zero rather than
# deleting it: Traefik then has no endpoint, returns 503, and the errors
# middleware serves the "temporarily unavailable" page in its place.
set -euo pipefail

WEB=services/web
NS=twentyfour
REG=localhost:5000/twentyfour

usage() {
  echo "usage: web-app.sh <build|deploy|up|down|status> <dashboard|pos|bookings|auth|admin|unavailable|all>"
  exit 2
}
[ $# -ge 2 ] || usage
action=$1 app=$2

apps() { echo "dashboard auth pos bookings admin"; }
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
