package main

import (
	"net/http"

	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/services/gateway/internal/httpx"
)

// Read endpoints whose services are not built yet.
//
// These return a real empty result rather than 501, so the dashboard renders
// its own "nothing here yet" states instead of an error panel on every card.
// That is honest: a newly provisioned tenant genuinely has no orders, no stock
// and no documents. The distinction that matters is empty versus broken, and a
// 501 on a list makes an empty business look like an outage.
//
// Writes are deliberately not stubbed. Accepting an order and discarding it
// would be worse than refusing it, so anything that mutates still answers 501
// through the catch-all.
func (g *gateway) registerReadStubs(mux *http.ServeMux) {
	empty := func(permission string) http.Handler {
		return g.authenticated(func(w http.ResponseWriter, r *http.Request, c caller) {
			if permission != "" && !g.requirePermission(w, r, c, permission) {
				return
			}
			httpx.JSON(w, r, http.StatusOK, []any{})
		})
	}
	object := func(permission string, body any) http.Handler {
		return g.authenticated(func(w http.ResponseWriter, r *http.Request, c caller) {
			if permission != "" && !g.requirePermission(w, r, c, permission) {
				return
			}
			httpx.JSON(w, r, http.StatusOK, body)
		})
	}

	// Collections. The permission on each is the real one from the RBAC
	// vocabulary, so a staff member already sees a narrower dashboard than an
	// owner even before the services behind these exist.
	mux.Handle("GET /api/catalog/items", empty("catalog:item:read"))
	mux.Handle("GET /api/catalog/categories", empty("catalog:item:read"))
	mux.Handle("GET /api/orders", empty("pos:order:read"))
	mux.Handle("GET /api/bookings", empty("bookings:booking:read"))
	mux.Handle("GET /api/tables", empty("bookings:booking:read"))
	mux.Handle("GET /api/inventory/levels", empty("inventory:stock:read"))
	mux.Handle("GET /api/staff", empty("staff:member:read"))
	mux.Handle("GET /api/staff/invitations", empty("staff:member:read"))
	mux.Handle("GET /api/payments", empty("payment:payment:read"))
	mux.Handle("GET /api/documents", empty("invoice:document:read"))
	mux.Handle("GET /api/customers", empty("crm:contact:read"))
	mux.Handle("GET /api/discounts", empty("catalog:item:read"))
	mux.Handle("GET /api/loyalty/members", empty("crm:contact:read"))

	// Roles come from RBAC, which does exist.
	mux.Handle("GET /api/roles", g.authenticated(g.listRoles))

	// Single objects. A null body is the honest answer for a programme or an
	// onboarding run that has not been created.
	mux.Handle("GET /api/loyalty/programme", object("crm:contact:read", nil))
	mux.Handle("GET /api/onboarding", object("", nil))

	// The day's takings. Zero is the correct figure for a business that has not
	// sold anything yet, and the till reads the same shape once POS is built.
	mux.Handle("GET /api/orders/takings", object("pos:takings:read", map[string]any{
		"date":       "",
		"orderCount": 0,
		"gross":      money(0),
		"net":        money(0),
		"tax":        money(0),
		"byMethod":   []any{},
	}))
}

// money is the wire shape: integer minor units and an explicit currency, never
// a float. One environment is one market, so the currency is the market's.
func money(minor int64) map[string]any {
	return map[string]any{"minor": minor, "currency": "HUF"}
}

// listRoles returns the tenant's roles from RBAC, which is a real service.
func (g *gateway) listRoles(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.rbac.ListRoles(r.Context(), &rbacpb.ListRolesRequest{
		TenantId: c.TenantID, Plane: planePB(c.Plane), IncludeSystem: true,
	})
	if err != nil {
		status, code, message := grpcStatus(err)
		httpx.Fail(w, r, status, code, message)
		return
	}
	// Rank orders the roles in the UI. It mirrors the capability ordering used
	// when picking a single label for a person who holds several roles.
	rankOf := map[string]int{"owner": 3, "manager": 2, "accountant": 1, "staff": 0}

	out := make([]map[string]any, 0, len(resp.GetRoles()))
	for _, role := range resp.GetRoles() {
		out = append(out, map[string]any{
			"id":          role.GetKey(),
			"key":         role.GetKey(),
			"name":        role.GetName(),
			"description": role.GetDescription(),
			// Translated into the vocabulary the role editor renders. The
			// service's own three-part keys would show as unrecognised.
			"permissions": uiPermissionsFor(role.GetPermissions()),
			"builtIn":     role.GetSystem(),
			"system":      role.GetSystem(),
			"rank":        rankOf[role.GetKey()],
		})
	}
	httpx.JSON(w, r, http.StatusOK, out)
}
