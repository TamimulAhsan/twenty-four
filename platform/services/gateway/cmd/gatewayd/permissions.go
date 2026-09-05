package main

// The dashboard and the RBAC service speak different permission vocabularies.
//
// The dashboard uses coarse, screen-shaped keys ("catalog.edit") because that
// is what a merchant picks from when building a custom role. RBAC uses precise
// three-part keys ("catalog:item:update") because that is what a gateway check
// needs to be unambiguous.
//
// Neither is wrong, and neither should adopt the other's shape: a role editor
// listing "catalog:item:archive" separately from "catalog:item:update" would be
// unusable, and a gateway checking "catalog.edit" could not distinguish editing
// from archiving. The gateway translates, which is exactly the kind of seam a
// gateway exists to own.
var uiPermissions = map[string][]string{
	"catalog.view":        {"catalog:item:read"},
	"catalog.edit":        {"catalog:item:create", "catalog:item:update", "catalog:item:archive"},
	"pos.sell":            {"pos:order:create"},
	"pos.discount":        {"pos:order:update"},
	"pos.void":            {"pos:order:void"},
	"pos.refund":          {"pos:refund:create"},
	"pos.close_day":       {"pos:shift:close"},
	"bookings.view":       {"bookings:booking:read"},
	"bookings.manage":     {"bookings:booking:create", "bookings:booking:update"},
	"bookings.cancel":     {"bookings:booking:cancel"},
	"inventory.view":      {"inventory:stock:read"},
	"inventory.adjust":    {"inventory:stock:adjust"},
	"staff.view":          {"staff:member:read"},
	"staff.manage":        {"staff:member:create", "staff:member:update"},
	"staff.roles":         {"staff:rota:manage"},
	"payments.view":       {"payment:payment:read"},
	"payments.refund":     {"payment:refund:create"},
	"documents.view":      {"invoice:document:read"},
	"documents.correct":   {"invoice:document:issue"},
	"reports.operational": {"analytics:report:read"},
	"reports.financial":   {"ledger:report:read"},
	"marketing.view":      {"marketing:campaign:read"},
	"marketing.manage":    {"marketing:campaign:manage"},
	"settings.business":   {"tenant:profile:update"},
	"settings.tax":        {"tenant:profile:update"},
	"settings.billing":    {"tenant:billing:manage"},
}

// uiPermissionsFor reports which dashboard permissions a set of RBAC grants
// satisfies. A dashboard permission is held when every RBAC permission behind
// it is held: "catalog.edit" means create, update and archive, so holding only
// update does not earn it.
func uiPermissionsFor(granted []string) []string {
	held := make(map[string]bool, len(granted))
	for _, g := range granted {
		held[g] = true
	}
	// A wildcard grant satisfies anything beneath it, so expand by matching
	// rather than by exact lookup.
	satisfies := func(want string) bool {
		if held[want] {
			return true
		}
		for g := range held {
			if grants(g, want) {
				return true
			}
		}
		return false
	}

	out := make([]string, 0, len(uiPermissions))
	for ui, required := range uiPermissions {
		all := true
		for _, req := range required {
			if !satisfies(req) {
				all = false
				break
			}
		}
		if all {
			out = append(out, ui)
		}
	}
	return out
}

// grants mirrors the RBAC service's own matching: segment by segment, with "*"
// matching anything in that position.
func grants(held, want string) bool {
	h, w := split3(held), split3(want)
	if h == nil || w == nil {
		return false
	}
	for i := range h {
		if h[i] != "*" && h[i] != w[i] {
			return false
		}
	}
	return true
}

func split3(s string) []string {
	parts := make([]string, 0, 3)
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	if len(parts) != 3 {
		return nil
	}
	return parts
}
