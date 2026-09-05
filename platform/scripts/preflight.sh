#!/usr/bin/env bash
# Verifies the local toolchain, k3s config, cluster and registry.
# Checks that a tool *runs*, not merely that the binary exists: a broken
# shared-library link makes `command -v` succeed and the tool useless.
set -uo pipefail

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

echo "Toolchain:"
need go      "go version"                    "sudo pacman -S go"
need podman  "podman version --format '{{.Client.Version}}'" \
                                             "sudo pacman -Syu   # full sync: partial upgrades break podman"
need kubectl "kubectl version --client=true" "sudo pacman -S kubectl"
need k3s     "k3s --version"                 "curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644"

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
if [ -z "${KUBECONFIG:-}" ] && [ ! -r "$HOME/.kube/config" ] && [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi
k3s_state=$(systemctl is-active k3s 2>/dev/null); : "${k3s_state:=unknown}"
if kubectl cluster-info >/dev/null 2>&1; then
  ok "cluster" "reachable: context $(kubectl config current-context 2>/dev/null)"
else
  bad "cluster" "unreachable (k3s is '$k3s_state')"
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
