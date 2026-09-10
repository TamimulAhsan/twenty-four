// Package posting turns an operational event into a journal entry.
//
// This is where the ledger stops being a database and starts being
// bookkeeping, and the rules are deliberately in one readable file rather than
// scattered through handlers. An accountant should be able to read this and say
// whether the books are right, which is not a thing anybody can do with a set
// of switch statements spread across a service.
//
// Two rules hold throughout.
//
// Tax collected is a liability, not revenue. It is money held on behalf of the
// authority and the business never earned it. This is the single most common
// thing to get wrong, and it is wrong in a way that overstates income until
// somebody files a return.
//
// Every entry balances. Not by assertion afterwards but by construction: each
// rule below writes the other side of what it writes, and the store refuses
// anything whose lines do not sum to zero.
package posting

import (
	"encoding/json"
	"fmt"
)

// Money as it arrives on the bus: minor units and a code, never a float.
type Money struct {
	Minor    int64  `json:"minor"`
	Currency string `json:"currency"`
}

// Line is one side of an entry. A signed debit: positive is a debit, negative
// is a credit, and an entry balances when its lines sum to zero.
type Line struct {
	Account string
	Minor   int64
	Memo    string
}

// Entry is what an event becomes.
type Entry struct {
	Kind          string
	ReferenceType string
	ReferenceID   string
	Memo          string
	Currency      string
	Lines         []Line
}

// Balanced reports whether the lines sum to zero, which is the definition of a
// valid double entry.
func (e Entry) Balanced() bool {
	var sum int64
	for _, l := range e.Lines {
		sum += l.Minor
	}
	return sum == 0
}

// ErrNotBookkeepable says this event does not belong in the books. It is not a
// failure: most of what crosses the bus is operational, and a ledger that
// booked every event would be a ledger of everything that ever happened.
var ErrNotBookkeepable = fmt.Errorf("posting: nothing to book")

// Describe turns an event into an entry, or says there is nothing to book.
func Describe(topic string, payload []byte) (Entry, error) {
	switch topic {
	case "order.placed":
		return sale(payload)
	case "order.voided":
		return voided(payload)
	case "payment.refunded":
		return refund(payload)
	}
	return Entry{}, ErrNotBookkeepable
}

// Which account money taken by a given method lands in.
//
// Cash is in the drawer. Anything electronic is money the business has and has
// not received, which is what a clearing account is for: booking a card sale
// straight to the bank says the money is there on a day it is not, and the
// business reconciles against a statement that disagrees.
func settlementAccount(method string) string {
	switch method {
	case "cash":
		return "cash"
	case "transfer":
		return "bank"
	default:
		return "card_clearing"
	}
}

