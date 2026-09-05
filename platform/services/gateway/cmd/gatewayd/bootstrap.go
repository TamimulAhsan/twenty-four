package main

import (
	"net/http"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	"github.com/twentyfour/platform/services/gateway/internal/httpx"
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

func (g *gateway) bootstrap(w http.ResponseWriter, r *http.Request, c caller) {
	user, err := g.auth.GetUser(r.Context(), &authpb.GetUserRequest{
		TenantId: c.TenantID, UserId: c.UserID,
	})
	if err != nil {
		status, code, message := grpcStatus(err)
		httpx.Fail(w, r, status, code, message)
		return
	}

	// Seats in use is a real number: it is what the tier limit is checked
	// against, and showing a stale one is how a merchant discovers the limit by
	// being refused rather than by reading it.
	used := 1
	if list, err := g.auth.ListUsers(r.Context(), &authpb.ListUsersRequest{TenantId: c.TenantID}); err == nil {
		used = int(list.GetActiveCount())
	}

	// Tenant & Business Profile and Entitlement do not exist yet, so these are
	// the defaults a freshly provisioned Hungarian tenant would receive. When
	// those services land this reads from them and nothing else changes: the
	// shape on the wire is already the contract.
	limit := 3
	httpx.JSON(w, r, http.StatusOK, bootstrapBody{
		Session: g.sessionOf(r, user.GetUser()),
		Profile: profileBody{
			TenantID: c.TenantID,
			Name:     defaultBusinessName,
			Industry: "restaurant",
			Locale:   "hu-HU",
			Currency: "HUF",
			Timezone: "Europe/Budapest",
			TaxRates: []taxRate{
				{ID: "standard", Label: "Standard", BasisPoints: 2700, IsDefault: true},
				{ID: "reduced", Label: "Reduced", BasisPoints: 500},
			},
			OpeningHours:     defaultOpeningHours(),
			PricesIncludeTax: true,
		},
		Entitlement: entitlementBody{
			Tier: "starter",
			// The Starter set from the architecture, with the dependencies it
			// pulls in. Catalog, inventory and staff are not sold separately;
			// they arrive because POS and Bookings need them.
			Modules: []string{
				"pos", "bookings", "payments", "catalog", "inventory", "staff",
			},
			Capabilities: []string{},
			Seats:        seats{Limit: &limit, Used: used},
			Pending:      []string{},
		},
		TermOverrides: map[string]any{},
		Onboarding:    nil,
	})
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
