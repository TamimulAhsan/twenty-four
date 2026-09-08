// Package saga is the provisioning plan: which steps exist, in what order, who
// owns each one, and which hour of the promise it belongs to.
//
// The plan is built per tenant rather than fixed, because what has to happen
// depends on what they bought and what trade they are in. A bookshop has no
// floor to lay out; a merchant on Starter has no ad accounts to connect.
package saga

// Owner is who has to act.
type Owner string

const (
	// Runs itself. The merchant watches it happen.
	Platform Owner = "platform"
	// Needs a TwentyFour specialist: KYC, hardware, training.
	Specialist Owner = "specialist"
	// Needs the merchant. Nothing else moves it.
	Merchant Owner = "merchant"
)

type Step struct {
	ID          string
	Title       string
	Description string
	// 0, 4, 12 or 24: which stage of the promise this belongs to.
	Hour  int32
	Owner Owner
}

// Input is what the plan is built from.
type Input struct {
	Industry string
	Tier     string
	// The resolved module set, so the plan mentions what the tenant is
	// actually getting rather than a guess.
	Modules []string
	// Trade capabilities from the industry profile.
	Capabilities []string
	// Modules whose provisioning cannot complete unattended.
	NeedsSpecialist []string
}

func has(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// Plan builds the checklist for one tenant.
//
// The hours are the promise, not a schedule: HOUR 0 is what happens while the
// merchant is still on the page, HOUR 24 is the last thing that has to be true
// before the business is live. Steps are ordered so a merchant reading top to
// bottom sees them in the order they will happen.
func Plan(in Input) []Step {
	steps := []Step{
		{
			ID: "account", Hour: 0, Owner: Platform,
			Title:       "Account created",
			Description: "Your login, your business, and the code that goes on every document you issue.",
		},
		{
			ID: "entitlement", Hour: 0, Owner: Platform,
			Title:       "Plan applied",
			Description: "Switching on what your plan includes, and everything those parts need to work.",
		},
		{
			ID: "profile", Hour: 0, Owner: Platform,
			Title:       "Business set up",
			Description: "Tax rates, opening hours and the words your trade uses.",
		},
		{
			ID: "catalog", Hour: 4, Owner: Platform,
			Title:       "Starting catalog",
			Description: "A starting point for what you sell, built from your trade. Yours to change.",
		},
	}

	// Only a venue where people sit down. A bookshop has no floor, and a step
	// that says "none needed" is worse than no step at all.
	if has(in.Capabilities, "table_management") {
		steps = append(steps, Step{
			ID: "floor", Hour: 4, Owner: Platform,
			Title:       "Floor plan",
			Description: "Your tables, ready to open tabs on. Rename and rearrange them any time.",
		})
	}

	// The one that genuinely takes calendar time. KYC and connected-account
	// onboarding cannot be shortened by engineering, so it is on the checklist
	// from the first minute rather than being a surprise on day two.
	if has(in.NeedsSpecialist, "payments") {
		steps = append(steps, Step{
			ID: "payments_kyc", Hour: 12, Owner: Specialist,
			Title:       "Taking payments",
			Description: "We verify your business with the payment provider. We will come back to you for anything they need.",
		})
	}
	if has(in.NeedsSpecialist, "marketing_ads") {
		steps = append(steps, Step{
			ID: "ad_accounts", Hour: 12, Owner: Specialist,
			Title:       "Ad accounts connected",
			Description: "Linking Meta, Google and TikTok. You will be asked to approve the connection.",
		})
	}

	steps = append(steps, Step{
		ID: "review_catalog", Hour: 12, Owner: Merchant,
		Title:       "Check your prices",
		Description: "We guessed a starting catalog from your trade. Nothing goes out at the wrong price if you look now.",
	})

	if has(in.Modules, "staff_rota") {
		steps = append(steps, Step{
			ID: "invite_team", Hour: 24, Owner: Merchant,
			Title:       "Invite your team",
			Description: "Everyone who serves, books or counts up needs their own login.",
		})
	}

	steps = append(steps, Step{
		ID: "first_sale", Hour: 24, Owner: Merchant,
		Title:       "Ring one through",
		Description: "One real sale proves the till, the stock count and the receipt all work together.",
	})
	return steps
}
