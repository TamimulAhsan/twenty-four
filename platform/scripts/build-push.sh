#!/usr/bin/env bash
# Build one service with podman and push it to the local registry.
set -euo pipefail
svc="${1:?usage: build-push.sh <service>}"
tag="${2:-dev}"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
img="localhost:5000/twentyfour/${svc}:${tag}"

echo "building ${img} (commit ${commit})"
podman build --build-arg "GIT_COMMIT=${commit}" -t "${img}" "services/${svc}"
podman push --tls-verify=false "${img}"
echo "pushed ${img}"