func sale(payload []byte) (Entry, error) {
	var p struct {
		OrderID string `json:"order_id"`
		Number  string `json:"number"`
		Status  string `json:"status"`
		Gross   Money  `json:"gross"`
		Net     Money  `json:"net"`
		Tax     Money  `json:"tax"`
		Tenders []struct {
			Method string `json:"method"`
			Amount Money  `json:"amount"`
		} `json:"tenders"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return Entry{}, fmt.Errorf("posting: decode sale: %w", err)
	}
	// A parked sale is not a sale. Nothing has been sold and nothing has been
	// taken, so there is nothing to book until it settles.
	if p.Status == "open" || p.Gross.Minor == 0 {
		return Entry{}, ErrNotBookkeepable
	}

	e := Entry{
		Kind: "sale", ReferenceType: "order", ReferenceID: p.OrderID,
		Memo: "Sale " + p.Number, Currency: p.Gross.Currency,
	}
	// What was taken, by method, so the drawer and the processor are separate
	// numbers.
	var taken int64
	for _, t := range p.Tenders {
		if t.Amount.Minor == 0 {
			continue
		}
		e.Lines = append(e.Lines, Line{
			Account: settlementAccount(t.Method), Minor: t.Amount.Minor,
			Memo: t.Method,
		})
		taken += t.Amount.Minor
	}
	// A sale rung up on account, with nothing tendered, is owed by the
	// customer rather than an unbalanced entry.
	if taken < p.Gross.Minor {
		e.Lines = append(e.Lines, Line{
			Account: "receivables", Minor: p.Gross.Minor - taken, Memo: "on account",
		})
	}

	// Revenue is net of tax. The tax is money held for the authority and the
	// business never earned it: booking gross to revenue overstates income by
	// exactly the tax until somebody files a return and wonders where it went.
	net := p.Net.Minor
	tax := p.Tax.Minor
	if net == 0 && tax == 0 {
		net = p.Gross.Minor
	}
	// Credits, so negative. Money coming in is a debit to an asset; the revenue
	// and the tax it corresponds to are the credits that balance it.
	e.Lines = append(e.Lines, Line{Account: "sales_revenue", Minor: -net})
	if tax != 0 {
		e.Lines = append(e.Lines, Line{Account: "tax_payable", Minor: -tax, Memo: "tax on sale"})
	}
	return e, nil
}

func voided(payload []byte) (Entry, error) {
	var p struct {
		OrderID string `json:"order_id"`
		Number  string `json:"number"`
		Gross   Money  `json:"gross"`
		Net     Money  `json:"net"`
		Tax     Money  `json:"tax"`
		Tenders []struct {
			Method string `json:"method"`
			Amount Money  `json:"amount"`
		} `json:"tenders"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return Entry{}, fmt.Errorf("posting: decode void: %w", err)
	}
	if p.Gross.Minor == 0 {
		return Entry{}, ErrNotBookkeepable
	}
	// A void is the sale backwards, and it is booked as its own entry rather
	// than by removing the original. The original happened: a receipt was
	// printed and somebody has it.
	sale, err := sale(payload)
	if err != nil {
		return Entry{}, err
	}
	out := Entry{
		Kind: "void", ReferenceType: "order", ReferenceID: p.OrderID,
		Memo: "Void of sale " + p.Number, Currency: sale.Currency,
	}
	for _, l := range sale.Lines {
		out.Lines = append(out.Lines, Line{Account: l.Account, Minor: -l.Minor, Memo: l.Memo})
	}
	return out, nil
}

func refund(payload []byte) (Entry, error) {
	var p struct {
		PaymentID     string `json:"payment_id"`
		RefundID      string `json:"refund_id"`
		Amount        Money  `json:"amount"`
		MethodKey     string `json:"method_key"`
		Reason        string `json:"reason"`
		ReferenceType string `json:"reference_type"`
		ReferenceID   string `json:"reference_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return Entry{}, fmt.Errorf("posting: decode refund: %w", err)
	}
	if p.Amount.Minor == 0 {
		return Entry{}, ErrNotBookkeepable
	}
	memo := "Refund"
	if p.Reason != "" {
		memo += ": " + p.Reason
	}
	// Refunds go to their own account rather than reducing sales, so a month
	// with heavy returns is legible instead of merely smaller. It is a revenue
	// account carrying a debit balance, which is exactly what a contra account
	// is: the debit here is the sign that says so.
	//
	// The tax is deliberately not unwound here. The refund event carries a
	// gross amount and no tax breakdown, and guessing at the split would put a
	// wrong number in a tax liability account. It is left as a known gap rather
	// than an invented figure: the payment event is the wrong place to learn
	// what tax was on the original line.
	return Entry{
		Kind: "refund", ReferenceType: "payment", ReferenceID: p.PaymentID,
		Memo: memo, Currency: p.Amount.Currency,
		Lines: []Line{
			{Account: "sales_refunds", Minor: p.Amount.Minor, Memo: p.RefundID},
			{Account: settlementAccount(p.MethodKey), Minor: -p.Amount.Minor},
		},
	}, nil
}
