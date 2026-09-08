package registry

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The registry exists twice: here, and in services/web/packages/entitlement,
// which the dashboard renders its navigation from. Two copies of a catalog is a
// real risk, so these tests read the TypeScript and assert the Go agrees.
//
// A change made on one side and not the other fails here rather than drifting
// quietly into a merchant seeing a module in their sidebar that the gateway
// then refuses.
const tsRoot = "../../../web/packages/entitlement/src/"

func readTS(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(tsRoot + name)
	if err != nil {
		t.Skipf("the frontend entitlement package is not here: %v", err)
	}
	return string(b)
}

func TestModuleIDsMatchTheFrontend(t *testing.T) {
	src := readTS(t, "modules.ts")
	block := regexp.MustCompile(`(?s)MODULE_IDS = \[(.*?)\] as const`).FindStringSubmatch(src)
	if block == nil {
		t.Fatal("could not find MODULE_IDS")
	}
	var want []string
	for _, m := range regexp.MustCompile(`'([\w_]+)'`).FindAllStringSubmatch(block[1], -1) {
		want = append(want, m[1])
	}
	sort.Strings(want)

	got := make([]string, 0, len(Modules))
	for id := range Modules {
		got = append(got, id)
	}
	sort.Strings(got)

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("modules drifted.\n go: %v\n ts: %v", got, want)
	}
}

func TestTierGrantsMatchTheFrontend(t *testing.T) {
	src := readTS(t, "tiers.ts")
	for id, tier := range Tiers {
		block := regexp.MustCompile(`(?s)\n  ` + id + `: \{(.*?)\n  \},`).FindStringSubmatch(src)
		if block == nil {
			t.Fatalf("%s is not in the frontend tiers", id)
		}
		grants := regexp.MustCompile(`(?s)grants: \[(.*?)\]`).FindStringSubmatch(block[1])
		if grants == nil {
			t.Fatalf("%s has no grants in the frontend", id)
		}
		var want []string
		for _, m := range regexp.MustCompile(`'([\w_]+)'`).FindAllStringSubmatch(grants[1], -1) {
			want = append(want, m[1])
		}
		sort.Strings(want)
		got := append([]string(nil), tier.Grants...)
		sort.Strings(got)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s grants drifted.\n go: %v\n ts: %v", id, got, want)
		}
	}
}

func TestIndustryProfilesMatchTheFrontend(t *testing.T) {
	src := readTS(t, "profiles.ts")
	found := regexp.MustCompile(`profile\('([\w-]+)'`).FindAllStringSubmatch(src, -1)
	if len(found) == 0 {
		t.Fatal("could not find any profiles")
	}
	if len(found) != len(Profiles) {
		t.Fatalf("the frontend has %d industry profiles, this has %d", len(found), len(Profiles))
	}
	for _, m := range found {
		if _, ok := ProfileOf(m[1]); !ok {
			t.Fatalf("%s is in the selector but not here, so signing up as one would fail", m[1])
		}
	}
}

// The whole reason the registry owns the dependency graph: a tier says "POS",
// and POS deciding it needs Inventory is POS's business, not the price list's.
func TestStarterResolvesToWhatItActuallyNeeds(t *testing.T) {
	got := Resolve(Tiers["starter"].Grants)
	for _, want := range []string{
		"pos_orders", "bookings", "payments", // sold
		"catalog", "inventory", "staff_rota", // pulled in
		"identity_tenancy", "notifications", "audit_documents", // always on
	} {
		if !contains(got, want) {
			t.Fatalf("Starter did not resolve to include %s: %v", want, got)
		}
	}
	// Not sold at this tier and not required by anything in it.
	for _, unwanted := range []string{"crm", "ai_creative", "marketing_ads", "website_storefront"} {
		if contains(got, unwanted) {
			t.Fatalf("Starter included %s, which it does not grant: %v", unwanted, got)
		}
	}
}

func TestResolveIsTransitive(t *testing.T) {
	// ai_creative requires marketing_ads requires advanced_analytics. A single
	// level of resolution would grant a module that cannot work.
	got := Resolve([]string{"ai_creative"})
	for _, want := range []string{"ai_creative", "marketing_ads", "advanced_analytics"} {
		if !contains(got, want) {
			t.Fatalf("resolving ai_creative missed %s: %v", want, got)
		}
	}
}

func TestEveryTierIsResolvableAndOrdered(t *testing.T) {
	for id, tier := range Tiers {
		got := Resolve(tier.Grants)
		if !sort.StringsAreSorted(got) {
			t.Fatalf("%s did not resolve to a stable order: %v", id, got)
		}
		for _, m := range got {
			if _, ok := Modules[m]; !ok {
				t.Fatalf("%s resolved to %q, which is not a module", id, m)
			}
		}
	}
	// Max and Enterprise grant the same set. Enterprise differs by overrides
	// recorded against the tenant, not by a different list here.
	if strings.Join(Resolve(Tiers["max"].Grants), ",") != strings.Join(Resolve(Tiers["enterprise"].Grants), ",") {
		t.Fatal("Enterprise is meant to be everything in Max")
	}
}

// Payments needs KYC and marketing needs OAuth consent, so a self-serve signup
// on any tier has something a specialist must finish. Losing this flag would
// mean telling a merchant they are live when they cannot take money.
func TestSelfServeSignupAlwaysQueuesPayments(t *testing.T) {
	for id, tier := range Tiers {
		pending := NeedsSpecialist(Resolve(tier.Grants))
		if !contains(pending, "payments") {
			t.Fatalf("%s did not queue payments for a specialist: %v", id, pending)
		}
	}
	if got := NeedsSpecialist(Resolve(Tiers["growth"].Grants)); !contains(got, "marketing_ads") {
		t.Fatalf("Growth did not queue marketing_ads: %v", got)
	}
}

func TestProfilesCarryOnlyImplementedCapabilities(t *testing.T) {
	for _, p := range Profiles {
		for _, c := range CapabilitiesOf(p.ID) {
			if !ImplementedCapabilities[c] {
				t.Fatalf("%s grants %q, which this build does not ship", p.ID, c)
			}
		}
	}
	// A restaurant gets prep screens and a floor; a bookshop gets neither, and
	// that is the trade-neutrality rule working.
	if got := CapabilitiesOf("restaurant"); len(got) != 2 {
		t.Fatalf("a restaurant should get both capabilities, got %v", got)
	}
	if got := CapabilitiesOf("bookshop"); len(got) != 0 {
		t.Fatalf("a bookshop should get no trade capabilities, got %v", got)
	}
	if got := CapabilitiesOf("ice_cream"); len(got) != 0 {
		t.Fatalf("an ice cream shop has no kitchen, got %v", got)
	}
}

func TestUnknownIdentifiersAreRefusedRatherThanInvented(t *testing.T) {
	if _, ok := TierOf("platinum"); ok {
		t.Fatal("invented a tier")
	}
	if _, ok := ProfileOf("submarine"); ok {
		t.Fatal("invented an industry")
	}
	if got := Resolve([]string{"not_a_module"}); len(got) != len(AlwaysOn()) {
		t.Fatalf("an unknown module was granted: %v", got)
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
