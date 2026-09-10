#!/usr/bin/env bash
# Where kubectl should look, for a script run directly rather than through make.
#
# The Makefile exports KUBECONFIG for every target, so nothing under `make` ever
# needs this. Run a script by hand and there is no such export, and kubectl then
# falls back to its own default of localhost:8080 — which nothing here listens
# on. The failure is a wall of connection-refused errors naming a port this
# project never mentions, which reads as a broken cluster rather than a missing
# variable.
#
# Sourced rather than copied. It lived in two scripts and was absent from the
# other eight, so whether a command worked outside make depended on which
# command it was.
#
#   . "$(dirname "$0")/kubeconfig.sh"
#
# An explicit KUBECONFIG always wins: this only fills in a blank.
if [ -z "${KUBECONFIG:-}" ]; then
  if [ -r "${HOME:-}/.kube/config" ]; then
    export KUBECONFIG=$HOME/.kube/config
  elif [ -r /etc/rancher/k3s/k3s.yaml ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  fi
fi
