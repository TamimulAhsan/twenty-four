SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
NS := twentyfour

# k3s puts its kubeconfig here; use it unless the caller set one.
export KUBECONFIG ?= $(shell [ -r $$HOME/.kube/config ] && echo $$HOME/.kube/config || echo /etc/rancher/k3s/k3s.yaml)

# Modules come from go.work, so adding a service needs no Makefile change.
MODULES := $(shell go work edit -json | jq -r '.Use[].DiskPath')

# Sections come from "##@" markers and descriptions from "##" on the target, so
# the help is generated rather than maintained: a target without a description
# is simply absent, which is a visible enough failure to notice. Order is the
# order they appear in this file.
help: ## Show this help
	@printf '\n  \033[1mTwentyFour\033[0m — one market per deployment. Everything runs in k3s.\n'
	@awk 'BEGIN {FS = ":.*?## "} \
	  /^##@/ { printf "\n  \033[1m%s\033[0m\n", substr($$0, 5); next } \
	  /^help:/ { next } \
	  /^[a-zA-Z0-9_-]+:.*?## / { printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2 }' \
	  $(MAKEFILE_LIST)
	@printf '\n  \033[1mOne surface at a time\033[0m\n'
	@printf '    A target names a product surface, not a deployment. Every name below\n'
	@printf '    also takes \033[36m-down\033[0m and \033[36m-build\033[0m.\n'
	@printf '\n    \033[1mFrontend and its API, moved together\033[0m\n'
	@for s in $(SURFACES); do \
	  printf '      \033[36m%-18s\033[0m moves %s\n' "$$s-up" "web-$$s and $$s"; done
	@printf '      to move one half on its own: \033[36m%s-web-up\033[0m, \033[36m%s-api-down\033[0m\n' \
	  "$(firstword $(SURFACES))" "$(firstword $(SURFACES))"
	@printf '\n    \033[1mFrontend only\033[0m\n'
	@for s in $(WEB_ONLY); do \
	  printf '      \033[36m%-18s\033[0m moves %s\n' "$$s-up" "web-$$s"; done
	@printf '\n    \033[1mBackend only\033[0m  (\033[36mmake api-status\033[0m says what each one is for)\n'
	@printf '%s\n' $(API_ONLY) | awk '{ if (NR % 3 == 1) printf "      "; \
	  printf "\033[36m%-19s\033[0m", $$1"-up"; \
	  if (NR % 3 == 0) printf "\n" } END { if (NR % 3) printf "\n" }'
	@printf '\n  \033[1mVariables\033[0m\n'
	@printf '    REBUILD=1        build images from source first; without it a target\n'
	@printf '                     reuses whatever is already in the registry\n'
	@printf '    SERVICE=pos      which service \033[36mmake logs\033[0m follows\n'
	@printf '    MON_PORT=8091    where the cluster monitor listens\n'
	@printf '    MON_READ_ONLY=1  serve the monitor with every action refused\n'
	@printf '    EMAIL= PASSWORD= NAME= BUSINESS=   passed to \033[36mseed-account\033[0m\n'
	@printf '    EMAIL= PASSWORD= NAME= ROLE=       passed to \033[36mseed-staff\033[0m\n'
	@printf '\n  Reading order: platform/README.md, then backend-plan.md.\n\n'

##@ Setting up a machine

preflight: ## Check toolchain, cluster and registry
	@./scripts/preflight.sh

registry: ## Start the local image registry (podman)
	@./scripts/registry.sh

infra: ## Deploy the data tier: Postgres, Redis, Kafka, ClickHouse, MinIO, CDC
	@./scripts/connect-image.sh
	@kubectl apply -f deploy/infra/00-namespace.yaml >/dev/null
	@./scripts/system.sh secrets
# A Job's spec is immutable, and this one has to run again whenever a service is
# added: the databases it creates are read from the secret written above.
	@kubectl -n $(NS) delete job ensure-databases --ignore-not-found >/dev/null
	@kubectl apply -f deploy/infra/
	@echo "waiting for infra to become ready..."
# Waited for by the same code system-up uses, rather than by a list here. The
# list here was five rollouts and the data tier is six workloads: MinIO was
# applied on the line above and never waited for, so this target could report
# the infrastructure ready while object storage was still starting.
	@./scripts/system.sh wait-infra

infra-check: ## Prove every data-tier component actually works, not just runs
	@./scripts/infra-check.sh


# ---- the cluster monitor ----------------------------------------------------
#
# Runs on your machine rather than in the cluster, so it can still answer when
# the cluster cannot. It collects read-only, through your own kubeconfig, and it
# can also start, stop, restart and rebuild a workload by running the very
# scripts below — so it reaches exactly what a shell here could reach and
# nothing more. MON_READ_ONLY=1 serves the view with every action refused;
# MON_PORT and MON_NAMESPACES override the rest.

##@ The whole system

