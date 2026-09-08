// Package templates is what a trade starts with: a catalog worth looking at,
// and a floor for the venues that have one.
//
// Every figure here is a starting point the merchant is told to check, which is
// why "Check your prices" is on the checklist as their step. An empty catalog
// is technically correct and practically useless: a merchant who has to type
// forty items before anything works will not reach the end of their first
// morning.
//
// Trade-neutral by construction. Nothing in this package is referenced by any
// service; it is content, and adding trade 44 is an entry in a map.
package templates

type Category struct {
	Name     string
	Position int32
}

type Item struct {
	SKU             string
	Name            string
	Category        string
	PriceMinor      int64
	TaxBasisPoints  int32
	TrackStock      bool
	Service         bool
	DurationMinutes int32
}

type Seed struct {
	Categories []Category
	Items      []Item
}

type Table struct {
	Label string
	Seats int32
	Area  string
}

// Prices are in this market's minor units. HUF has no subunit in circulation,
// so 650 is six hundred and fifty forint, not six forint fifty.
const (
	standard = 2700
	reduced  = 500
)

func product(sku, name, cat string, price int64, tax int32) Item {
	return Item{SKU: sku, Name: name, Category: cat, PriceMinor: price,
		TaxBasisPoints: tax, TrackStock: true}
}

func service(sku, name, cat string, price int64, minutes int32) Item {
	return Item{SKU: sku, Name: name, Category: cat, PriceMinor: price,
		TaxBasisPoints: standard, Service: true, DurationMinutes: minutes}
}

// catalogs is keyed by term family rather than by trade, because a bakery and a
// pizzeria want the same shape of starting point and forty-three near-identical
// tables would rot. A trade with genuinely different needs gets its own entry.
var catalogs = map[string]Seed{
	"food_service": {
		Categories: []Category{{Name: "Coffee", Position: 1}, {Name: "Food", Position: 2}, {Name: "Drinks", Position: 3}},
		Items: []Item{
			product("ESP", "Espresso", "Coffee", 650, standard),
			product("CAP", "Cappuccino", "Coffee", 890, standard),
			product("LAT", "Latte", "Coffee", 950, standard),
			product("TEA", "Tea", "Coffee", 690, standard),
			product("SNW", "Sandwich", "Food", 1890, reduced),
			product("SAL", "Salad", "Food", 2190, reduced),
			product("CKE", "Cake slice", "Food", 1290, reduced),
			product("WTR", "Still water", "Drinks", 490, standard),
			product("JCE", "Orange juice", "Drinks", 790, standard),
		},
	},
	"salon": {
		Categories: []Category{{Name: "Cutting", Position: 1}, {Name: "Colour", Position: 2}, {Name: "Treatments", Position: 3}},
		Items: []Item{
			service("CUT", "Cut and finish", "Cutting", 8500, 45),
			service("DRY", "Blow dry", "Cutting", 5500, 30),
			service("BRD", "Beard trim", "Cutting", 3500, 20),
			service("COL", "Full colour", "Colour", 18000, 120),
			service("HLT", "Highlights", "Colour", 22000, 150),
			service("TRT", "Conditioning treatment", "Treatments", 6500, 30),
		},
	},
	"retail": {
		Categories: []Category{{Name: "New in", Position: 1}, {Name: "Everyday", Position: 2}, {Name: "Sale", Position: 3}},
		Items: []Item{
			product("A001", "Sample product A", "New in", 4900, standard),
			product("A002", "Sample product B", "New in", 7900, standard),
			product("B001", "Sample product C", "Everyday", 2490, standard),
			product("B002", "Sample product D", "Everyday", 1290, standard),
		},
	},
	"accommodation": {
		Categories: []Category{{Name: "Rooms", Position: 1}, {Name: "Extras", Position: 2}},
		Items: []Item{
			service("STD", "Standard room", "Rooms", 32000, 0),
			service("DBL", "Double room", "Rooms", 45000, 0),
			service("STE", "Suite", "Rooms", 78000, 0),
			product("BRK", "Breakfast", "Extras", 4500, reduced),
			product("PRK", "Parking", "Extras", 3000, standard),
		},
	},
	"trades": {
		Categories: []Category{{Name: "Call-outs", Position: 1}, {Name: "Labour", Position: 2}, {Name: "Parts", Position: 3}},
		Items: []Item{
			service("CALL", "Call-out", "Call-outs", 12000, 60),
			service("HOUR", "Hourly labour", "Labour", 9000, 60),
			service("EMRG", "Emergency call-out", "Call-outs", 25000, 60),
			product("PART", "Parts and materials", "Parts", 0, standard),
		},
	},
}

// families maps a trade to the starting point it shares. Kept beside the
// catalogs rather than read from the Tenant service, because this package is
// content and a network call to look up a constant is not an improvement.
var families = map[string]string{}

func init() {
	for _, group := range []struct {
		family string
		trades []string
	}{
		{"food_service", []string{"restaurant", "cafe", "bakery", "pizzeria", "bar_pub", "food_truck", "catering", "ice_cream"}},
		{"salon", []string{"hair_salon", "barbershop", "nail_salon", "beauty_salon", "spa", "massage",
			"tattoo_studio", "barber_academy", "gym", "yoga_studio", "dental_clinic", "veterinary", "physiotherapy"}},
		{"retail", []string{"clothing", "grocery", "convenience", "bookshop", "florist", "pharmacy",
			"electronics", "pet_shop", "gift_shop", "jewellery", "sports_shop", "hardware"}},
		{"accommodation", []string{"hotel", "guesthouse", "hostel", "apartment_rental"}},
		{"trades", []string{"plumber", "electrician", "cleaning", "garage", "landscaping", "photographer"}},
	} {
		for _, trade := range group.trades {
			families[trade] = group.family
		}
	}
}

// Catalog returns the starting point for a trade. An unknown trade gets
// nothing rather than somebody else's menu, which is the honest answer: a
// merchant with an empty catalog knows to fill it, and a merchant with the
// wrong one may not notice.
func Catalog(trade string) Seed {
	if family, ok := families[trade]; ok {
		return catalogs[family]
	}
	return Seed{}
}

// Floor is the starting layout for a venue where people sit down. Only reached
// when the industry profile switched on table management.
func Floor(trade string) []Table {
	if families[trade] != "food_service" {
		return nil
	}
	out := make([]Table, 0, 12)
	for i := 1; i <= 8; i++ {
		out = append(out, Table{Label: itoa(i), Seats: 4, Area: "Inside"})
	}
	for i := 9; i <= 12; i++ {
		out = append(out, Table{Label: itoa(i), Seats: 2, Area: "Terrace"})
	}
	return out
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}
