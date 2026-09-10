#!/usr/bin/env bash
# Verifies the local toolchain, k3s config, cluster and registry.
# Checks that a tool *runs*, not merely that the binary exists: a broken
# shared-library link makes `command -v` succeed and the tool useless.
set -uo pipefail
. "$(dirname "$0")/kubeconfig.sh"

fail=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

ok()   { printf '  %sok%s      %-9s %s\n' "$GREEN" "$RESET" "$1" "${2:-}"; }
bad()  { printf '  %sFAIL%s    %-9s %s\n' "$RED"   "$RESET" "$1" "$2"; fail=1; }
note() { printf '  %snote%s    %-9s %s\n' "$YELLOW" "$RESET" "$1" "$2"; }
hint() { printf '            %s\n' "$1"; }

need() { # need <name> <version-cmd> <install-hint>
  local name=$1 cmd=$2 install=$3 out
  if ! command -v "$name" >/dev/null 2>&1; then
    bad "$name" "not installed"; hint "$install"; return
  fi
  if ! out=$(eval "$cmd" 2>&1); then
    bad "$name" "installed but will not run"
    hint "$(printf '%s' "$out" | head -1 | cut -c1-90)"
    return
  fi
  ok "$name" "$(printf '%s' "$out" | head -1 | cut -c1-56)"
}

# Wanted, not required: absent, it costs you one group of commands rather than
# the bring-up. Reported so the failure arrives here, with the fix beside it,
# instead of arriving later as a command that behaves strangely.
want() { # want <name> <version-cmd> <what it costs> <install-hint>
  local name=$1 cmd=$2 costs=$3 install=$4 out
  if ! command -v "$name" >/dev/null 2>&1; then
    note "$name" "not installed: $costs"; hint "$install"; return
  fi
  if ! out=$(eval "$cmd" 2>&1); then
    note "$name" "installed but will not run: $costs"
    hint "$(printf '%s' "$out" | head -1 | cut -c1-90)"
    return
  fi
  ok "$name" "$(printf '%s' "$out" | head -1 | cut -c1-56)"
}

echo "Toolchain:"
need go      "go version"                    "sudo pacman -S go"
need podman  "podman version --format '{{.Client.Version}}'" \
                                             "sudo pacman -Syu   # full sync: partial upgrades break podman"
need kubectl "kubectl version --client=true" "sudo pacman -S kubectl"
need k3s     "k3s --version"                 "curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644"
# Required, and easy to miss because nothing says so out loud. The Makefile
# reads go.work through jq to find the modules, so without it MODULES is empty
# and "make test" and "make vet" iterate over nothing, print no error, and
# succeed. A test suite that passes by not running is worse than one that fails.
need jq      "jq --version"                  "sudo pacman -S jq"

echo
echo "Also useful:"
# grpcurl is how the seed scripts talk to Auth, and its absence does not fail
# them: they wait for a gRPC answer in a loop that can never succeed, so a
# missing binary looks like a hung cluster. It installs into GOPATH/bin, which
# is the usual reason it is present but not found.
want grpcurl "grpcurl -version" \
     "make seed-account and make seed-staff will hang" \
     "go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest  (and put $(go env GOPATH 2>/dev/null || echo ~/go)/bin on PATH)"
# The deployed frontends build inside podman, so this is not needed to bring the
# system up. It is needed to run the frontend tests and to build the monitor's
# own interface.
want node    "node --version" \
     "make web-test, npm run dev:*, and make monitoring-up cannot build" \
     "sudo pacman -S nodejs npm"

echo
echo "k3s config:"
reg=/etc/rancher/k3s/registries.yaml
fixreg="sudo cp deploy/k3s/registries.yaml $reg && sudo systemctl restart k3s"
if [ ! -r "$reg" ]; then
  note "registries" "absent: k3s cannot pull from localhost:5000"; hint "$fixreg"
elif ! grep -q '^mirrors:' "$reg"; then
  bad "registries" "malformed: no top-level 'mirrors:' key"; hint "$fixreg"
else
  ok "registries" "well-formed"
fi

echo
echo "Cluster:"
k3s_state=$(systemctl is-active k3s 2>/dev/null); : "${k3s_state:=unknown}"
if kubectl cluster-info >/dev/null 2>&1; then
  ok "cluster" "reachable: context $(kubectl config current-context 2>/dev/null)"
else
  bad "cluster" "unreachable (k3s is '$k3s_state')"
  # The fix depends on which of the two this is, and they are not the same
  # problem. A stopped service wants starting; a running one that cannot be
  # reached wants reading. Printing the log hint for both sent anyone whose
  # cluster was simply not running off to read thirty lines saying so.
  case "$k3s_state" in
    inactive|failed|unknown) hint "sudo systemctl start k3s" ;;
  esac
  hint "journalctl -u k3s -n 30 --no-pager"
  [ -r /etc/rancher/k3s/k3s.yaml ] || hint "kubeconfig not written yet: k3s has not finished starting"
fi

echo
echo "Registry:"
if curl -sf http://localhost:5000/v2/ >/dev/null 2>&1; then
  ok "registry" "localhost:5000 responding"
else
  note "registry" "not running: 'make registry' will start it"
fi

echo
if [ $fail -eq 0 ]; then echo "${GREEN}Preflight passed.${RESET}"; else
  echo "${RED}Preflight failed${RESET}: resolve the above first."; exit 1; fi
