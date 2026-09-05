SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
NS := twentyfour

# k3s puts its kubeconfig here; use it unless the caller set one.
export KUBECONFIG ?= $(shell [ -r $$HOME/.kube/config ] && echo $$HOME/.kube/config || echo /etc/rancher/k3s/k3s.yaml)

# Modules come from go.work, so adding a service needs no Makefile change.
MODULES := $(shell go work edit -json | jq -r '.Use[].DiskPath')

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

preflight: ## Check toolchain, cluster and registry
	@./scripts/preflight.sh

registry: ## Start the local image registry (podman)
	@./scripts/registry.sh

infra: ## Deploy Postgres, Redis and Kafka into the cluster
	@kubectl apply -f deploy/infra/
	@echo "waiting for infra to become ready..."
	@kubectl -n $(NS) rollout status statefulset/postgres --timeout=180s
	@kubectl -n $(NS) rollout status deployment/redis    --timeout=180s
	@kubectl -n $(NS) rollout status statefulset/kafka   --timeout=240s

infra-check: ## Prove Postgres, Redis and Kafka actually work
	@./scripts/infra-check.sh

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

DASH_PORT ?= 8090

clusterview: ## Serve the cluster topology view (DASH_PORT=8090)
	@if ss -ltn 2>/dev/null | grep -q ':$(DASH_PORT) '; then \
	  echo "port $(DASH_PORT) is already in use:"; \
	  ss -ltnp 2>/dev/null | grep ':$(DASH_PORT) ' | sed 's/^/  /'; \
	  echo; \
	  echo "  stop it, or pick another port:  make dashboard DASH_PORT=8091"; \
	  exit 1; \
	fi
	@cd services/dashboard/web && npm install --silent && npm run build
	@echo "dashboard → http://localhost:$(DASH_PORT)"
	@cd services/dashboard && go run ./cmd/dashboard \
	  -addr :$(DASH_PORT) -static web/dist -namespaces twentyfour,kube-system

clusterview-dev: ## Cluster topology view with hot reload (Go :8090 + Vite :5173)
	@cd services/dashboard && go run ./cmd/dashboard -addr :8090 -static web/dist & \
	 cd services/dashboard/web && npm run dev

logs: ## Tail core logs
	@kubectl -n $(NS) logs -f deployment/core

test: ## Run Go tests across all modules
	@for m in $(MODULES); do echo "-- $$m"; (cd $$m && go test ./...); done

vet: ## Vet, build and format-check all modules
	@for m in $(MODULES); do \
	  echo "-- $$m"; \
	  (cd $$m && go build ./... && go vet ./...) || exit 1; \
	done
	@test -z "$$(gofmt -l services/)" || { echo "unformatted:"; gofmt -l services/; exit 1; }
	@echo "vet clean"

tidy: ## go mod tidy across all modules
	@for m in $(MODULES); do (cd $$m && go mod tidy); done

down: ## Remove application workloads (keeps infra and data)
	@kubectl delete -f deploy/apps/ --ignore-not-found

nuke: ## Remove everything including volumes
	@kubectl delete namespace $(NS) --ignore-not-found
	@podman rm -f twentyfour-registry 2>/dev/null || true

.PHONY: help preflight registry infra infra-check build deploy up verify clusterview clusterview-dev logs test vet tidy down nuke

# ---- frontend applications -------------------------------------------------
# Each is its own image and Deployment. Acting on one never touches the others.
# Taking one down scales it to zero, so Traefik serves the unavailable page.

WEB_APPS := dashboard pos bookings auth

web-status: ## Show which frontend applications are up
	@./scripts/web-app.sh status all

web-up: ## Build and start every frontend, including the fallback page
	@./scripts/web-app.sh build unavailable
	@kubectl apply -f deploy/web/ >/dev/null
	@kubectl -n $(NS) rollout status deployment/web-unavailable --timeout=120s
	@./scripts/web-app.sh up all

web-down: ## Stop every frontend (the fallback page stays up)
	@./scripts/web-app.sh down all

$(addsuffix -up,$(WEB_APPS)): %-up: ## Build and start one frontend
	@./scripts/web-app.sh up $*

$(addsuffix -down,$(WEB_APPS)): %-down: ## Stop one frontend
	@./scripts/web-app.sh down $*

$(addsuffix -build,$(WEB_APPS)): %-build: ## Build and push one frontend image
	@./scripts/web-app.sh build $*

web-test: ## Typecheck and test the frontend workspace
	@cd services/web && npm run typecheck && npm test

.PHONY: web-status web-up web-down web-test \
        $(addsuffix -up,$(WEB_APPS)) $(addsuffix -down,$(WEB_APPS)) $(addsuffix -build,$(WEB_APPS))

# ---- whole system ----------------------------------------------------------
# Everything: data tier, backend services, every frontend. Each step reports as
# it completes, because a full build takes minutes.

system-up: ## Bring the entire system up (SKIP_BUILD=1 to reuse existing images)
	@./scripts/system.sh up

system-down: ## Scale the entire system to zero (volumes and data are kept)
	@./scripts/system.sh down

system-status: ## Show what is up, what is down, and what each route returns
	@./scripts/system.sh status

system-restart: ## Take everything down and bring it back without rebuilding
	@./scripts/system.sh down
	@SKIP_BUILD=1 ./scripts/system.sh up

.PHONY: system-up system-down system-status system-restart

seed-account: ## Create a merchant account you can sign in with
	@./scripts/seed-account.sh $(EMAIL) $(PASSWORD) $(NAME) $(BUSINESS)

.PHONY: seed-account
