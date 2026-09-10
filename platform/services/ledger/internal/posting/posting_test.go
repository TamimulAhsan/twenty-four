package posting

import (
	"errors"
	"testing"
)

func sum(e Entry) int64 {
	var total int64
	for _, l := range e.Lines {
		total += l.Minor
	}
	return total
}

func line(e Entry, account string) (Line, bool) {
	for _, l := range e.Lines {
		if l.Account == account {
			return l, true
		}
	}
	return Line{}, false
}

const cashSale = `{"order_id":"o1","number":"20260908-0001","status":"settled",
	"gross":{"minor":2540,"currency":"HUF"},
	"net":{"minor":2000,"currency":"HUF"},
	"tax":{"minor":540,"currency":"HUF"},
	"tenders":[{"method":"cash","amount":{"minor":2540,"currency":"HUF"}}]}`

func TestASaleBalances(t *testing.T) {
	e, err := Describe("order.placed", []byte(cashSale))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if !e.Balanced() {
		t.Fatalf("lines sum to %d, want 0", sum(e))
	}
}

func TestTaxCollectedIsALiabilityAndNotRevenue(t *testing.T) {
	// The single most common thing to get wrong, and it is wrong in a way that
	// overstates income until somebody files a return.
	e, _ := Describe("order.placed", []byte(cashSale))
	revenue, ok := line(e, "sales_revenue")
	if !ok {
		t.Fatal("no revenue line")
	}
	if revenue.Minor != -2000 {
		t.Fatalf("revenue %d, want the net of tax as a credit", revenue.Minor)
	}
	tax, ok := line(e, "tax_payable")
	if !ok {
		t.Fatal("the tax collected was not booked as a liability")
	}
	if tax.Minor != -540 {
		t.Fatalf("tax %d, want 540 held for the authority", tax.Minor)
	}
}

func TestACardSaleDoesNotSayTheMoneyIsInTheBank(t *testing.T) {
	// Booking a card sale straight to the bank says the money is there on a day
	// it is not, and the business then reconciles against a statement that
	// disagrees.
	e, err := Describe("order.placed", []byte(`{"order_id":"o2","number":"2","status":"settled",
		"gross":{"minor":1000,"currency":"HUF"},"net":{"minor":1000,"currency":"HUF"},
		"tax":{"minor":0,"currency":"HUF"},
		"tenders":[{"method":"card","amount":{"minor":1000,"currency":"HUF"}}]}`))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if _, ok := line(e, "bank"); ok {
		t.Fatal("a card sale went straight to the bank")
	}
	clearing, ok := line(e, "card_clearing")
	if !ok || clearing.Minor != 1000 {
		t.Fatalf("card takings did not land in the clearing account: %+v", e.Lines)
	}
}

func TestASplitTenderBooksEachMethodSeparately(t *testing.T) {
	e, err := Describe("order.placed", []byte(`{"order_id":"o3","number":"3","status":"settled",
		"gross":{"minor":1000,"currency":"HUF"},"net":{"minor":1000,"currency":"HUF"},
		"tax":{"minor":0,"currency":"HUF"},
		"tenders":[{"method":"cash","amount":{"minor":400,"currency":"HUF"}},
		           {"method":"card","amount":{"minor":600,"currency":"HUF"}}]}`))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	cash, _ := line(e, "cash")
	card, _ := line(e, "card_clearing")
	if cash.Minor != 400 || card.Minor != 600 {
		t.Fatalf("got cash %d and card %d", cash.Minor, card.Minor)
	}
	if !e.Balanced() {
		t.Fatalf("lines sum to %d", sum(e))
	}
}

func TestASaleWithNothingTenderedIsOwedRatherThanUnbalanced(t *testing.T) {
	e, err := Describe("order.placed", []byte(`{"order_id":"o4","number":"4","status":"settled",
		"gross":{"minor":1000,"currency":"HUF"},"net":{"minor":1000,"currency":"HUF"},
		"tax":{"minor":0,"currency":"HUF"},"tenders":[]}`))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	owed, ok := line(e, "receivables")
	if !ok || owed.Minor != 1000 {
		t.Fatalf("nothing was recorded as owed: %+v", e.Lines)
	}
	if !e.Balanced() {
		t.Fatalf("lines sum to %d", sum(e))
	}
}

func TestAParkedSaleIsNotASale(t *testing.T) {
	// Nothing has been sold and nothing taken. Booking it would put revenue in
	// the books for a tab somebody may still walk away from.
	_, err := Describe("order.placed", []byte(`{"order_id":"o5","status":"open",
		"gross":{"minor":900,"currency":"HUF"},"tenders":[]}`))
	if !errors.Is(err, ErrNotBookkeepable) {
		t.Fatalf("got %v, want nothing to book", err)
	}
}

func TestAVoidIsTheSaleBackwardsAndNotAnErasure(t *testing.T) {
	// The original happened: a receipt was printed and somebody has it. The
	// correction is its own entry.
	e, err := Describe("order.voided", []byte(cashSale))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if !e.Balanced() {
		t.Fatalf("lines sum to %d", sum(e))
	}
	revenue, _ := line(e, "sales_revenue")
	if revenue.Minor != 2000 {
		t.Fatalf("revenue %d, want the original credit reversed as a debit", revenue.Minor)
	}
	cash, _ := line(e, "cash")
	if cash.Minor != -2540 {
		t.Fatalf("cash %d, want the takings back out", cash.Minor)
	}
}

func TestARefundIsItsOwnAccountRatherThanNegativeSales(t *testing.T) {
	e, err := Describe("payment.refunded", []byte(`{"payment_id":"p1","refund_id":"r1",
		"amount":{"minor":500,"currency":"HUF"},"method_key":"cash","reason":"cold"}`))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if _, ok := line(e, "sales_revenue"); ok {
		t.Fatal("a refund reduced sales instead of being recorded as a refund")
	}
	refunds, ok := line(e, "sales_refunds")
	if !ok || refunds.Minor != 500 {
		t.Fatalf("got %+v", e.Lines)
	}
	if !e.Balanced() {
		t.Fatalf("lines sum to %d", sum(e))
	}
}

func TestMostEventsAreNotBookkeeping(t *testing.T) {
	// A ledger that booked every event would be a ledger of everything that
	// ever happened rather than a set of books.
	for _, topic := range []string{"stock.adjusted", "notification.sent", "staff.added"} {
		if _, err := Describe(topic, []byte(`{}`)); !errors.Is(err, ErrNotBookkeepable) {
			t.Errorf("%s produced an entry", topic)
		}
	}
}

func TestEveryRuleProducesABalancedEntry(t *testing.T) {
	// The invariant, stated once over everything this package can produce.
	payloads := map[string]string{
		"order.placed":     cashSale,
		"order.voided":     cashSale,
		"payment.refunded": `{"payment_id":"p","amount":{"minor":100,"currency":"HUF"},"method_key":"card"}`,
	}
	for topic, payload := range payloads {
		e, err := Describe(topic, []byte(payload))
		if err != nil {
			t.Fatalf("%s: %v", topic, err)
		}
		if !e.Balanced() {
			t.Errorf("%s: lines sum to %d", topic, sum(e))
		}
		if e.Currency == "" {
			t.Errorf("%s: an entry with no currency is an amount that means nothing", topic)
		}
	}
}
