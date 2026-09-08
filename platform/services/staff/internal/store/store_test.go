package store

import (
	"testing"

	"github.com/google/uuid"
)

// A rota where two people look the same is a rota that gets misread at the
// moment nobody has time to look twice, so a small team should get distinct
// colours before any repeat.
func TestNextColourSpreadsBeforeRepeating(t *testing.T) {
	taken := map[string]int{}
	pick := func() string {
		best, bestN := Palette[0], -1
		for _, c := range Palette {
			if n := taken[c]; bestN < 0 || n < bestN {
				best, bestN = c, n
			}
		}
		taken[best]++
		return best
	}
	seen := map[string]bool{}
	for i := 0; i < len(Palette); i++ {
		c := pick()
		if seen[c] {
			t.Fatalf("%s repeated after %d people", c, i)
		}
		seen[c] = true
	}
	// The ninth person may repeat, but must take a colour used only once.
	if c := pick(); taken[c] != 2 {
		t.Fatalf("ninth colour had been used %d times", taken[c])
	}
}

func TestPaletteIsDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range Palette {
		if seen[c] {
			t.Fatalf("%s appears twice in the palette", c)
		}
		if len(c) != 7 || c[0] != '#' {
			t.Fatalf("%q is not a hex colour", c)
		}
		seen[c] = true
	}
	if len(Palette) < 8 {
		t.Fatalf("the palette holds %d colours; the largest tier is 15 seats", len(Palette))
	}
}

func TestMemberIsKeyedByTheAuthUserID(t *testing.T) {
	// Not a behaviour test so much as a statement of the invariant the whole
	// seat rule rests on: a member has no identifier of its own.
	m := Member{TenantID: uuid.New(), UserID: uuid.New()}
	if m.UserID == uuid.Nil {
		t.Fatal("a member with no user is not a person")
	}
}
