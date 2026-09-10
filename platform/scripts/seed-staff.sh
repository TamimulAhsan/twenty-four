#!/usr/bin/env bash
# Creates a TwentyFour specialist: an account on the admin plane.
#
# There is no self-serve route to one and there should not be. A specialist can
# see every merchant in the environment, so the account is made deliberately by
# somebody who already has access to the cluster, which is what this script is.
#
# Not seed-account.sh with a flag: that one creates a business, a tenant and a
# merchant code, and a specialist has none of those.
set -euo pipefail
. "$(dirname "$0")/kubeconfig.sh"

NS=twentyfour
EMAIL=${1:-admin@example.com}
PASSWORD=${2:-1234}
NAME=${3:-Specialist}
# platform_admin, specialist or support. These are RBAC's admin-plane system
# roles; a merchant role key here would simply not resolve.
ROLE=${4:-platform_admin}

port=19102
kubectl -n $NS port-forward svc/auth $port:9102 >/dev/null 2>&1 &
pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
until grpcurl -plaintext localhost:$port list >/dev/null 2>&1; do sleep 1; done

payload=$(printf '{"email":%s,"password":%s,"display_name":%s,"role_key":%s}' \
  "$(printf '%s' "$EMAIL" | jq -R .)" \
  "$(printf '%s' "$PASSWORD" | jq -R .)" \
  "$(printf '%s' "$NAME" | jq -R .)" \
  "$(printf '%s' "$ROLE" | jq -R .)")

out=$(grpcurl -plaintext -d "$payload" localhost:$port twentyfour.auth.v1.AuthService/CreateStaff 2>&1) || {
  if printf '%s' "$out" | grep -q AlreadyExists; then
    # One address, one account, across both planes. If this address is already a
    # merchant, it cannot also be a specialist, and that is the intended answer
    # rather than a collision to work around.
    echo "  $EMAIL already has an account; leaving it as it is"
    exit 0
  fi
  printf '  could not create the specialist:\n%s\n' "$out" | sed 's/^/    /'
  exit 1
}

echo "  created $EMAIL as $ROLE"
echo "    user  $(printf '%s' "$out" | jq -r .user.id)"
echo "    plane $(printf '%s' "$out" | jq -r .user.plane)"
echo
echo "  Sign in at the same form every merchant uses. Auth reads the address,"
echo "  finds a staff account, and sends the browser to the admin console."
