// Package policy holds the permission model and the decision function.
//
// The model is deliberately plain RBAC scoped by tenant and plane. I suggested
// Casbin earlier; on reflection a direct implementation is better here because
// the admin console has to render and edit these roles, and reading them out of
// ordinary tables beats reading them out of a policy engine's storage adapter.
// If the model ever needs attribute conditions, revisit that.
package policy

import (
	"fmt"
	"sort"
	"strings"
)

// Plane separates merchant staff from TwentyFour specialists. A binding in one
// plane can never satisfy a check in the other, whatever else goes wrong.
type Plane string

const (
	PlaneTenant Plane = "tenant"
	PlaneAdmin  Plane = "admin"
)

func (p Plane) Valid() bool { return p == PlaneTenant || p == PlaneAdmin }

// Permission keys are "<domain>:<resource>:<action>", e.g. "pos:order:create".
// A role may hold wildcards; a check may never contain one.
type Permission string

const wildcard = "*"

// Domain returns the leading segment, used to group permissions in the UI.
func (p Permission) Domain() string {
	if i := strings.IndexByte(string(p), ':'); i >= 0 {
		return string(p)[:i]
	}
	return string(p)
}

// Valid reports whether a permission is well-formed as a *check* — three
// non-empty segments and no wildcard. Checks must always be concrete, so a
// caller can never accidentally ask "am I allowed anything at all?".
func (p Permission) Valid() error {
	parts := strings.Split(string(p), ":")
	if len(parts) != 3 {
		return fmt.Errorf("policy: permission %q must be domain:resource:action", p)
	}
	for _, s := range parts {
		if s == "" {
			return fmt.Errorf("policy: permission %q has an empty segment", p)
		}
		if s == wildcard {
			return fmt.Errorf("policy: permission %q must not contain a wildcard in a check", p)
		}
	}
	return nil
}

// ValidGrant is the looser rule for what a role may hold: wildcards allowed.
func (p Permission) ValidGrant() error {
	parts := strings.Split(string(p), ":")
	if len(parts) != 3 {
		return fmt.Errorf("policy: grant %q must be domain:resource:action", p)
	}
	for _, s := range parts {
		if s == "" {
			return fmt.Errorf("policy: grant %q has an empty segment", p)
		}
	}
	return nil
}

// Grants reports whether a held permission satisfies a requested one.
// Matching is per segment, so "pos:order:*" grants "pos:order:create" but not
// "catalog:item:create". A bare "*:*:*" is full access and is only ever held
// by the platform owner role.
func Grants(held, want Permission) bool {
	h := strings.Split(string(held), ":")
	w := strings.Split(string(want), ":")
	if len(h) != 3 || len(w) != 3 {
		return false
	}
	for i := range h {
		if h[i] != wildcard && h[i] != w[i] {
			return false
		}
	}
	return true
}

// Role is a named set of permissions within a plane.
type Role struct {
	Key         string
	Name        string
	Description string
	Plane       Plane
	Permissions []Permission
	System      bool
}

// Allows reports whether the role grants the requested permission.
func (r Role) Allows(want Permission) bool {
	for _, held := range r.Permissions {
		if Grants(held, want) {
			return true
		}
	}
	return false
}

// Decide evaluates a set of roles against one requested permission and reports
// which role granted it. Deny is the default: an empty role set never allows
// anything, and an unparseable request is refused rather than guessed at.
func Decide(roles []Role, plane Plane, want Permission) (allowed bool, grantedBy string) {
	if err := want.Valid(); err != nil {
		return false, ""
	}
	if !plane.Valid() {
		return false, ""
	}
	for _, r := range roles {
		// A tenant role can never satisfy an admin-plane check, or the reverse.
		if r.Plane != plane {
			continue
		}
		if r.Allows(want) {
			return true, r.Key
		}
	}
	return false, ""
}

// Flatten returns the sorted, de-duplicated permissions across roles in a
// plane — what the dashboard uses to decide which nav items to render.
func Flatten(roles []Role, plane Plane) []Permission {
	seen := map[Permission]bool{}
	for _, r := range roles {
		if r.Plane != plane {
			continue
		}
		for _, p := range r.Permissions {
			seen[p] = true
		}
	}
	out := make([]Permission, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
