package main

import (
	"log/slog"
	"net/http"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	provpb "github.com/twentyfour/platform/gen/go/twentyfour/provisioning/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// Bootstrap is the single call the dashboard makes at login. Entitlements, the
// term set and the profile arrive together because the navigation cannot render
// without all three, and three round trips is three chances to draw it
// half-built.
type bootstrapBody struct {
	Session       sessionBody     `json:"session"`
	Profile       profileBody     `json:"profile"`
	Entitlement   entitlementBody `json:"entitlement"`
	TermOverrides map[string]any  `json:"termOverrides"`
	Onboarding    any             `json:"onboarding"`
}

type taxRate struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	BasisPoints int    `json:"basisPoints"`
	IsDefault   bool   `json:"isDefault"`
}

type openingHours struct {
	Day    int     `json:"day"`
	Open   *string `json:"open"`
	Close  *string `json:"close"`
	Closed bool    `json:"closed"`
}

type profileBody struct {
	TenantID         string         `json:"tenantId"`
	Name             string         `json:"name"`
	Industry         string         `json:"industry"`
	Locale           string         `json:"locale"`
	Currency         string         `json:"currency"`
	Timezone         string         `json:"timezone"`
	TaxRates         []taxRate      `json:"taxRates"`
	OpeningHours     []openingHours `json:"openingHours"`
	PricesIncludeTax bool           `json:"pricesIncludeTax"`
}

type seats struct {
	// A pointer because null means unlimited, which is what Enterprise
	// negotiates, and zero would read as "no seats at all".
	Limit *int `json:"limit"`
	Used  int  `json:"used"`
}

type entitlementBody struct {
	Tier         string   `json:"tier"`
	Modules      []string `json:"modules"`
	Capabilities []string `json:"capabilities"`
	Seats        seats    `json:"seats"`
	Pending      []string `json:"pending"`
}

// bootstrap is the single call the dashboard makes at login.
//
// Entitlements, the term set and the profile arrive together because the
// navigation cannot render without all three, and three round trips is three
// chances to draw it half-built.
func (g *gateway) bootstrap(w http.ResponseWriter, r *http.Request, c caller) {
	user, err := g.auth.GetUser(r.Context(), &authpb.GetUserRequest{
		TenantId: c.TenantID, UserId: c.UserID,
	})
	if err != nil {
		status, code, message := grpcStatus(err)
		httpx.Fail(w, r, status, code, message)
		return
	}
	ctx := g.downstream(r, c)

	// Seats come from Staff, which is the one place the limit is enforced.
	// Counting them here as well would mean the number a merchant reads and the
	// number they are refused by could disagree, and they would find out which
	// is which by being refused.
	used, limit := 1, 0
	if resp, err := g.staff.GetSeats(ctx, &staffpb.GetSeatsRequest{}); err == nil {
		used = int(resp.GetSeats().GetUsed())
	} else {
		slog.Warn("could not read seats", "err", err, "request_id", httpx.RequestID(r))
	}

	body := bootstrapBody{
		Session:       g.sessionOf(r, user.GetUser()),
		TermOverrides: map[string]any{},
		Onboarding:    nil,
	}

	profileResp, perr := g.tenant.GetProfile(ctx, &tenantpb.GetProfileRequest{})
	entResp, eerr := g.tenant.GetEntitlement(ctx, &tenantpb.GetEntitlementRequest{})
	if perr != nil || eerr != nil {
		// A tenant created before Provisioning existed has no profile. Serving
		// the market's defaults keeps them working rather than locking them
		// out of a dashboard they were using yesterday, and the log says which
		// tenant needs backfilling.
		slog.Warn("no provisioned profile; serving market defaults",
			"tenant", c.TenantID, "profile_err", perr, "entitlement_err", eerr)
		body.Profile = defaultProfile(c.TenantID)
		body.Entitlement = defaultEntitlement(used)
		httpx.JSON(w, r, http.StatusOK, body)
		return
	}

	p := profileResp.GetProfile()
	body.Profile = profileBody{
		TenantID: p.GetTenantId(), Name: p.GetName(), Industry: p.GetIndustry(),
		Locale: p.GetLocale(), Currency: p.GetCurrency(), Timezone: p.GetTimezone(),
		PricesIncludeTax: p.GetPricesIncludeTax(),
		TaxRates:         taxRatesOf(p), OpeningHours: hoursOf(p),
	}

	e := entResp.GetEntitlement()
	limit = int(e.GetSeatLimit())
	body.Entitlement = entitlementBody{
		Tier:    e.GetTier(),
		Modules: nonNil(e.GetModules()),
		// Trade capabilities. Nobody chose these: the industry profile switched
		// them on, and they never appear in a picker.
		Capabilities: nonNil(e.GetCapabilities()),
		Seats:        seats{Limit: seatLimit(limit), Used: used},
		// Granted, but a person has to finish provisioning them. The dashboard
		// shows these differently rather than pretending they work.
		Pending: nonNil(e.GetPending()),
	}

	if run, err := g.provisioning.Get(ctx, &provpb.GetRequest{}); err == nil {
		body.Onboarding = onboardingJSON(run.GetRun())
	}

	httpx.JSON(w, r, http.StatusOK, body)
}

