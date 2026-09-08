// Package merchantcode mints the six-character code that identifies a tenant on
// every document it issues.
//
// The code outlives almost everything else about a business. It is printed on
// invoices that tax authorities and accountants keep for years, so it is
// assigned once, never changed, and never reissued to a second tenant even
// after the first one leaves. Two businesses that are indistinguishable on
// paper is not a problem that can be fixed later.
package merchantcode

import (
	"crypto/rand"
	"fmt"
	"strings"
)

// Alphabet is Crockford base32: the digits and the uppercase letters, minus
// I, L, O and U.
//
// I against 1 and O against 0 are read wrong when someone copies a code off a
// printed invoice, which is exactly how these are used. L is dropped for the
// same reason in the other direction. U is dropped so that a random six
// character string does not occasionally spell something a merchant has to
// look at on every document they send.
const Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Length is six. That is 32^6, a little over a billion codes, so random
// assignment against a uniqueness constraint will effectively never collide.
const Length = 6

// New returns a fresh code.
//
// The alphabet is exactly 32 long, a power of two, so taking each random byte
// modulo 32 is uniform. An alphabet of any other size would need rejection
// sampling to avoid biasing the low characters.
func New() (string, error) {
	b := make([]byte, Length)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("merchantcode: %w", err)
	}
	out := make([]byte, Length)
	for i, v := range b {
		out[i] = Alphabet[int(v)%len(Alphabet)]
	}
	return string(out), nil
}

// Normalise is what to call on a code a human typed or read off paper. It
// uppercases, drops separators, and applies Crockford's substitutions: I and L
// become 1, O becomes 0.
//
// This exists so that a mistyped code fails as "no such merchant" rather than
// as a support call. It does not accept U in either case: U is not in the
// alphabet and never was, so a code containing one was not issued here.
func Normalise(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToUpper(strings.TrimSpace(s)) {
		switch r {
		case '-', ' ', '_':
			continue
		case 'I', 'L':
			b.WriteRune('1')
		case 'O':
			b.WriteRune('0')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Valid reports whether s is a code this package could have issued. It does not
// say whether the code belongs to anyone.
func Valid(s string) bool {
	if len(s) != Length {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune(Alphabet, r) {
			return false
		}
	}
	return true
}
