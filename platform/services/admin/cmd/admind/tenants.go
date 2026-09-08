package main

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The directory and one tenant's record.
//
// Every per-tenant read here works by naming the tenant in the outgoing
// headers. Nothing in the domain services changed to allow that: GetProfile and
// GetEntitlement take empty request messages and read their tenant from the
// context, so a gateway that sets the header can address any tenant, and one
// that does not can address none. The tenant boundary is exactly as tight for a
// specialist as it is for a merchant; what differs is who is allowed to choose.

/* --------------------------------------------------------------- the wire */

type seatsView struct {
	Used  int32 `json:"used"`
	Limit int32 `json:"limit"`
}

type tenantRow struct {
	TenantID     string `json:"tenantId"`
	Name         string `json:"name"`
	MerchantCode string `json:"merchantCode"`
	Industry     string `json:"industry"`
	Tier         string `json:"tier"`
	Status       string `json:"status"`
	Health       string `json:"health"`
	HealthNote   string `json:"healthNote"`
	City         string `json:"city"`
	OnboardedAt  string `json:"onboardedAt"`
	// Null, and it will stay null until the registry carries prices. The tier
	// registry has none: seat counts are set and prices are not, so any figure
	// here would be invented by this gateway. See admin-plan.md.
	MRR *money `json:"mrr"`
	// The merchant's own trading. Null in the directory, because reading it
	// means asking POS once per tenant. Emitted as null rather than omitted:
	// an absent field is undefined to a client, and undefined is the one thing
	// a null check does not catch.
	GMV30d    *money `json:"gmv30d"`
	Orders30d *int32 `json:"orders30d"`
	SeatsUsed *int32 `json:"seatsUsed"`
	SeatLimit *int32 `json:"seatLimit"`
}

type money struct {
	Minor    string `json:"minor"`
	Currency string `json:"currency"`
}

type tenantListBody struct {
	Tenants []tenantRow `json:"tenants"`
	Total   int32       `json:"total"`
	// Empty when this was the last page.
	NextCursor string `json:"nextCursor"`
}

type moduleView struct {
	ModuleID string `json:"moduleId"`
	// tier, profile or override. Why the tenant holds it, which is the question
	// a specialist looking at this list is actually asking.
	Source  string `json:"source"`
	Pending bool   `json:"pending"`
}

type quotaView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Used  int32  `json:"used"`
	// Null means no ceiling, which Enterprise negotiates. Not the same as zero.
	Limit *int32 `json:"limit"`
	Unit  string `json:"unit"`
	// Set only when unit is money, so a figure keeps its currency.
	Amount  *money `json:"amount"`
	Ceiling *money `json:"ceiling"`
}

type tenantDetailBody struct {
	tenantRow
	Locale     string       `json:"locale"`
	Currency   string       `json:"currency"`
	Timezone   string       `json:"timezone"`
	Address    string       `json:"address"`
	TaxID      string       `json:"taxId"`
	Modules    []moduleView `json:"modules"`
	Seats      seatsView    `json:"seats"`
	StatusNote string       `json:"statusNote"`

	// Everything below is owned by a service that may not be built. Empty and
	// null rather than absent: a console renders what it was given and says
	// nothing about the rest, and a zero would be a claim rather than a gap.
	Quotas       []quotaView `json:"quotas"`
	Integrations []struct{}  `json:"integrations"`
	Revenue      []struct{}  `json:"revenue"`
	Refunded30d  *money      `json:"refunded30d"`
	// Null until Invoicing exists. Nothing else knows what a tenant is billed.
	Subscription *struct{} `json:"subscription"`
}

/* ------------------------------------------------------------- the health */

// Health is derived here and stored nowhere.
//
// It answers "does anybody need to do something", which is a judgement over
// several services' state rather than a fact about the tenant. Storing it would
// mean a column that goes stale the moment a seat is freed, and something would
// have to remember to update it.
//
// Deliberately not derived from the health note: the note is a sentence for a
// person, and recovering a level by searching prose for the word "failed" stops
// working the first time somebody writes "no failures".
func healthOf(status string, statusNote string, seats *seatsView) (string, string) {
	switch status {
	case "suspended":
		note := "Suspended."
		if statusNote != "" {
			note = "Suspended: " + statusNote
		}
		return "failing", note
	case "provisioning":
		return "attention", "Still being set up."
	case "trial":
		return "attention", "On trial. No subscription has started."
	}
	// Full is the gateway's own threshold, not a warning ahead of it: at the
	// limit the next invite is refused, and anything softer would be this
	// console inventing a policy the enforcement does not have.
	if seats != nil && seats.Limit > 0 && seats.Used >= seats.Limit {
		return "attention", "Every staff seat is taken. The next invite will be refused."
	}
	return "ok", "Nothing outstanding."
}

