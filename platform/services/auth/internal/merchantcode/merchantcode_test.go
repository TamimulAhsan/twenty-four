package merchantcode

import (
	"strings"
	"testing"
)

func TestNewProducesValidCodes(t *testing.T) {
	for i := 0; i < 2000; i++ {
		c, err := New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if !Valid(c) {
			t.Fatalf("New produced an invalid code: %q", c)
		}
	}
}

// The whole reason for the custom alphabet. A code containing one of these has
// been misread off paper, and would be misread again.
func TestAmbiguousCharactersAreNeverIssued(t *testing.T) {
	for _, r := range "ILOU" {
		if strings.ContainsRune(Alphabet, r) {
			t.Fatalf("%q is in the alphabet", r)
		}
	}
	for i := 0; i < 5000; i++ {
		c, _ := New()
		if strings.ContainsAny(c, "ILOU") {
			t.Fatalf("issued a code with an ambiguous character: %q", c)
		}
	}
}

// Modulo over an alphabet whose length is not a power of two would quietly
// favour its first characters. Thirty-two is, so every character should appear
// at a comparable rate.
func TestDistributionIsNotSkewed(t *testing.T) {
	const runs = 20000
	seen := map[rune]int{}
	for i := 0; i < runs; i++ {
		c, _ := New()
		for _, r := range c {
			seen[r]++
		}
	}
	if len(seen) != len(Alphabet) {
		t.Fatalf("only %d of %d characters ever appeared", len(seen), len(Alphabet))
	}
	expect := runs * Length / len(Alphabet)
	for r, n := range seen {
		if n < expect/2 || n > expect*2 {
			t.Fatalf("%q appeared %d times, expected around %d", r, n, expect)
		}
	}
}

func TestNormaliseFixesWhatPeopleMisread(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"7qk3m9", "7QK3M9"},
		{"  7QK3M9  ", "7QK3M9"},
		{"7QK-3M9", "7QK3M9"},
		{"7QK 3M9", "7QK3M9"},
		{"IL0OO", "11000"},
		{"o1i", "011"},
	} {
		if got := Normalise(tc.in); got != tc.want {
			t.Fatalf("Normalise(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A round trip through paper must not change the code: normalising something
// this package issued has to be a no-op, or a merchant reading their own code
// back would land on someone else's.
func TestNormaliseIsIdentityOnIssuedCodes(t *testing.T) {
	for i := 0; i < 2000; i++ {
		c, _ := New()
		if got := Normalise(c); got != c {
			t.Fatalf("Normalise changed an issued code: %q -> %q", c, got)
		}
	}
}

func TestValidRejectsWhatWasNotIssuedHere(t *testing.T) {
	for _, c := range []string{"", "7QK3M", "7QK3M99", "7qk3m9", "7QK3MI", "7QK3M-", "7QK3MU"} {
		if Valid(c) {
			t.Fatalf("accepted %q", c)
		}
	}
}
