// Package registry is the module catalog, the tier definitions and the industry
// profiles: everything provisioning needs to turn "a cafe on Starter" into a
// set of modules, a vocabulary and a seeded catalog.
//
// It is Go rather than rows in a table, for now, because it changes when the
// product changes and the product changes in a release. The day a specialist
// edits it without deploying, it becomes data and this package becomes the
// thing that loads it. The shape is already right for that: nothing here is
// referenced by anything except by ID.
//
// It mirrors services/web/packages/entitlement, which the dashboard renders
// from. Two copies of a catalog is a real risk and the mitigation is the test
// beside this file: the dependency closure, the tier sets and the profile
// capabilities are asserted here, so a change on one side that is not made on
// the other fails rather than drifts quietly.
package registry

import "sort"

type ModuleKind string

const (
	// Ships with every tenant. Never appears in a picker.
	KindAlwaysOn ModuleKind = "always_on"
	// Sold, and belongs to a tier.
	KindSold ModuleKind = "sold"
	// Pulled in by something else. May also be sold on its own.
	KindDependency ModuleKind = "dependency"
)

type Module struct {
	ID   string
	Name string
	Kind ModuleKind
	// Requires, resolved transitively when a tier or an override is applied.
	Requires []string
	// Whether a self-serve upgrade can complete this module unattended.
	//
	// False means a step it triggers needs a person: KYC approval, ad-account
	// OAuth consent, hardware pairing. A self-serve signup that pulls in one
	// grants everything that provisioned cleanly and queues the rest to a
	// specialist, with the merchant told what is still coming. It never
	// silently half-completes.
	SelfServeCapable bool
}

// Modules mirrors the module catalog in system-architecture.html section 4.
//
// Modules do not map one to one onto services. Selecting POS switches on one
// service and pulls in three more, because an order needs something to price
// it, something to decrement, and something to charge it to.
var Modules = map[string]Module{
	"identity_tenancy": {ID: "identity_tenancy", Name: "Identity and tenancy", Kind: KindAlwaysOn, SelfServeCapable: true},
	"notifications":    {ID: "notifications", Name: "Notifications", Kind: KindAlwaysOn, SelfServeCapable: true},
	"audit_documents":  {ID: "audit_documents", Name: "Audit and documents", Kind: KindAlwaysOn, SelfServeCapable: true},

	"catalog":    {ID: "catalog", Name: "Catalog", Kind: KindDependency, SelfServeCapable: true},
	"inventory":  {ID: "inventory", Name: "Inventory", Kind: KindDependency, Requires: []string{"catalog"}, SelfServeCapable: true},
	"staff_rota": {ID: "staff_rota", Name: "Staff and rota", Kind: KindSold, SelfServeCapable: true},

	// KYC and connected-account onboarding take real calendar time, and no
	// amount of engineering shortens them. This flag is what makes that
	// visible on the checklist instead of surprising somebody on day two.
	"payments": {ID: "payments", Name: "Payments", Kind: KindSold, SelfServeCapable: false},

	"pos_orders":         {ID: "pos_orders", Name: "POS and orders", Kind: KindSold, Requires: []string{"catalog", "inventory", "payments"}, SelfServeCapable: true},
	"bookings":           {ID: "bookings", Name: "Bookings", Kind: KindSold, Requires: []string{"catalog", "staff_rota", "payments"}, SelfServeCapable: true},
	"website_storefront": {ID: "website_storefront", Name: "Website and storefront", Kind: KindSold, Requires: []string{"catalog"}, SelfServeCapable: true},
	"advanced_analytics": {ID: "advanced_analytics", Name: "Advanced analytics", Kind: KindSold, SelfServeCapable: true},

	// Ad-account OAuth consent cannot be given by us on the merchant's behalf.
	"marketing_ads": {ID: "marketing_ads", Name: "Marketing and ads", Kind: KindSold, Requires: []string{"advanced_analytics"}, SelfServeCapable: false},
	"ai_creative":   {ID: "ai_creative", Name: "AI creative", Kind: KindSold, Requires: []string{"marketing_ads"}, SelfServeCapable: true},
	"crm":           {ID: "crm", Name: "CRM", Kind: KindSold, SelfServeCapable: true},
}

// AlwaysOn is what every tenant holds regardless of tier. Identity, the ability
// to send an email, and a record of what happened are not upsells.
func AlwaysOn() []string {
	var out []string
	for id, m := range Modules {
		if m.Kind == KindAlwaysOn {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// Resolve expands a set of modules to include everything they require,
// transitively, plus the always-on set.
//
// This is the whole reason the Registry owns the dependency graph rather than
// each tier listing its closure: a tier says "POS", and POS deciding it needs
// Inventory is POS's business, not the price list's.
func Resolve(chosen []string) []string {
	seen := map[string]bool{}
	var visit func(string)
	visit = func(id string) {
		if seen[id] {
			return
		}
		m, ok := Modules[id]
		if !ok {
			return
		}
		seen[id] = true
		for _, req := range m.Requires {
			visit(req)
		}
	}
	for _, id := range chosen {
		visit(id)
	}
	for _, id := range AlwaysOn() {
		visit(id)
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// NeedsSpecialist reports which of a resolved set cannot be provisioned
// unattended. Those are granted but queued, and the merchant is told.
func NeedsSpecialist(modules []string) []string {
	var out []string
	for _, id := range modules {
		if m, ok := Modules[id]; ok && !m.SelfServeCapable {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}
