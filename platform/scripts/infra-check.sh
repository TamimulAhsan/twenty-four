#!/usr/bin/env bash
# Proves the infra actually works, not merely that pods report Running.
set -uo pipefail
NS=twentyfour
fail=0
GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
ok()  { printf '  %sok%s    %-10s %s\n' "$GREEN" "$RESET" "$1" "$2"; }
bad() { printf '  %sFAIL%s  %-10s %s\n' "$RED" "$RESET" "$1" "$2"; fail=1; }

if out=$(kubectl -n $NS exec statefulset/postgres -- \
      psql -U twentyfour -d twentyfour -tAc 'select version()' 2>&1); then
  ok postgres "$(printf '%s' "$out" | head -1 | cut -c1-46)"
else
  bad postgres "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

if out=$(kubectl -n $NS exec deployment/redis -- redis-cli PING 2>&1); then
  [ "$(printf '%s' "$out" | tr -d '\r')" = "PONG" ] \
    && ok redis "PING → PONG" || bad redis "unexpected: $out"
else
  bad redis "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

# Round-trip a real topic: create, list, delete.
if out=$(kubectl -n $NS exec statefulset/kafka -- \
      /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
      --create --if-not-exists --topic __preflight --partitions 1 --replication-factor 1 2>&1); then
  listed=$(kubectl -n $NS exec statefulset/kafka -- \
      /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null | tr -d '\r')
  if printf '%s' "$listed" | grep -qx '__preflight'; then
    ok kafka "topic create/list round-trip"
    kubectl -n $NS exec statefulset/kafka -- \
      /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
      --delete --topic __preflight >/dev/null 2>&1
  else
    bad kafka "topic created but not listed"
  fi
else
  bad kafka "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

echo
[ $fail -eq 0 ] && echo "${GREEN}Infra healthy.${RESET}" || { echo "${RED}Infra check failed.${RESET}"; exit 1; }
