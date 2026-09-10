#!/usr/bin/env bash
# Start, stop or inspect the cluster monitoring dashboard.
#
# It runs on your machine, not in the cluster, and that is deliberate. A monitor
# that is itself a pod in the thing it monitors cannot tell you why the thing is
# down, which is the moment you most want it. It reads the cluster through your
# own kubeconfig, so it needs no ServiceAccount, no RBAC and no image.
#
# It can also start, stop and rebuild a workload, by running the same scripts
# this directory already holds. That means it can reach exactly what a shell on
# this machine could reach and nothing more. MON_READ_ONLY=1 turns those off.
#
# That makes "up" and "down" mean something slightly different here than they do
# for pos or admin: a local process rather than a Deployment scaled to one. The
# help text says so rather than leaving it to be discovered.
set -euo pipefail

# Run through make this is already set; run directly it is not, and the failure
# is a wall of kubectl errors about localhost:8080 rather than "no kubeconfig".
# It matters more here than anywhere else: this process is what the monitor's
# own buttons run their scripts from, so an unresolved kubeconfig makes every
# action in the interface fail rather than one command in a terminal.
. "$(dirname "$0")/kubeconfig.sh"

DIR=services/dashboard
RUN=.run
PIDFILE=$RUN/monitoring.pid
LOG=$RUN/monitoring.log
PORT=${MON_PORT:-8090}
NAMESPACES=${MON_NAMESPACES:-twentyfour,kube-system}

usage() {
  echo "usage: monitoring.sh <up|down|status|dev>"
  exit 2
}
[ $# -ge 1 ] || usage

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

# Whether anything else already holds the port. Checked separately from our own
# pidfile, because "something is listening" and "we started it" are different
# problems with different fixes.
port_taken() {
  ss -ltn 2>/dev/null | grep -q ":$PORT "
}

build() {
  # The UI is rebuilt when asked, or when there is nothing to serve. Bringing
  # the monitor back up is the common case and needs no build.
  if [ "${REBUILD:-0}" = 1 ] || [ ! -d "$DIR/web/dist" ]; then
    echo "==> building the interface"
    (cd "$DIR/web" && npm install --silent && npm run build)
  else
    echo "    reusing the interface already built (REBUILD=1 to rebuild)"
  fi
  echo "==> building the collector"
  (cd "$DIR" && go build -o dashboard ./cmd/dashboard)
}

case "$1" in
  up)
    if running; then
      echo "    monitoring is already up on http://localhost:$PORT (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    if port_taken; then
      echo "port $PORT is already in use by something else:"
      ss -ltnp 2>/dev/null | grep ":$PORT " | sed 's/^/  /'
      echo
      echo "  stop it, or pick another port:  make monitoring-up MON_PORT=8091"
      exit 1
    fi
    build
    mkdir -p "$RUN"
    # setsid so it outlives this shell: make exits as soon as the recipe does,
    # and a process in make's own group would go with it.
    setsid "$DIR/dashboard" \
      -addr ":$PORT" -static "$DIR/web/dist" -namespaces "$NAMESPACES" \
      ${MON_READ_ONLY:+-read-only} \
      >"$LOG" 2>&1 &
    echo $! > "$PIDFILE"

    # Wait for it to answer rather than reporting success and leaving the
    # reader to find out otherwise. It shells out to kubectl on first collect,
    # so the first response is not instant.
    for _ in $(seq 1 40); do
      if curl -sf -o /dev/null "http://localhost:$PORT/api/graph"; then
        echo "    monitoring is up  →  http://localhost:$PORT"
        exit 0
      fi
      running || break
      sleep 0.25
    done
    echo "    monitoring did not come up. Last lines of $LOG:"
    tail -5 "$LOG" 2>/dev/null | sed 's/^/      /'
    # Kill it, do not just forget it. Dropping the pidfile while the process is
    # still holding the port turns one clear failure into a second, confusing
    # one: the next "up" reports the port taken by a stranger.
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    exit 1
    ;;

  down)
    if ! running; then
      echo "    monitoring is not running"
      rm -f "$PIDFILE"
      exit 0
    fi
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "    monitoring is down"
    ;;

  status)
    if running; then
      echo "    monitoring is up on http://localhost:$PORT (pid $(cat "$PIDFILE"))"
    else
      echo "    monitoring is down"
    fi
    ;;

  dev)
    # Hot reload: the collector serves the API, Vite serves the interface and
    # proxies /api to it. Foreground, because this is a thing you watch.
    (cd "$DIR" && go run ./cmd/dashboard -addr ":$PORT" -static web/dist -namespaces "$NAMESPACES") &
    trap 'kill %1 2>/dev/null || true' EXIT
    (cd "$DIR/web" && npm run dev)
    ;;

  *) usage ;;
esac
