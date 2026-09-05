package pricing

import "testing"

// Hungarian menu prices are gross: the customer sees 1270 HUF and 27% VAT is
// already inside it. HUF has no minor unit, so these are whole forint.
func TestPriceLine_TaxIncluded_HUF(t *testing.T) {
	got, err := PriceLine(Line{
		Quantity: 1, UnitPriceMinor: 1270, Currency: "HUF",
		TaxBasisPoints: 2700, TaxIncluded: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 1270 / 1.27 = 1000 exactly.
	if got.GrossMinor != 1270 || got.NetMinor != 1000 || got.TaxMinor != 270 {
		t.Fatalf("got %+v, want gross=1270 net=1000 tax=270", got)
	}
}

func TestPriceLine_TaxExcluded(t *testing.T) {
	got, err := PriceLine(Line{
		Quantity: 2, UnitPriceMinor: 500, Currency: "BDT",
		TaxBasisPoints: 1500, TaxIncluded: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	// net 1000, tax 15% = 150, gross 1150
	if got.NetMinor != 1000 || got.TaxMinor != 150 || got.GrossMinor != 1150 {
		t.Fatalf("got %+v, want net=1000 tax=150 gross=1150", got)
	}
}

// The rounding rule is the point of this test: truncation would return 236.
func TestPriceLine_RoundsHalfUp(t *testing.T) {
	got, err := PriceLine(Line{
		Quantity: 1, UnitPriceMinor: 999, Currency: "HUF",
		TaxBasisPoints: 2700, TaxIncluded: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 999 * 10000 / 12700 = 786.61… -> 787 net, so tax = 212.
	if got.NetMinor != 787 || got.TaxMinor != 212 {
		t.Fatalf("got net=%d tax=%d, want net=787 tax=212", got.NetMinor, got.TaxMinor)
	}
	if got.NetMinor+got.TaxMinor != got.GrossMinor {
		t.Fatalf("net+tax != gross: %+v", got)
	}
}

// Whatever the rounding, a line must always reconcile internally.
func TestPriceLine_NetPlusTaxAlwaysEqualsGross(t *testing.T) {
	for price := int64(1); price <= 3000; price++ {
		for _, rate := range []int32{0, 500, 1800, 2700} {
			a, err := PriceLine(Line{
				Quantity: 1, UnitPriceMinor: price, Currency: "HUF",
				TaxBasisPoints: rate, TaxIncluded: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			if a.NetMinor+a.TaxMinor != a.GrossMinor {
				t.Fatalf("price=%d rate=%d: net %d + tax %d != gross %d",
					price, rate, a.NetMinor, a.TaxMinor, a.GrossMinor)
			}
		}
	}
}

func TestPriceLine_Discount(t *testing.T) {
	got, err := PriceLine(Line{
		Quantity: 2, UnitPriceMinor: 1000, Currency: "HUF",
		TaxBasisPoints: 2700, TaxIncluded: true, DiscountMinor: 500,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.GrossMinor != 1500 {
		t.Fatalf("gross = %d, want 1500 (2000 less 500 discount)", got.GrossMinor)
	}
}

func TestPriceLine_Rejects(t *testing.T) {
	cases := map[string]Line{
		"zero quantity":    {Quantity: 0, UnitPriceMinor: 100, Currency: "HUF"},
		"unknown currency": {Quantity: 1, UnitPriceMinor: 100, Currency: "XYZ"},
		"discount > line":  {Quantity: 1, UnitPriceMinor: 100, Currency: "HUF", DiscountMinor: 500},
		"absurd tax rate":  {Quantity: 1, UnitPriceMinor: 100, Currency: "HUF", TaxBasisPoints: 200_000},
	}
	for name, l := range cases {
		if _, err := PriceLine(l); err == nil {
			t.Errorf("%s: expected an error, got none", name)
		}
	}
}

// Summing rounded lines is what makes a receipt add up. Deriving tax from the
// gross total instead can differ by a unit or two — enough to fail an audit.
func TestTotal_SumsRoundedLines(t *testing.T) {
	var as []Amounts
	for i := 0; i < 3; i++ {
		a, err := PriceLine(Line{
			Quantity: 1, UnitPriceMinor: 999, Currency: "HUF",
			TaxBasisPoints: 2700, TaxIncluded: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		as = append(as, a)
	}
	tot, err := Total(as)
	if err != nil {
		t.Fatal(err)
	}
	if tot.GrossMinor != 2997 || tot.NetMinor != 2361 || tot.TaxMinor != 636 {
		t.Fatalf("got %+v, want gross=2997 net=2361 tax=636", tot)
	}
	if tot.NetMinor+tot.TaxMinor != tot.GrossMinor {
		t.Fatalf("total does not reconcile: %+v", tot)
	}
}

func TestTotal_RejectsMixedCurrency(t *testing.T) {
	_, err := Total([]Amounts{{Currency: "HUF"}, {Currency: "BDT"}})
	if err == nil {
		t.Fatal("expected mixed-currency total to be rejected")
	}
}