system-up: ## Bring the entire system up (REBUILD=1 to build images from source)
	@./scripts/system.sh up

system-down: ## Scale the entire system to zero (volumes and data are kept)
	@./scripts/system.sh down

system-status: ## Show what is up, what is down, and what each route returns
	@./scripts/system.sh status

system-restart: ## Take everything down and bring it back without rebuilding
	@./scripts/system.sh down
	@./scripts/system.sh up

.PHONY: system-up system-down system-status system-restart

##@ The cluster monitor

monitoring-up: ## Start the cluster monitor on http://localhost:8090 (MON_PORT=, REBUILD=1)
	@./scripts/monitoring.sh up

monitoring-down: ## Stop the cluster monitor
	@./scripts/monitoring.sh down

monitoring-status: ## Say whether the cluster monitor is running
	@./scripts/monitoring.sh status

monitoring-dev: ## Run the cluster monitor with hot reload (Go :8090 + Vite :5173)
	@./scripts/monitoring.sh dev

##@ Development

logs: ## Tail a service's logs (SERVICE=pos; defaults to the canary)
# Defaulted rather than required, because this target predates there being more
# than one service to tail. There are twenty-three now, and "make logs" quietly
# showing the phase-0 canary's is a worse answer than asking which one.
	@kubectl -n $(NS) logs -f deployment/$(or $(SERVICE),core)

test: ## Run Go tests across all modules
	@for m in $(MODULES); do echo "-- $$m"; (cd $$m && go test ./...); done

vet: ## Vet, build and format-check all modules
	@for m in $(MODULES); do \
	  echo "-- $$m"; \
	  (cd $$m && go build ./... && go vet ./...) || exit 1; \
	done
	@test -z "$$(gofmt -l services/ packages/)" || { echo "unformatted:"; gofmt -l services/ packages/; exit 1; }
	@echo "vet clean"

tidy: ## go mod tidy across all modules
	@for m in $(MODULES); do (cd $$m && go mod tidy); done

##@ Teardown

down: ## Remove application workloads (keeps infra and data)
	@kubectl delete -f deploy/apps/ --ignore-not-found

nuke: ## Remove everything including volumes
	@kubectl delete namespace $(NS) --ignore-not-found
	@podman rm -f twentyfour-registry 2>/dev/null || true

.PHONY: help preflight registry infra infra-check build deploy up verify logs test vet tidy down nuke \
        monitoring-up monitoring-down monitoring-status monitoring-dev

# REBUILD=1 builds images from source; without it a target reuses whatever is
# already in the registry. Variables are easy to misspell and make ignores an
# unknown one silently, so catch the near misses rather than quietly doing the
# opposite of what was asked.
ifneq ($(filter-out 0 1,$(REBUILD)),)
  $(error REBUILD must be 0 or 1, got "$(REBUILD)")
endif
$(foreach v,REBILD REBUILT REUBILD REBUILD_ NO_REBUILD SKIP_BUILD,\
  $(if $($v),$(error $v is not a variable here. Did you mean REBUILD=1?)))
export REBUILD

# ---- product surfaces ------------------------------------------------------
#
# A target names a surface, not a deployment.
#
#   pos, bookings, auth   A frontend and the one backend service that exists
#                         only to serve it. The target moves both: "the till"
#                         is not a useful thing to half-start, and forgetting
#                         the other half is the obvious way to lose an hour.
#   dashboard             The frontend alone. It reads from a dozen services
#                         and owns none of them, so they keep their own
#                         commands.
#   admin                 The console and the admin gateway behind it, on their
#                         own host. Half a console is not useful either.
#   everything else       One backend service.
#
# Where a name means both halves, "-web" and "-api" address them separately.
# Taking a frontend down scales it to zero, so Traefik serves the unavailable
# page; taking an API down scales it to zero, and the frontend shows its own
# empty or error state.

# Every directory that can produce an image, backend and frontend. No
# hand-maintained list: building the next one is enough to make its commands
# work, and a name that has both halves becomes a paired surface by itself.
#
# unavailable is left out of WEB_ONLY on purpose. It is the fallback page every
# other application points at when it is down, so it is not a surface anybody
# starts and stops; web-app.sh still takes it by name if it needs rebuilding.
BACKEND  := $(notdir $(patsubst %/Containerfile,%,$(wildcard services/*/Containerfile)))
WEB_APPS := $(notdir $(patsubst %/Containerfile,%,$(wildcard services/web/apps/*/Containerfile)))
SURFACES := $(filter $(BACKEND),$(WEB_APPS))
WEB_ONLY := $(filter-out $(SURFACES) unavailable,$(WEB_APPS))
API_ONLY := $(filter-out $(SURFACES),$(BACKEND))

# -- both halves at once ------------------------------------------------------

$(addsuffix -up,$(SURFACES)): %-up:
	@./scripts/web-app.sh up $*
	@./scripts/service.sh up $*

