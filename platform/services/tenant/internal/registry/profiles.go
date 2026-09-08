package registry

// The business type selector.
//
// One input decides everything trade-specific. A specialist records it at
// intake; a self-serve merchant picks it from the form. It resolves to a
// profile carrying four things: trade capabilities, a term set, a catalog
// template, and document and tax categories.
//
// Adding trade 44 is an entry here plus a term set. No release, no new service,
// no code path. That is the point of the table.
type Profile struct {
	ID   string
	Name string
	// Which vocabulary this trade speaks: a hotel calls a catalog item a Room,
	// a spa a Service, a restaurant a Dish. Same concept, same tables, same
	// API, different word on screen.
	TermFamily string
	// Trade capabilities. Nobody chooses these: the profile switches them on
	// and they never appear in a picker. A candy shop buying POS gets a till;
	// a restaurant buying the same POS gets a till and prep screens.
	Capabilities []string
	// Seeds the catalog at provisioning.
	CatalogTemplate string
}

// Capabilities this build actually ships. A profile may name one that does not
// exist yet; provisioning filters to these rather than granting something with
// nothing behind it.
var ImplementedCapabilities = map[string]bool{
	"kitchen_display":  true,
	"table_management": true,
}

var Profiles = []Profile{
	{ID: "restaurant", Name: "Restaurant", TermFamily: "food_service", CatalogTemplate: "restaurant", Capabilities: []string{"kitchen_display", "table_management"}},
	{ID: "cafe", Name: "Cafe or coffee shop", TermFamily: "food_service", CatalogTemplate: "cafe", Capabilities: []string{"kitchen_display", "table_management"}},
	{ID: "bakery", Name: "Bakery", TermFamily: "food_service", CatalogTemplate: "bakery", Capabilities: []string{"kitchen_display"}},
	{ID: "pizzeria", Name: "Pizzeria", TermFamily: "food_service", CatalogTemplate: "pizzeria", Capabilities: []string{"kitchen_display", "table_management"}},
	{ID: "bar_pub", Name: "Bar or pub", TermFamily: "food_service", CatalogTemplate: "bar_pub", Capabilities: []string{"kitchen_display", "table_management"}},
	{ID: "food_truck", Name: "Food truck", TermFamily: "food_service", CatalogTemplate: "food_truck", Capabilities: []string{"kitchen_display"}},
	{ID: "catering", Name: "Catering", TermFamily: "food_service", CatalogTemplate: "catering", Capabilities: []string{"kitchen_display"}},
	{ID: "ice_cream", Name: "Ice cream or dessert shop", TermFamily: "food_service", CatalogTemplate: "ice_cream"},

	{ID: "hair_salon", Name: "Hair salon", TermFamily: "salon", CatalogTemplate: "hair_salon"},
	{ID: "barbershop", Name: "Barbershop", TermFamily: "salon", CatalogTemplate: "barbershop"},
	{ID: "nail_salon", Name: "Nail salon", TermFamily: "salon", CatalogTemplate: "nail_salon"},
	{ID: "beauty_salon", Name: "Beauty salon", TermFamily: "salon", CatalogTemplate: "beauty_salon"},
	{ID: "spa", Name: "Spa", TermFamily: "salon", CatalogTemplate: "spa"},
	{ID: "massage", Name: "Massage therapy", TermFamily: "salon", CatalogTemplate: "massage"},
	{ID: "tattoo_studio", Name: "Tattoo or piercing studio", TermFamily: "salon", CatalogTemplate: "tattoo_studio"},
	{ID: "barber_academy", Name: "Training academy", TermFamily: "salon", CatalogTemplate: "barber_academy"},

	{ID: "clothing", Name: "Clothing and fashion", TermFamily: "retail", CatalogTemplate: "clothing"},
	{ID: "grocery", Name: "Grocery", TermFamily: "retail", CatalogTemplate: "grocery"},
	{ID: "convenience", Name: "Convenience store", TermFamily: "retail", CatalogTemplate: "convenience"},
	{ID: "bookshop", Name: "Bookshop", TermFamily: "retail", CatalogTemplate: "bookshop"},
	{ID: "florist", Name: "Florist", TermFamily: "retail", CatalogTemplate: "florist"},
	{ID: "pharmacy", Name: "Pharmacy", TermFamily: "retail", CatalogTemplate: "pharmacy"},
	{ID: "electronics", Name: "Electronics", TermFamily: "retail", CatalogTemplate: "electronics"},
	{ID: "pet_shop", Name: "Pet shop", TermFamily: "retail", CatalogTemplate: "pet_shop"},
	{ID: "gift_shop", Name: "Gift shop", TermFamily: "retail", CatalogTemplate: "gift_shop"},
	{ID: "jewellery", Name: "Jewellery", TermFamily: "retail", CatalogTemplate: "jewellery"},
	{ID: "sports_shop", Name: "Sports and outdoor", TermFamily: "retail", CatalogTemplate: "sports_shop"},
	{ID: "hardware", Name: "Hardware and DIY", TermFamily: "retail", CatalogTemplate: "hardware"},

	{ID: "hotel", Name: "Hotel", TermFamily: "accommodation", CatalogTemplate: "hotel"},
	{ID: "guesthouse", Name: "Guesthouse or B&B", TermFamily: "accommodation", CatalogTemplate: "guesthouse"},
	{ID: "hostel", Name: "Hostel", TermFamily: "accommodation", CatalogTemplate: "hostel"},
	{ID: "apartment_rental", Name: "Short-stay apartments", TermFamily: "accommodation", CatalogTemplate: "apartment_rental"},

	{ID: "plumber", Name: "Plumbing", TermFamily: "trades", CatalogTemplate: "plumber"},
	{ID: "electrician", Name: "Electrical", TermFamily: "trades", CatalogTemplate: "electrician"},
	{ID: "cleaning", Name: "Cleaning services", TermFamily: "trades", CatalogTemplate: "cleaning"},
	{ID: "garage", Name: "Garage and auto repair", TermFamily: "trades", CatalogTemplate: "garage"},
	{ID: "landscaping", Name: "Landscaping and garden", TermFamily: "trades", CatalogTemplate: "landscaping"},
	{ID: "photographer", Name: "Photography", TermFamily: "trades", CatalogTemplate: "photographer"},

	{ID: "gym", Name: "Gym or fitness studio", TermFamily: "salon", CatalogTemplate: "gym"},
	{ID: "yoga_studio", Name: "Yoga or pilates studio", TermFamily: "salon", CatalogTemplate: "yoga_studio"},
	{ID: "dental_clinic", Name: "Dental clinic", TermFamily: "salon", CatalogTemplate: "dental_clinic"},
	{ID: "veterinary", Name: "Veterinary clinic", TermFamily: "salon", CatalogTemplate: "veterinary"},
	{ID: "physiotherapy", Name: "Physiotherapy", TermFamily: "salon", CatalogTemplate: "physiotherapy"},
}

var profileByID = func() map[string]Profile {
	out := make(map[string]Profile, len(Profiles))
	for _, p := range Profiles {
		out[p.ID] = p
	}
	return out
}()

func ProfileOf(id string) (Profile, bool) {
	p, ok := profileByID[id]
	return p, ok
}

// CapabilitiesOf is what the industry profile contributes to the entitlement
// record, filtered to what this build ships.
func CapabilitiesOf(id string) []string {
	p, ok := profileByID[id]
	if !ok {
		return nil
	}
	var out []string
	for _, c := range p.Capabilities {
		if ImplementedCapabilities[c] {
			out = append(out, c)
		}
	}
	return out
}
