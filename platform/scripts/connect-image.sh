#!/usr/bin/env bash
# Build the Kafka Connect image and push it to the local registry.
#
# Not build-push.sh, because this is not a service: it is an off-the-shelf
# runtime with two plugins in it, built here only because no published image
# carries both Debezium and the ClickHouse sink.
#
# Skipped when the registry already has it, since the build downloads a release
# archive and there is no reason to do that on every "make infra". Force it with
# REBUILD=1 when the plugin versions in the Containerfile change.
set -euo pipefail

IMG=localhost:5000/twentyfour/connect:dev

if [ "${REBUILD:-0}" != "1" ] && podman image exists "$IMG"; then
  echo "    connect image already built (REBUILD=1 to rebuild)"
  exit 0
fi

echo "building ${IMG}"
podman build -t "$IMG" -f deploy/infra/connect/Containerfile deploy/infra/connect
podman push --tls-verify=false "$IMG"
echo "    pushed ${IMG}"
