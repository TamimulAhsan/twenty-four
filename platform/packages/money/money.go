// Package money is the one place the platform knows what a currency is and how
// to round it. Every amount is an integer in the currency's minor units;
// nothing here ever sees a float.
//
// It lives in packages rather than inside Catalog because Payments, Invoicing
// and the ledger all need the same answers, and two currency tables is two
// answers to "does HUF have a subunit". The money rules are not guidance: an
// amount rounded one way on a receipt and another way in the books is a
// reconciliation problem that surfaces months later.
package money

import (
	"errors"
	"fmt"
)

// Exponent is how many decimal places a currency's minor unit represents.
// HUF is 0 — the fillér was withdrawn from circulation, so "minor units" for
// forint are just forint. Treating HUF as 2 would overstate every amount 100x.
var exponent = map[string]int{
	"HUF": 0,
	"BDT": 2,
	"EUR": 2,
	"USD": 2,
	"GBP": 2,
}

func Exponent(currency string) (int, bool) {
	e, ok := exponent[currency]
	return e, ok
}

var (
	ErrCurrency     = errors.New("money: unknown currency")
	ErrMismatch     = errors.New("money: currency mismatch")
	ErrQuantity     = errors.New("money: quantity must be positive")
	ErrTaxRate      = errors.New("money: tax rate out of range")
	ErrDiscountHigh = errors.New("money: discount exceeds line total")
)

// Line is one row of a sale, priced from a catalog item.
type Line struct {
	Quantity       int32
	UnitPriceMinor int64
	Currency       string
	TaxBasisPoints int32 // 2700 == 27%
	TaxIncluded    bool  // is UnitPriceMinor gross or net?
	DiscountMinor  int64 // applied to the line, before tax is derived
}

// Amounts are the derived figures for a line or a whole sale.
type Amounts struct {
	GrossMinor int64 // what the customer pays
	NetMinor   int64 // gross minus tax
	TaxMinor   int64
	Currency   string
}

// PriceLine computes one line's amounts.
//
// Rounding happens exactly once, at the line, on the tax figure. Rounding per
// line and then summing is what tax authorities expect and what a printed
// receipt has to add up to; deriving tax from an order total instead would
// produce receipts whose lines do not sum to the total.
func PriceLine(l Line) (Amounts, error) {
	if _, ok := exponent[l.Currency]; !ok {
		return Amounts{}, fmt.Errorf("%w: %q", ErrCurrency, l.Currency)
	}
	if l.Quantity <= 0 {
		return Amounts{}, ErrQuantity
	}
	if l.TaxBasisPoints < 0 || l.TaxBasisPoints > 100_000 {
		return Amounts{}, fmt.Errorf("%w: %d", ErrTaxRate, l.TaxBasisPoints)
	}
	if l.DiscountMinor < 0 {
		return Amounts{}, errors.New("money: discount must not be negative")
	}

	base := l.UnitPriceMinor * int64(l.Quantity)
	if l.DiscountMinor > base {
		return Amounts{}, fmt.Errorf("%w: discount %d on line of %d", ErrDiscountHigh, l.DiscountMinor, base)
	}
	subject := base - l.DiscountMinor
	rate := int64(l.TaxBasisPoints)

	var gross, net, tax int64
	if l.TaxIncluded {
		// The price already contains tax: net = gross * 10000 / (10000 + rate).
		gross = subject
		net = divRoundHalfUp(gross*10_000, 10_000+rate)
		tax = gross - net
	} else {
		net = subject
		tax = divRoundHalfUp(net*rate, 10_000)
		gross = net + tax
	}
	return Amounts{GrossMinor: gross, NetMinor: net, TaxMinor: tax, Currency: l.Currency}, nil
}

// Total sums already-priced lines. Summing rounded lines — rather than
// re-deriving tax from the gross total — is what keeps a receipt's lines
// adding up to its total.
func Total(as []Amounts) (Amounts, error) {
	if len(as) == 0 {
		return Amounts{}, errors.New("money: no lines to total")
	}
	out := Amounts{Currency: as[0].Currency}
	for _, a := range as {
		if a.Currency != out.Currency {
			return Amounts{}, fmt.Errorf("%w: %s and %s", ErrMismatch, out.Currency, a.Currency)
		}
		out.GrossMinor += a.GrossMinor
		out.NetMinor += a.NetMinor
		out.TaxMinor += a.TaxMinor
	}
	return out, nil
}

// divRoundHalfUp divides and rounds half away from zero, which is the rule
// most European tax regimes state. Go's integer division truncates toward
// zero, which would quietly under-collect tax on roughly half of all lines.
func divRoundHalfUp(num, den int64) int64 {
	if den == 0 {
		panic("money: division by zero")
	}
	neg := (num < 0) != (den < 0)
	if num < 0 {
		num = -num
	}
	if den < 0 {
		den = -den
	}
	q := (num + den/2) / den
	if neg {
		return -q
	}
	return q
}