$(addsuffix -down,$(SURFACES)): %-down:
	@./scripts/web-app.sh down $*
	@./scripts/service.sh down $*

$(addsuffix -build,$(SURFACES)): %-build:
	@./scripts/web-app.sh build $*
	@./scripts/service.sh build $*

# -- one half of a surface ----------------------------------------------------

$(addsuffix -web-up,$(SURFACES)): %-web-up:
	@./scripts/web-app.sh up $*

$(addsuffix -web-down,$(SURFACES)): %-web-down:
	@./scripts/web-app.sh down $*

$(addsuffix -api-up,$(SURFACES)): %-api-up:
	@./scripts/service.sh up $*

$(addsuffix -api-down,$(SURFACES)): %-api-down:
	@./scripts/service.sh down $*

# -- frontend only ------------------------------------------------------------

$(addsuffix -up,$(WEB_ONLY)): %-up:
	@./scripts/web-app.sh up $*

$(addsuffix -down,$(WEB_ONLY)): %-down:
	@./scripts/web-app.sh down $*

$(addsuffix -build,$(WEB_ONLY)): %-build:
	@./scripts/web-app.sh build $*

# -- backend only -------------------------------------------------------------

$(addsuffix -up,$(API_ONLY)): %-up:
	@./scripts/service.sh up $*

$(addsuffix -down,$(API_ONLY)): %-down:
	@./scripts/service.sh down $*

$(addsuffix -build,$(API_ONLY)): %-build:
	@./scripts/service.sh build $*

# -- whole tiers --------------------------------------------------------------

##@ Whole tiers

web-status: ## Show which frontend applications are up
	@./scripts/web-app.sh status all

api-status: ## Show which backend services are up
	@./scripts/service.sh status all

web-up: ## Start every frontend, including the fallback page (REBUILD=1 to build)
	@./scripts/web-app.sh build unavailable
	@kubectl apply -f deploy/web/ >/dev/null
	@kubectl -n $(NS) rollout status deployment/web-unavailable --timeout=120s
	@./scripts/web-app.sh up all

web-down: ## Stop every frontend (the fallback page stays up)
	@./scripts/web-app.sh down all

api-up: ## Start every backend service (REBUILD=1 to build)
	@./scripts/service.sh up all

api-down: ## Stop every backend service
	@./scripts/service.sh down all

web-test: ## Typecheck and test the frontend workspace
	@cd services/web && npm run typecheck && npm test

.PHONY: web-status api-status web-up web-down api-up api-down web-test \
        $(addsuffix -up,$(SURFACES))       $(addsuffix -down,$(SURFACES)) \
        $(addsuffix -build,$(SURFACES)) \
        $(addsuffix -web-up,$(SURFACES))   $(addsuffix -web-down,$(SURFACES)) \
        $(addsuffix -api-up,$(SURFACES))   $(addsuffix -api-down,$(SURFACES)) \
        $(addsuffix -up,$(WEB_ONLY))       $(addsuffix -down,$(WEB_ONLY)) \
        $(addsuffix -build,$(WEB_ONLY)) \
        $(addsuffix -up,$(API_ONLY))       $(addsuffix -down,$(API_ONLY)) \
        $(addsuffix -build,$(API_ONLY))

# ---- whole system ----------------------------------------------------------
# Everything: data tier, backend services, every frontend. Each step reports as
# it completes, because a full build takes minutes.


##@ Accounts and fixtures

pay-desk: ## Watch for payments needing a decision and open each in a browser tab
	@./scripts/pay-desk.sh

seed-account: ## Create a merchant account you can sign in with
	@./scripts/seed-account.sh $(EMAIL) $(PASSWORD) $(NAME) $(BUSINESS)

seed-staff: ## Create a TwentyFour specialist, for the admin console
	@./scripts/seed-staff.sh $(EMAIL) $(PASSWORD) $(NAME) $(ROLE)

.PHONY: seed-account seed-staff pay-desk

##@ The phase-0 canary
#
# The original bring-up, which proves ingress, the registry and rollout still
# work using one trivial service. "make system-up" is the real one now.

build: ## Build and push the core image
	@./scripts/build-push.sh core

deploy: ## Apply application manifests
	@kubectl apply -f deploy/apps/
	@kubectl -n $(NS) rollout restart deployment/core
	@kubectl -n $(NS) rollout status  deployment/core --timeout=120s

up: preflight registry infra infra-check build deploy verify ## Full local bring-up

verify: ## Prove the deployment path end to end
	@echo "--- pods ---"; kubectl -n $(NS) get pods
	@echo "--- core via Traefik ---"
	@curl -sf -H 'Host: api.twentyfour.localhost' http://localhost/ | jq . \
	  || echo "FAILED: check: kubectl -n $(NS) logs deploy/core"
	@echo "--- readiness ---"
	@curl -s -H 'Host: api.twentyfour.localhost' http://localhost/readyz | jq .
