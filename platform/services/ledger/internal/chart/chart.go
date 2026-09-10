// Package chart is the accounts the platform posts to on its own.
//
// Codes are semantic, not numbers. A numbered chart of accounts is a market
// convention, and the rule this codebase holds hardest is that market variation
// is deployment rather than code: the Hungarian ledger and the Bangladeshi one
// run the same accounts, and whichever numbering an accountant needs is applied
// when the books are exported.
//
// Which side increases an account is derived from its kind rather than stored
// beside it, for the same reason the debit and credit columns of a report are
// derived from the sign: two places to record the same fact is one place for
// them to disagree, and in a ledger that disagreement is a set of books nobody
// can trust.
package chart

// Kind is one of the five.
type Kind string

const (
	Asset     Kind = "asset"
	Liability Kind = "liability"
	Equity    Kind = "equity"
	Revenue   Kind = "revenue"
	Expense   Kind = "expense"
)

// Account is one line of the chart.
type Account struct {
	Code string
	Name string
	Kind Kind
}

// DebitPositive reports whether an increase in this kind of account is a debit.
//
// Assets and expenses increase on the debit side; liabilities, equity and
// revenue increase on the credit side. This is the whole of double-entry's
// sign convention and it is written down once.
func (k Kind) DebitPositive() bool {
	return k == Asset || k == Expense
}

// The accounts the posting rules refer to by code. A tenant may add its own and
// may not remove these, because a rule naming an account that has gone would
// fail at the moment a sale is being booked.
var builtin = []Account{
	// What the business holds.
	{"cash", "Cash on hand", Asset},
	// Money taken by card that the processor has not settled yet. It is the
	// business's money and it is not in the bank, which is exactly what a
	// clearing account is for, and the reason a card sale is not a debit to
	// cash.
	{"card_clearing", "Card settlements not yet received", Asset},
	{"bank", "Bank account", Asset},
	{"inventory", "Stock on hand", Asset},
	{"receivables", "Owed by customers", Asset},

	// What the business owes.
	{"payables", "Owed to suppliers", Liability},
	// Tax collected on the business's sales, held on behalf of the authority.
	// A liability rather than revenue, which is the single most common thing to
	// get wrong: VAT collected is not money the business earned.
	{"tax_payable", "Tax collected, not yet paid over", Liability},
	// Money taken for something not yet delivered: a deposit on a booking. It
	// becomes revenue when the thing happens, not when the money arrives.
	{"deferred_revenue", "Taken in advance", Liability},
	{"gift_liability", "Gift cards and credit outstanding", Liability},

	{"owner_equity", "Owner's capital", Equity},
	{"retained_earnings", "Retained earnings", Equity},

	{"sales_revenue", "Sales", Revenue},
	// Refunds as their own account rather than negative sales, so a month with
	// heavy returns is legible instead of merely smaller.
	{"sales_refunds", "Refunds", Revenue},
	{"discounts_given", "Discounts", Revenue},

	{"cost_of_sales", "Cost of goods sold", Expense},
	// What a processor keeps. An expense, and not netted off revenue, because a
	// business needs to see what card acceptance costs it.
	{"payment_fees", "Payment processing fees", Expense},
	{"stock_losses", "Stock written off", Expense},
	{"other_expenses", "Other expenses", Expense},
}

// Builtin returns the platform's accounts.
func Builtin() []Account {
	out := make([]Account, len(builtin))
	copy(out, builtin)
	return out
}

var index = func() map[string]Account {
	m := make(map[string]Account, len(builtin))
	for _, a := range builtin {
		m[a.Code] = a
	}
	return m
}()

// Get looks up a built-in account.
func Get(code string) (Account, bool) {
	a, ok := index[code]
	return a, ok
}
