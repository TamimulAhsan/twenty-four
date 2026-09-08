package registry

// Tier definitions.
//
// There is no per-module pricing. A tenant sits on a tier and the tier decides
// the module set; entitlement is still evaluated per module, because that is
// what the gateway checks and what the dashboard renders from, but the module
// count never enters a price calculation. Changing tier is what changes the
// bill.
type Tier struct {
	ID   string
	Name string
	// What the tier grants before dependencies are resolved.
	Grants []string
	// Zero means negotiated, which is what Enterprise means.
	Seats int32
}

var Tiers = map[string]Tier{
	"starter": {
		ID: "starter", Name: "Starter", Seats: 3,
		// The industry tool set: a till, a calendar, and the ability to take
		// money. Catalog, Inventory and Staff arrive through dependencies
		// rather than being sold, because nothing works without them.
		Grants: []string{"pos_orders", "bookings", "payments"},
	},
	"growth": {
		ID: "growth", Name: "Growth", Seats: 5,
		Grants: []string{"pos_orders", "bookings", "payments", "website_storefront", "marketing_ads"},
	},
	"max": {
		ID: "max", Name: "Max", Seats: 15,
		Grants: []string{"pos_orders", "bookings", "payments", "website_storefront",
			"marketing_ads", "ai_creative", "crm"},
	},
	// Everything in Max, and the deviations are recorded as overrides against
	// the tenant rather than as a different module set here. Enterprise is
	// simply the case where the override is the tier.
	"enterprise": {
		ID: "enterprise", Name: "Enterprise", Seats: 0,
		Grants: []string{"pos_orders", "bookings", "payments", "website_storefront",
			"marketing_ads", "ai_creative", "crm"},
	},
}

func TierOf(id string) (Tier, bool) {
	t, ok := Tiers[id]
	return t, ok
}
