#!/usr/bin/env bash
# Build, deploy, stop or start one backend service.
#
# The frontend equivalent is web-app.sh, and the two behave the same way on
# purpose: each service is its own image and its own Deployment, acting on one
# never touches the others, and "down" scales to zero rather than deleting, so
# bringing it back needs no rebuild.
#
# A service becomes manageable the moment it has a Containerfile. Nothing here
# is a hand-maintained list, so building the next service is enough to make its
# commands work.
set -euo pipefail

NS=twentyfour
REG=localhost:5000/twentyfour

usage() {
  echo "usage: service.sh <build|deploy|up|down|status|list|inventory> <name|all>"
  echo "  known: $(services | tr '\n' ' ')"
  exit 2
}

# Every directory under services/ that can produce an image. services/web holds
# the frontends, whose Containerfiles are one level deeper, and services/catalog
# is still a library with no server, so both are passed over without a list
# saying so.
#
# This is what can be acted on. It is deliberately not the same as the inventory
# below, which is everything the platform is meant to have.
services() {
  local d n
  for d in services/*/; do
    n=$(basename "$d")
    [ -f "$d/Containerfile" ] && echo "$n"
  done
  # The loop's status is the last test, which is false whenever the last
  # directory has no Containerfile. That is not a failure.
  return 0
}

INVENTORY=deploy/inventory.tsv

# Every service the architecture calls for, built or not. Status reads this
# rather than the directory listing, because "pos is not built yet" is a more
# useful answer than pos simply not appearing.
inventory() { grep -v '^#' "$INVENTORY" | grep -v '^[[:space:]]*$'; }

# Just the names, in inventory order.
inventory_names() { inventory | cut -f1; }

# The names that are meant to be running now, so a caller can tell "not written
# yet" apart from "written and down".
inventory_built() { inventory | awk -F'\t' '$3=="built"{print $1}'; }

# What state one service is in, as one word plus a mark.
state_of() {
  local s=$1 want have
  if ! buildable "$s"; then echo "planned"; return; fi
  want=$(kubectl -n $NS get deploy "$s" -o jsonpath='{.spec.replicas}' 2>/dev/null)
  have=$(kubectl -n $NS get deploy "$s" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ -z "$have" ] && have=0
  if   [ -z "$want" ];        then echo "nomanifest"
  elif [ "$want" = 0 ];       then echo "down"
  elif [ "$have" = "$want" ]; then echo "up"
  else                             echo "starting"; fi
}

[ $# -ge 1 ] || usage
action=$1 svc=${2:-all}

expand() { [ "$svc" = all ] && services || echo "$svc"; }

buildable() { [ -f "services/$1/Containerfile" ]; }
deployed()  { kubectl -n $NS get deploy "$1" >/dev/null 2>&1; }

# Whether the registry already holds a :dev tag for this repository. Podman
# pushes OCI manifests, so that media type has to be requested by name.
image_present() {
  curl -sf -o /dev/null \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    "http://localhost:5000/v2/twentyfour/$1/manifests/dev" 2>/dev/null
}

# Built from the repository root, not the service directory: every service
# imports the generated protobuf module or the shared packages, and both live
# outside its own tree.
build_one() {
  local s=$1
  if [ "${REBUILD:-0}" != 1 ] && image_present "$s"; then
    echo "    reusing the image already in the registry (REBUILD=1 to build)"
    return 0
  fi
  echo "==> building $s"
  podman build -f "services/$s/Containerfile" -t "$REG/$s:dev" .
  podman push --tls-verify=false "$REG/$s:dev"
}

up_one() {
  local s=$1
  if ! buildable "$s"; then
    echo "    $s has no server yet; nothing to bring up"
    return 0
  fi
  build_one "$s"
  kubectl apply -f deploy/apps/ >/dev/null
  if ! deployed "$s"; then
    echo "    $s has no deployment manifest yet; skipped"
    return 0
  fi
  kubectl -n $NS scale "deployment/$s" --replicas=1 >/dev/null
  kubectl -n $NS rollout restart "deployment/$s" >/dev/null
  kubectl -n $NS rollout status  "deployment/$s" --timeout=180s
  echo "    $s is up"
}

down_one() {
  local s=$1
  if ! deployed "$s"; then
    echo "    $s is not deployed; nothing to take down"
    return 0
  fi
  kubectl -n $NS scale "deployment/$s" --replicas=0 >/dev/null
  echo "    $s is down"
}

case "$action" in
  list)      services ;;
  inventory) inventory_names ;;
  build) for s in $(expand); do buildable "$s" && build_one "$s" || echo "    $s has no server yet"; done ;;
  up)    for s in $(expand); do up_one "$s"; done ;;
  down)  for s in $(expand); do down_one "$s"; done ;;
  deploy)
    kubectl apply -f deploy/apps/ >/dev/null
    for s in $(expand); do
      deployed "$s" || { echo "    $s has no deployment manifest yet"; continue; }
      kubectl -n $NS rollout restart "deployment/$s" >/dev/null
      kubectl -n $NS rollout status  "deployment/$s" --timeout=180s
    done ;;
  status)
    printf '  %-13s %-9s %-7s %-13s %s\n' SERVICE DOMAIN PHASE STATE PURPOSE
    while IFS=$'\t' read -r name domain phase purpose; do
      [ -n "$name" ] || continue
      case "$phase" in
        external) st="not ours" ;;
        *)
          case "$(state_of "$name")" in
            up)         st="up" ;;
            down)       st="down" ;;
            starting)   st="starting" ;;
            nomanifest) st="no manifest" ;;
            planned)    st="not built yet" ;;
          esac ;;
      esac
      printf '  %-13s %-9s %-7s %-13s %s\n' "$name" "$domain" "$phase" "$st" "$purpose"
    done < <(inventory)
    echo
    # One row is one deployment, so these three numbers add up and each one is
    # checkable against the list above it.
    printf '  %s built, %s still to come, %s services in all.\n' \
      "$(inventory | awk -F'\t' '$3=="built"' | wc -l)" \
      "$(inventory | awk -F'\t' '$3!="built"' | wc -l)" \
      "$(inventory | wc -l)"
    printf '  Build order and reasoning: backend-plan.md\n' 
    ;;
  *) usage ;;
esac
