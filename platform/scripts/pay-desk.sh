#!/usr/bin/env bash
# Opens a browser tab for every payment waiting on a person.
#
# The development payment provider stands in for a card terminal: a payment that
# needs something outside the software is created "pending" with an external
# action URL, and stays there until somebody approves or declines it. A real
# provider would be a terminal beeping on the counter. This is that beep.
#
# It runs on the host because nothing inside the cluster can open your browser,
# and it polls rather than holding a stream because a poll survives the pod
# restarting underneath it.
#
#   make pay-desk
#
# Leave it running in a terminal. Ctrl-C stops it. It opens each payment once.
set -uo pipefail
. "$(dirname "$0")/kubeconfig.sh"

HOST=${HOST:-app.twentyfour.localhost}
BASE=${BASE:-http://localhost}
INTERVAL=${INTERVAL:-1}

GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

open_url() {
  # Whatever this desktop uses. Printing the URL as well means the script is
  # still useful over SSH, or when no browser is installed.
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 &
  fi
}

printf '\n  %sPayment desk%s  watching for payments that need a decision\n' "$BOLD" "$RESET"
printf '  %severy card or transfer payment opens a tab; cash never does%s\n' "$DIM" "$RESET"
printf '  %sall of them are also listed at %s/pay/%s\n\n' "$DIM" "http://$HOST" "$RESET"

# Anything already waiting when the watcher starts is listed but not opened:
# a backlog of tabs from yesterday is not what anyone wants on startup.
seen=$(curl -sf -H "Host: $HOST" "$BASE/pay/pending.json" 2>/dev/null | jq -r '.[].id' | tr '\n' ' ')
[ -n "${seen// /}" ] && printf '  %salready waiting, not opened: %s%s\n\n' "$DIM" "$(echo "$seen" | wc -w)" "$RESET"

trap 'printf "\n  stopped\n\n"; exit 0' INT TERM

while true; do
  pending=$(curl -sf -H "Host: $HOST" "$BASE/pay/pending.json" 2>/dev/null) || { sleep "$INTERVAL"; continue; }

  while IFS=$'\t' read -r id minor currency method ref; do
    [ -n "$id" ] || continue
    case " $seen " in *" $id "*) continue ;; esac
    seen="$seen $id"

    url="http://$HOST/pay/$id"
    printf '  %s→%s  %s %s%s  %s%s%s\n' "$GREEN" "$RESET" "$minor" "$currency" \
      "$( [ -n "$ref" ] && echo "  for $ref" )" "$DIM" "$url" "$RESET"
    open_url "$url"
  done < <(printf '%s' "$pending" | jq -r '.[] | [.id, .minor, .currency, .method, (.referenceId // "")] | @tsv')

  sleep "$INTERVAL"
done