/* ---------------------------------------------------------- the directory */

// seatBudget caps how long the directory waits on the seat fan-out.
//
// The directory asks Staff once per tenant, which is an N+1 across a service
// boundary and is only acceptable while N is small. It is bounded and it
// degrades rather than failing: a tenant whose seat count did not arrive shows
// no seat figure instead of taking the page down with it.
//
// The real fix is a batch read or a counter fed from the event stream. It is
// named in admin-plan.md rather than left for somebody to discover.
const seatBudget = 2 * time.Second

const seatConcurrency = 8

func (g *adminGateway) listTenants(w http.ResponseWriter, r *http.Request, c caller) {
	q := r.URL.Query()
	req := &tenantpb.ListTenantsRequest{Cursor: q.Get("cursor")}
	for _, name := range q["status"] {
		req.Status = append(req.Status, statusPB(name))
	}
	req.Tier = q["tier"]

	resp, err := g.tenant.ListTenants(g.downstream(r, c, uuid.Nil), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}

	ids := make([]string, 0, len(resp.GetTenants()))
	for _, t := range resp.GetTenants() {
		ids = append(ids, t.GetTenantId())
	}
	// One call for the whole page. The seat counts below are still one call per
	// tenant, because Staff has no batch read; that asymmetry is the thing to
	// fix next, not to copy.
	codes := map[string]string{}
	if answer, err := g.auth.ListMerchantCodes(r.Context(),
		&authpb.ListMerchantCodesRequest{TenantIds: ids}); err == nil {
		codes = answer.GetMerchantCodes()
	} else {
		slog.Warn("merchant codes unavailable", "err", err, "request_id", httpx.RequestID(r))
	}

	seats := g.seatsFor(r.Context(), c, resp.GetTenants())

	body := tenantListBody{
		// Never null: an empty directory is [] so the console can map over it
		// without asking whether it exists.
		Tenants:    []tenantRow{},
		Total:      resp.GetTotal(),
		NextCursor: resp.GetNextCursor(),
	}
	for _, t := range resp.GetTenants() {
		row := tenantRow{
			TenantID:     t.GetTenantId(),
			Name:         t.GetName(),
			Industry:     t.GetIndustry(),
			Tier:         t.GetTier(),
			MerchantCode: codes[t.GetTenantId()],
			Status:       statusName(t.GetStatus()),
			City:         t.GetCity(),
			OnboardedAt:  t.GetCreatedAt().AsTime().Format(time.RFC3339),
		}
		if limit := t.GetSeatLimit(); limit > 0 {
			row.SeatLimit = &limit
		}
		var view *seatsView
		if used, ok := seats[t.GetTenantId()]; ok {
			row.SeatsUsed = &used
			view = &seatsView{Used: used, Limit: t.GetSeatLimit()}
		}
		row.Health, row.HealthNote = healthOf(row.Status, "", view)
		body.Tenants = append(body.Tenants, row)
	}
	// The console asks for a stable order and the store pages by creation, but
	// a directory reads by name. Sorted here rather than in the query so the
	// cursor stays on the column the page is keyed by.
	sort.SliceStable(body.Tenants, func(i, j int) bool {
		return body.Tenants[i].Name < body.Tenants[j].Name
	})
	httpx.JSON(w, r, http.StatusOK, body)
}

