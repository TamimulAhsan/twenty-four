package main

import (
	"net/http"

	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/packages/httpx"
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
	// Catalog, Staff, Inventory, Payments, POS, Invoicing, Media, Audit and
	// the Ledger are all real now. Their routes live in their own files.
	mux.Handle("GET /api/customers", empty("crm:contact:read"))
	mux.Handle("GET /api/discounts", empty("catalog:item:read"))
	mux.Handle("GET /api/loyalty/members", empty("crm:contact:read"))

	// Roles come from RBAC, which does exist.
	mux.Handle("GET /api/roles", g.authenticated(g.listRoles))

	// A null body is the honest answer for a loyalty programme nobody has set
	// up. Onboarding is real now; see signup.go.
	mux.Handle("GET /api/loyalty/programme", object("crm:contact:read", nil))

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
