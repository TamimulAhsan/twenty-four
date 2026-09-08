package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	pospb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/provisioning/internal/store"
	"github.com/twentyfour/platform/services/provisioning/internal/templates"
)

// Running the saga.
//
// Each step is claimed, run, and recorded, one at a time and in order. Claiming
// is what makes it safe to run twice: the status check is in the WHERE clause,
// so a retried signup and a scheduled sweep cannot both execute the same step.
//
// A step that fails does not abort the run. The later steps still run, the
// failed one is left visible with its reason, and RetryStep exists so it can be
// tried again once whatever was broken is fixed. Aborting would leave a
// merchant with an account and nothing else, which is worse than a merchant
// with a working till and a red line on their checklist.

// runner is the per-tenant context a step executes in. The identity is
// synthesised rather than forwarded, because provisioning happens before the
// merchant has a session: they are signing up right now.
type runner struct {
	*server
	tenantID uuid.UUID
	ctx      context.Context
}

func (s *server) newRunner(ctx context.Context, tenantID uuid.UUID) *runner {
	return &runner{
		server:   s,
		tenantID: tenantID,
		// Acting for the tenant, with nobody behind it. Every service
		// downstream scopes by this exactly as it would for a real request.
		ctx: tenantctx.Outbound(ctx, tenantctx.Identity{TenantID: tenantID, Plane: "tenant"}),
	}
}

// execute walks the steps in order, running the platform-owned ones.
func (s *server) execute(ctx context.Context, run store.Run, resolved *tenantpb.ResolveTierResponse) store.Run {
	r := s.newRunner(ctx, run.TenantID)

	for _, step := range run.Steps {
		if step.Owner != "platform" || step.Status == "done" {
			continue
		}
		claimed, err := s.st.Claim(ctx, run.TenantID, step.ID)
		if err != nil {
			slog.Error("claim step", "tenant", run.TenantID, "step", step.ID, "err", err)
			continue
		}
		if !claimed {
			continue
		}

		err = r.perform(step.ID, run, resolved)
		if err != nil {
			// Loud, and not fatal. The merchant sees a step that did not
			// finish; a specialist sees why.
			slog.Error("provisioning step failed",
				"tenant", run.TenantID, "step", step.ID, "err", err)
		} else {
			slog.Info("provisioning step done", "tenant", run.TenantID, "step", step.ID)
		}
		if e := s.st.Finish(ctx, run.TenantID, step.ID, err); e != nil {
			slog.Error("record step", "tenant", run.TenantID, "step", step.ID, "err", e)
		}
	}

	if settled, err := s.st.SettleRun(ctx, run.TenantID, map[string]any{
		"tenant_id": run.TenantID, "tier": run.Tier, "industry": run.Industry,
		"business_name": run.BusinessName, "owner_user_id": run.OwnerUserID,
		"modules": resolvedModules(resolved),
	}); err != nil {
		slog.Error("settle run", "tenant", run.TenantID, "err", err)
	} else if settled {
		slog.Info("tenant provisioned", "tenant", run.TenantID, "tier", run.Tier)
	}

	out, err := s.st.Run(ctx, run.TenantID)
	if err != nil {
		return run
	}
	return out
}

func resolvedModules(r *tenantpb.ResolveTierResponse) []string {
	if r == nil {
		return nil
	}
	return r.GetModules()
}

func (r *runner) perform(stepID string, run store.Run, resolved *tenantpb.ResolveTierResponse) error {
	switch stepID {
	case "account":
		// Auth already did this: the user, the tenant ID and the merchant code
		// exist before provisioning is called at all. The step is on the
		// checklist because the merchant should see it, not because there is
		// work here.
		return nil
	case "entitlement", "profile":
		// Both are one call: the profile and the module set are written in one
		// transaction by Tenant, because a business with a profile and no
		// entitlement is a business that can sign in and do nothing.
		return r.applyTier(run)
	case "catalog":
		return r.seedCatalog(run, resolved)
	case "floor":
		return r.seedFloor(run)
	}
	return fmt.Errorf("no such provisioning step: %s", stepID)
}

func (r *runner) applyTier(run store.Run) error {
	_, err := r.tenant.ApplyTier(r.ctx, &tenantpb.ApplyTierRequest{
		TenantId:     run.TenantID.String(),
		BusinessName: run.BusinessName,
		Industry:     run.Industry,
		Tier:         run.Tier,
	})
	return err
}

// seedCatalog gives the merchant something to look at rather than an empty
// till.
//
// The template comes from their trade, and every figure in it is a starting
// point they are told to check. An empty catalog is technically correct and
// practically useless: a merchant who has to type forty items before they can
// see anything work will not get to the end of the first morning.
func (r *runner) seedCatalog(run store.Run, resolved *tenantpb.ResolveTierResponse) error {
	template := run.Industry
	if resolved != nil && resolved.GetCatalogTemplate() != "" {
		template = resolved.GetCatalogTemplate()
	}
	seed := templates.Catalog(template)
	if len(seed.Categories) == 0 && len(seed.Items) == 0 {
		return nil
	}

	byName := map[string]string{}
	for _, c := range seed.Categories {
		resp, err := r.catalog.CreateCategory(r.ctx, &catalogpb.CreateCategoryRequest{
			Category: &catalogpb.Category{Name: c.Name, Position: c.Position},
		})
		if err != nil {
			// A duplicate means provisioning already ran this far. Carry on
			// rather than failing the step: the point is the end state.
			slog.Warn("seed category", "tenant", run.TenantID, "name", c.Name, "err", err)
			continue
		}
		byName[c.Name] = resp.GetCategory().GetId()
	}

	currency := "HUF"
	for _, item := range seed.Items {
		kind := catalogpb.ItemKind_ITEM_KIND_PRODUCT
		if item.Service {
			kind = catalogpb.ItemKind_ITEM_KIND_SERVICE
		}
		if _, err := r.catalog.CreateItem(r.ctx, &catalogpb.CreateItemRequest{
			Item: &catalogpb.Item{
				Sku: item.SKU, Name: item.Name, Kind: kind,
				UnitPrice:       &commonpb.Money{Minor: item.PriceMinor, Currency: currency},
				TaxRate:         &commonpb.TaxRate{BasisPoints: item.TaxBasisPoints},
				TaxIncluded:     true,
				CategoryId:      byName[item.Category],
				TrackStock:      item.TrackStock,
				Active:          true,
				DurationMinutes: item.DurationMinutes,
			},
		}); err != nil {
			slog.Warn("seed item", "tenant", run.TenantID, "name", item.Name, "err", err)
		}
	}
	return nil
}

// seedFloor lays out tables, for a venue that has them.
//
// Only reached when the industry profile switched on table management, which is
// the trade capability doing its job: a bookshop never sees this step because
// the plan never included it.
func (r *runner) seedFloor(run store.Run) error {
	for _, t := range templates.Floor(run.Industry) {
		if _, err := r.pos.CreateTable(r.ctx, &pospb.CreateTableRequest{
			Label: t.Label, Seats: t.Seats, Area: t.Area,
		}); err != nil {
			slog.Warn("seed table", "tenant", run.TenantID, "label", t.Label, "err", err)
		}
	}
	return nil
}
