#!/usr/bin/env bash
# Local image registry so podman-built images can be pulled by k3s.
set -euo pipefail
if podman container exists twentyfour-registry 2>/dev/null; then
  podman start twentyfour-registry >/dev/null
  echo "registry already present - started"
else
  podman run -d --name twentyfour-registry -p 5000:5000 \
    --restart=unless-stopped docker.io/library/registry:2 >/dev/null
  echo "registry created on localhost:5000"
fi
