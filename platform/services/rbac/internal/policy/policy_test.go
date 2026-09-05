package policy

import "testing"

func TestGrants_Wildcards(t *testing.T) {
	cases := []struct {
		held, want Permission
		grants     bool
	}{
		{"pos:order:create", "pos:order:create", true},
		{"pos:order:*", "pos:order:create", true},
		{"pos:*:*", "pos:order:create", true},
		{"*:*:*", "pos:order:create", true},
		{"pos:order:create", "pos:order:void", false},
		{"pos:*:*", "catalog:item:create", false},
		{"catalog:item:read", "catalog:item:update", false},
		// A wildcard must not match across segment boundaries.
		{"pos:*", "pos:order:create", false},
	}
	for _, c := range cases {
		if got := Grants(c.held, c.want); got != c.grants {
			t.Errorf("Grants(%q, %q) = %v, want %v", c.held, c.want, got, c.grants)
		}
	}
}

// Deny by default. Any malformed or empty input must refuse, never guess.
func TestDecide_DeniesByDefault(t *testing.T) {
	staff, _ := SystemRole("staff")
	cases := []struct {
		name  string
		roles []Role
		plane Plane
		want  Permission
	}{
		{"no roles", nil, PlaneTenant, "pos:order:create"},
		{"permission not held", []Role{staff}, PlaneTenant, "catalog:item:update"},
		{"malformed permission", []Role{staff}, PlaneTenant, "pos:order"},
		{"wildcard in the check", []Role{staff}, PlaneTenant, "pos:order:*"},
		{"empty segment", []Role{staff}, PlaneTenant, "pos::create"},
		{"invalid plane", []Role{staff}, Plane("nonsense"), "pos:order:create"},
	}
	for _, c := range cases {
		if allowed, _ := Decide(c.roles, c.plane, c.want); allowed {
			t.Errorf("%s: allowed, want denied", c.name)
		}
	}
}

// The isolation that matters most: a merchant role must never satisfy an
// admin-plane check, even when it holds "*:*:*".
func TestDecide_PlanesNeverCross(t *testing.T) {
	owner, _ := SystemRole("owner") // tenant plane, holds *:*:*
	if allowed, _ := Decide([]Role{owner}, PlaneAdmin, "tenant:profile:read"); allowed {
		t.Fatal("a tenant owner satisfied an admin-plane check")
	}
	admin, _ := SystemRole("platform_admin") // admin plane, holds *:*:*
	if allowed, _ := Decide([]Role{admin}, PlaneTenant, "pos:order:create"); allowed {
		t.Fatal("a platform admin satisfied a tenant-plane check")
	}
}

func TestDecide_ReportsGrantingRole(t *testing.T) {
	staff, _ := SystemRole("staff")
	manager, _ := SystemRole("manager")
	allowed, by := Decide([]Role{staff, manager}, PlaneTenant, "catalog:item:update")
	if !allowed {
		t.Fatal("manager should grant catalog:item:update")
	}
	if by != "manager" {
		t.Fatalf("granted by %q, want manager", by)
	}
}

// Staff serve customers; they must not be able to reprice or see takings.
func TestSystemRoles_StaffIsProperlyLimited(t *testing.T) {
	staff, ok := SystemRole("staff")
	if !ok {
		t.Fatal("staff role missing")
	}
	mustAllow := []Permission{"pos:order:create", "bookings:booking:create", "catalog:item:read"}
	mustDeny := []Permission{
		"catalog:item:update", "pos:takings:read", "pos:order:void",
		"staff:member:create", "tenant:billing:manage", "payment:refund:create",
	}
	for _, p := range mustAllow {
		if allowed, _ := Decide([]Role{staff}, PlaneTenant, p); !allowed {
			t.Errorf("staff should be allowed %q", p)
		}
	}
	for _, p := range mustDeny {
		if allowed, _ := Decide([]Role{staff}, PlaneTenant, p); allowed {
			t.Errorf("staff must NOT be allowed %q", p)
		}
	}
}

// Support can look but not change entitlements — that is a specialist action.
func TestSystemRoles_SupportIsReadOnlyOnEntitlements(t *testing.T) {
	support, _ := SystemRole("support")
	if allowed, _ := Decide([]Role{support}, PlaneAdmin, "entitlement:module:read"); !allowed {
		t.Error("support should read entitlements")
	}
	if allowed, _ := Decide([]Role{support}, PlaneAdmin, "entitlement:module:manage"); allowed {
		t.Error("support must NOT manage entitlements")
	}
}

func TestFlatten_DedupesAndScopesToPlane(t *testing.T) {
	staff, _ := SystemRole("staff")
	admin, _ := SystemRole("platform_admin")
	got := Flatten([]Role{staff, staff, admin}, PlaneTenant)
	seen := map[Permission]int{}
	for _, p := range got {
		seen[p]++
	}
	for p, n := range seen {
		if n != 1 {
			t.Fatalf("%q appears %d times, want 1", p, n)
		}
	}
	for _, p := range got {
		if p == "*:*:*" {
			t.Fatal("admin-plane permission leaked into the tenant-plane set")
		}
	}
}

// Every permission a system role grants must be well-formed, or a typo silently
// becomes a permission nobody can ever satisfy.
func TestSystemRoles_GrantsAreWellFormed(t *testing.T) {
	for _, r := range SystemRoles {
		if !r.Plane.Valid() {
			t.Errorf("role %q has invalid plane %q", r.Key, r.Plane)
		}
		for _, p := range r.Permissions {
			if err := p.ValidGrant(); err != nil {
				t.Errorf("role %q: %v", r.Key, err)
			}
		}
	}
	for _, p := range KnownPermissions {
		if err := p.Valid(); err != nil {
			t.Errorf("known permission: %v", err)
		}
	}
}
