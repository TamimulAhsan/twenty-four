package numbering

import "testing"

func TestTheFormatIsYearCodeSequence(t *testing.T) {
	got, err := Format(2026, "7QK3M9", 110)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if got != "2026-7QK3M9-110" {
		t.Fatalf("got %q", got)
	}
}

func TestNoMerchantCodeMeansNoNumber(t *testing.T) {
	// A document numbered without the merchant code cannot be told apart from
	// another business's, and it cannot be withdrawn once issued. Refusing to
	// issue is the only safe answer.
	if _, err := Format(2026, "   ", 1); err == nil {
		t.Fatal("a document was numbered without a merchant code")
	}
}

func TestASequenceStartsAtOne(t *testing.T) {
	if _, err := Format(2026, "7QK3M9", 0); err == nil {
		t.Fatal("zero was accepted as a sequence")
	}
}

func TestTheCodeIsUppercasedRatherThanRefused(t *testing.T) {
	// Crockford base32 is case-insensitive to read, and a merchant typing it in
	// lower case has not made a mistake worth an error.
	got, _ := Format(2026, "7qk3m9", 5)
	if got != "2026-7QK3M9-5" {
		t.Fatalf("got %q", got)
	}
}

func TestANumberParsesBackIntoItsParts(t *testing.T) {
	year, code, seq, ok := Parse("2026-7QK3M9-110")
	if !ok || year != 2026 || code != "7QK3M9" || seq != 110 {
		t.Fatalf("got %d %q %d ok=%v", year, code, seq, ok)
	}
	if _, _, _, ok := Parse("not a number"); ok {
		t.Fatal("nonsense parsed as a document number")
	}
}