func taxRatesOf(p *tenantpb.Profile) []taxRate {
	out := make([]taxRate, 0, len(p.GetTaxRates()))
	for _, r := range p.GetTaxRates() {
		out = append(out, taxRate{
			ID: r.GetId(), Label: r.GetLabel(),
			BasisPoints: int(r.GetBasisPoints()), IsDefault: r.GetIsDefault(),
		})
	}
	return out
}

func hoursOf(p *tenantpb.Profile) []openingHours {
	out := make([]openingHours, 0, len(p.GetOpeningHours()))
	for _, h := range p.GetOpeningHours() {
		entry := openingHours{Day: int(h.GetDay()), Closed: h.GetClosed()}
		if v := h.GetOpen(); v != "" {
			entry.Open = &v
		}
		if v := h.GetClose(); v != "" {
			entry.Close = &v
		}
		out = append(out, entry)
	}
	return out
}

// nonNil keeps an empty list an empty array rather than null. The dashboard
// iterates these, and null is a crash where empty is a quiet afternoon.
func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// defaultProfile is what a tenant sees when it has no provisioned profile: one
// created before this service existed. It is the market's defaults, not a
// guess about the business.
func defaultProfile(tenantID string) profileBody {
	return profileBody{
		TenantID: tenantID, Name: defaultBusinessName, Industry: "restaurant",
		Locale: "hu-HU", Currency: "HUF", Timezone: "Europe/Budapest",
		TaxRates: []taxRate{
			{ID: "standard", Label: "Standard", BasisPoints: 2700, IsDefault: true},
			{ID: "reduced", Label: "Reduced", BasisPoints: 500},
		},
		OpeningHours:     defaultOpeningHours(),
		PricesIncludeTax: true,
	}
}

func defaultEntitlement(used int) entitlementBody {
	limit := 3
	return entitlementBody{
		Tier: "starter",
		Modules: []string{
			"identity_tenancy", "notifications", "audit_documents",
			"catalog", "inventory", "staff_rota", "payments", "pos_orders", "bookings",
		},
		Capabilities: []string{},
		Seats:        seats{Limit: &limit, Used: used},
		Pending:      []string{},
	}
}

// seatLimit renders zero as null: zero means unlimited, which is what
// Enterprise negotiates, and zero on the wire would read as "no seats at all".
func seatLimit(n int) *int {
	if n <= 0 {
		return nil
	}
	return &n
}

const defaultBusinessName = "Your business"

func defaultOpeningHours() []openingHours {
	open, closeAt := "09:00", "22:00"
	hours := make([]openingHours, 0, 7)
	for day := 0; day < 7; day++ {
		hours = append(hours, openingHours{Day: day, Open: &open, Close: &closeAt})
	}
	return hours
}
