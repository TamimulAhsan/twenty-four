package phrasing

import (
	"strings"
	"testing"
)

func TestASaleReadsAsASentence(t *testing.T) {
	got := Describe("order.placed", []byte(`{
		"order_id":"7f1c0e2a-0000-4000-8000-000000000001","number":"20260908-0001",
		"gross":{"minor":2340,"currency":"HUF"},
		"lines":[{"name":"Espresso","quantity":2},{"name":"Bun","quantity":1}],
		"tenders":[{"method":"cash"}]}`))
	want := "Sale 20260908-0001 rang up: 3 items for 2340 HUF, paid by cash."
	if got.Summary != want {
		t.Fatalf("got %q\nwant %q", got.Summary, want)
	}
	if got.SubjectType != "order" || got.SubjectID == "" {
		t.Fatalf("the line cannot be read beside the sale it describes: %+v", got)
	}
}

func TestItemsAreCountedNotLines(t *testing.T) {
	// Three of one thing is three items sold. A merchant reading the trail
	// counts what left the shelf, not how many rows the till wrote.
	got := Describe("order.placed", []byte(`{"number":"1","gross":{"minor":10,"currency":"HUF"},
		"lines":[{"name":"Bun","quantity":3}]}`))
	if !strings.Contains(got.Summary, "3 items") {
		t.Fatalf("got %q, want three items from one line", got.Summary)
	}
}

func TestPartlyAndFullyRefundedAreDifferentSentences(t *testing.T) {
	part := Describe("payment.refunded", []byte(`{"amount":{"minor":500,"currency":"HUF"},"fully_refunded":false}`))
	full := Describe("payment.refunded", []byte(`{"amount":{"minor":500,"currency":"HUF"},"fully_refunded":true}`))
	if !strings.HasPrefix(part.Summary, "Partly refunded") {
		t.Fatalf("got %q", part.Summary)
	}
	if !strings.HasPrefix(full.Summary, "Fully refunded") {
		t.Fatalf("got %q", full.Summary)
	}
}

func TestMoneyKeepsItsMinorUnitsAndCode(t *testing.T) {
	// This package has no currency table, so it must not pretend to know where
	// a decimal point goes. HUF has no subunit and 2340 is not 23.40.
	got := Describe("payment.succeeded", []byte(`{"amount":{"minor":2340,"currency":"HUF"},"method_key":"cash"}`))
	if !strings.Contains(got.Summary, "2340 HUF") {
		t.Fatalf("got %q, want the integer and the code", got.Summary)
	}
	if strings.Contains(got.Summary, "23.40") {
		t.Fatal("a decimal point was invented for a currency that has no subunit")
	}
}

func TestAReserveIsStockHeldNotStockGained(t *testing.T) {
	got := Describe("stock.adjusted", []byte(`{"item_id":"i1","delta":2,"kind":"reserve",
		"reference_type":"order","reference_id":"o1","on_hand":10}`))
	if !strings.Contains(got.Summary, "held") {
		t.Fatalf("got %q, want a sentence saying the stock is held", got.Summary)
	}
}

func TestAnUnknownTopicIsStillRecorded(t *testing.T) {
	// A trail that only covers the events somebody wrote a sentence for has
	// holes in exactly the places nobody was watching.
	got := Describe("shipment.dispatched", []byte(`{"shipment_id":"s1"}`))
	if got.Known {
		t.Fatal("this topic has no phrasing and should say so")
	}
	if got.Summary != "Shipment dispatched." {
		t.Fatalf("got %q", got.Summary)
	}
	if got.SubjectID != "s1" {
		t.Fatalf("got subject %q, want the id the event named after itself", got.SubjectID)
	}
	if got.Action != "shipment.dispatched" {
		t.Fatalf("got action %q, want the topic kept as it was", got.Action)
	}
}

func TestMalformedPayloadDoesNotLoseTheLine(t *testing.T) {
	got := Describe("order.placed", []byte(`not json`))
	if got.Summary == "" {
		t.Fatal("an event that cannot be parsed still happened")
	}
}

func TestNoSentenceNamesATrade(t *testing.T) {
	// The record stays semantic, the same way the API path does. A hotel's word
	// for an item is applied when the trail is rendered, by whoever holds the
	// term set.
	got := Describe("stock.low", []byte(`{"item_id":"i1","on_hand":2,"threshold":5}`))
	if got.SubjectType != "catalog_item" {
		t.Fatalf("got subject type %q, want the semantic key", got.SubjectType)
	}
	for _, word := range []string{"room", "dish", "treatment"} {
		if strings.Contains(strings.ToLower(got.Summary), word) {
			t.Fatalf("%q names a trade", got.Summary)
		}
	}
}

func TestTheActionIsTheTopicNotTheVerb(t *testing.T) {
	// Deriving it from the wording produced "notification.composed" for an
	// event on notification.queued, which made filtering the trail by action
	// match nothing anybody would think to ask for.
	for _, topic := range []string{
		"notification.queued", "notification.sent", "staff.added", "staff.removed",
		"module.enabled", "module.disabled", "booking.created", "booking.cancelled",
		"booking.no_show",
	} {
		got := Describe(topic, []byte(`{}`))
		if got.Action != topic {
			t.Errorf("%s recorded as %q", topic, got.Action)
		}
	}
}

func TestTheArticleAgreesWithTheChannel(t *testing.T) {
	// The channel is data, so the article has to be chosen. "A email message"
	// is the sort of thing a merchant notices and an engineer does not.
	email := Describe("notification.sent", []byte(`{"channel":"email","template_key":"order.receipt"}`))
	if !strings.HasPrefix(email.Summary, "An email") {
		t.Fatalf("got %q", email.Summary)
	}
	push := Describe("notification.sent", []byte(`{"channel":"push","template_key":"order.receipt"}`))
	if !strings.HasPrefix(push.Summary, "A push") {
		t.Fatalf("got %q", push.Summary)
	}
}

func TestAFileIsRecordedAgainstWhatItBelongsTo(t *testing.T) {
	// The trail is read beside the item, not beside a list of files, so an
	// upload attached to something takes that thing as its subject.
	got := Describe("media.uploaded", []byte(`{"media_id":"m1","purpose":"catalog_image",
		"filename":"espresso.png","subject_type":"catalog_item","subject_id":"i7"}`))
	if got.SubjectType != "catalog_item" || got.SubjectID != "i7" {
		t.Fatalf("got %s %s, want the item it belongs to", got.SubjectType, got.SubjectID)
	}
	if !strings.Contains(got.Summary, "catalog image") {
		t.Fatalf("got %q, want the purpose in words rather than as a key", got.Summary)
	}
}

func TestAFileWithNothingToBelongToIsItsOwnSubject(t *testing.T) {
	got := Describe("media.uploaded", []byte(`{"media_id":"m1","purpose":"brand_logo","filename":"logo.png"}`))
	if got.SubjectType != "media" || got.SubjectID != "m1" {
		t.Fatalf("got %s %s", got.SubjectType, got.SubjectID)
	}
}
