package main

import (
	"testing"

	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
)

func roles(keys ...string) []*rbacpb.Role {
	out := make([]*rbacpb.Role, 0, len(keys))
	for _, k := range keys {
		out = append(out, &rbacpb.Role{Key: k})
	}
	return out
}

// Someone holding two roles is shown as the more capable of them. Showing the
// narrower one would misrepresent what they can do, which matters most on the
// screen where a colleague decides whether to change it.
func TestMostCapableRoleWins(t *testing.T) {
	for _, tc := range []struct {
		name string
		have []string
		want string
	}{
		{"owner and staff", []string{"staff", "owner"}, "owner"},
		{"manager and accountant", []string{"accountant", "manager"}, "manager"},
		{"one role", []string{"staff"}, "staff"},
		{"order does not matter", []string{"owner", "manager"}, "owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := mostCapableRole(roles(tc.have...)); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// A custom role must never outrank owner by accident, and two custom roles must
// resolve the same way every time rather than by map iteration order.
func TestCustomRolesDoNotOutrankTheKnownOnes(t *testing.T) {
	if got := mostCapableRole(roles("night-manager", "owner")); got != "owner" {
		t.Fatalf("a custom role outranked owner: %q", got)
	}
	first := mostCapableRole(roles("zebra", "aardvark"))
	for i := 0; i < 50; i++ {
		if got := mostCapableRole(roles("aardvark", "zebra")); got != first {
			t.Fatalf("unstable: %q then %q", first, got)
		}
	}
}

func TestNoRolesIsEmpty(t *testing.T) {
	if got := mostCapableRole(nil); got != "" {
		t.Fatalf("invented a role: %q", got)
	}
}

// The seat rule, stated once. An invitation holds a seat because the person
// will accept; a seat that frees up while someone is slow to read their email
// is a seat that gets sold twice.
func TestWhoHoldsASeat(t *testing.T) {
	for status, want := range map[string]bool{
		"active":      true,
		"invited":     true,
		"locked":      true,
		"deactivated": false,
	} {
		if got := holdsSeat(status); got != want {
			t.Fatalf("%s: holdsSeat = %v, want %v", status, got, want)
		}
	}
}