// seatsFor asks Staff how many seats each tenant is using.
//
// Bounded and best-effort. A tenant whose answer does not arrive in time is
// absent from the map and renders without a seat figure, which is a directory
// missing one number rather than a directory that failed.
func (g *adminGateway) seatsFor(
	ctx context.Context,
	c caller,
	rows []*tenantpb.TenantRow,
) map[string]int32 {
	ctx, cancel := context.WithTimeout(ctx, seatBudget)
	defer cancel()

	out := make(map[string]int32, len(rows))
	var mu sync.Mutex
	var wg sync.WaitGroup
	gate := make(chan struct{}, seatConcurrency)

	for _, row := range rows {
		id, err := uuid.Parse(row.GetTenantId())
		if err != nil {
			continue
		}
		wg.Add(1)
		go func(tenantID uuid.UUID) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()

			resp, err := g.staff.GetSeats(g.outbound(ctx, c, tenantID), &staffpb.GetSeatsRequest{})
			if err != nil {
				slog.Debug("seat count unavailable", "tenant", tenantID, "err", err)
				return
			}
			mu.Lock()
			out[tenantID.String()] = resp.GetSeats().GetUsed()
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

/* ------------------------------------------------------------- one tenant */

func (g *adminGateway) getTenant(w http.ResponseWriter, r *http.Request, c caller) {
	tenantID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.Fail(w, r, http.StatusNotFound, httpx.CodeNotFound, "No tenant with that id.")
		return
	}
	ctx := g.downstream(r, c, tenantID)

	profile, err := g.tenant.GetProfile(ctx, &tenantpb.GetProfileRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	entitlement, err := g.tenant.GetEntitlement(ctx, &tenantpb.GetEntitlementRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}

	p := profile.GetProfile()
	e := entitlement.GetEntitlement()

	// One call, not a fan-out: this is one tenant's page.
	seats := seatsView{Limit: e.GetSeatLimit()}
	if resp, err := g.staff.GetSeats(ctx, &staffpb.GetSeatsRequest{}); err == nil {
		seats.Used = resp.GetSeats().GetUsed()
	} else {
		slog.Warn("seat count unavailable", "tenant", tenantID, "err", err)
	}

	row := tenantRow{
		TenantID:     p.GetTenantId(),
		Name:         p.GetName(),
		MerchantCode: p.GetMerchantCode(),
		Industry:     p.GetIndustry(),
		Tier:         e.GetTier(),
		Status:       statusName(p.GetStatus()),
		City:         p.GetCity(),
		OnboardedAt:  p.GetCreatedAt().AsTime().Format(time.RFC3339),
		SeatsUsed:    &seats.Used,
	}
	if limit := e.GetSeatLimit(); limit > 0 {
		row.SeatLimit = &limit
	}
	row.Health, row.HealthNote = healthOf(row.Status, p.GetStatusReason(), &seats)

	body := tenantDetailBody{
		tenantRow:  row,
		Locale:     p.GetLocale(),
		Currency:   p.GetCurrency(),
		Timezone:   p.GetTimezone(),
		Address:    p.GetAddress(),
		TaxID:      p.GetTaxId(),
		Seats:      seats,
		StatusNote: p.GetStatusReason(),
		// The one quota anything actually knows. Storage and the ad budget are
		// owned by Media and Marketing, and neither is built; listing them at
		// zero would read as a tenant using none of either.
		Quotas: []quotaView{{
			ID: "seats", Label: "Staff seats", Used: seats.Used, Unit: "count",
			Limit: limitOrNil(e.GetSeatLimit()),
		}},
		// Empty, not absent. A list that is sometimes null is a list every
		// caller has to guard before it can loop.
		Integrations: []struct{}{},
		Revenue:      []struct{}{},
	}
	// Source travels with each module because it is the question a specialist
	// is asking: not "do they hold the CRM" but "why do they hold it".
	for _, m := range e.GetGrants() {
		body.Modules = append(body.Modules, moduleView{
			ModuleID: m.GetModuleId(), Source: m.GetSource(), Pending: m.GetPending(),
		})
	}

	httpx.JSON(w, r, http.StatusOK, body)
}

/* ------------------------------------------------------------ the statuses */

// limitOrNil turns the wire's "zero means unlimited" into a null a client can
// tell apart from a limit of none.
func limitOrNil(limit int32) *int32 {
	if limit <= 0 {
		return nil
	}
	return &limit
}

func statusName(s tenantpb.TenantStatus) string {
	switch s {
	case tenantpb.TenantStatus_TENANT_STATUS_PROVISIONING:
		return "provisioning"
	case tenantpb.TenantStatus_TENANT_STATUS_SUSPENDED:
		return "suspended"
	case tenantpb.TenantStatus_TENANT_STATUS_TRIAL:
		return "trial"
	default:
		return "live"
	}
}

func statusPB(name string) tenantpb.TenantStatus {
	switch name {
	case "provisioning":
		return tenantpb.TenantStatus_TENANT_STATUS_PROVISIONING
	case "suspended":
		return tenantpb.TenantStatus_TENANT_STATUS_SUSPENDED
	case "trial":
		return tenantpb.TenantStatus_TENANT_STATUS_TRIAL
	case "live":
		return tenantpb.TenantStatus_TENANT_STATUS_LIVE
	default:
		return tenantpb.TenantStatus_TENANT_STATUS_UNSPECIFIED
	}
}
