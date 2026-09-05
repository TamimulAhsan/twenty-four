#!/usr/bin/env bash
# Creates a merchant account you can actually sign in with.
#
# Signup goes through the gateway, so this exercises the same path a real
# merchant would: Auth creates the user, then calls RBAC to bind the owner role.
set -euo pipefail

NS=twentyfour
EMAIL=${1:-admin@example.com}
PASSWORD=${2:-1234}
NAME=${3:-Admin}
BUSINESS=${4:-Osteria}

port=19102
kubectl -n $NS port-forward svc/auth $port:9102 >/dev/null 2>&1 &
pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
until grpcurl -plaintext localhost:$port list >/dev/null 2>&1; do sleep 1; done

payload=$(printf '{"email":%s,"password":%s,"display_name":%s,"business_name":%s}' \
  "$(printf '%s' "$EMAIL" | jq -R .)" \
  "$(printf '%s' "$PASSWORD" | jq -R .)" \
  "$(printf '%s' "$NAME" | jq -R .)" \
  "$(printf '%s' "$BUSINESS" | jq -R .)")

out=$(grpcurl -plaintext -d "$payload" localhost:$port twentyfour.auth.v1.AuthService/Signup 2>&1) || {
  if printf '%s' "$out" | grep -q AlreadyExists; then
    echo "  $EMAIL already exists; leaving it as it is"
    exit 0
  fi
  printf '  signup failed:\n%s\n' "$out" | sed 's/^/    /'
  exit 1
}

user=$(printf '%s' "$out" | jq -r .user.id)
tenant=$(printf '%s' "$out" | jq -r .tenantId)
echo "  created $EMAIL"
echo "    user   $user"
echo "    tenant $tenant"
