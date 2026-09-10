#!/usr/bin/env bash
# Proves the infra actually works, not merely that pods report Running.
set -uo pipefail
. "$(dirname "$0")/kubeconfig.sh"
NS=twentyfour
fail=0
MINIO_USER=$(kubectl -n $NS get secret minio -o jsonpath='{.data.MINIO_ROOT_USER}' 2>/dev/null | base64 -d)
MINIO_PASS=$(kubectl -n $NS get secret minio -o jsonpath='{.data.MINIO_ROOT_PASSWORD}' 2>/dev/null | base64 -d)
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

if out=$(kubectl -n $NS exec statefulset/clickhouse -- \
      clickhouse-client --user twentyfour --password devpassword \
      --database analytics -q 'SELECT count() FROM system.tables WHERE database = current_database()' 2>&1); then
  ok clickhouse "$(printf '%s' "$out" | tr -d '\r') projection tables"
else
  bad clickhouse "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

# A connector that is merely registered is not a connector that is running, and
# a Connect worker reports the two separately: a task can be FAILED under a
# connector that says RUNNING, which is how a pipeline stops moving without
# anything looking wrong.
if out=$(kubectl -n $NS exec deployment/connect -- \
      curl -sf http://localhost:8083/connectors?expand=status 2>&1); then
  states=$(printf '%s' "$out" | tr ',' '\n' | grep -o '"state":"[A-Z]*"' | cut -d'"' -f4 | sort -u | tr '\n' ' ')
  registered=$(printf '%s' "$out" | grep -o '"name":"[^"]*"' | wc -l)
  case "$states" in
    "RUNNING ") ok connect "$registered connectors and tasks, all running" ;;
    "")         bad connect "no connectors registered" ;;
    *)          bad connect "states: $states" ;;
  esac
else
  bad connect "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

# A bucket that exists is the only thing worth checking here: Media creates it
# on start, so its absence means Media never came up or never had credentials,
# and both of those are invisible until somebody tries to upload a photograph.
if out=$(kubectl -n $NS exec statefulset/minio -- \
      mc --config-dir /tmp/mc alias set local http://localhost:9000 \
      "$MINIO_USER" "$MINIO_PASS" 2>&1 >/dev/null &&
      kubectl -n $NS exec statefulset/minio -- \
      mc --config-dir /tmp/mc ls local 2>&1); then
  buckets=$(printf '%s' "$out" | grep -c . || true)
  [ "$buckets" -gt 0 ] \
    && ok minio "$buckets bucket(s)" \
    || bad minio "no buckets: Media has not started or cannot authenticate"
else
  bad minio "$(printf '%s' "$out" | tail -1 | cut -c1-70)"
fi

echo
[ $fail -eq 0 ] && echo "${GREEN}Infra healthy.${RESET}" || { echo "${RED}Infra check failed.${RESET}"; exit 1; }
