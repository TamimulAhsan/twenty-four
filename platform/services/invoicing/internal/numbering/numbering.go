// Package numbering is the invoice number format.
//
// One format in every market: year-merchantcode-sequence, "2026-7QK3M9-110".
// That is a deliberate deviation from the architecture, which lists numbering
// as free to differ per market precisely because Hungary and Bangladesh
// prescribe formats independently. Using one everywhere is simpler to build and
// simpler to explain, and it is cheap to reverse: this package is inside the
// market-swapped pod, so a market that rejects the format changes one
// deployment and nothing else.
//
// The hard constraint is not the format, it is gaplessness. A missing number is
// something a Hungarian auditor asks about, which rules out allocating before
// the document is committed: a rolled-back transaction would leave a hole.
package numbering

import (
	"fmt"
	"strings"
)

// Format assembles a number from its three parts.
//
// The merchant code is not validated here beyond being present. It comes from
// Auth, which owns the alphabet and the uniqueness constraint, and re-checking
// it here would be a second opinion about a value this service does not own.
func Format(year int, merchantCode string, sequence int64) (string, error) {
	code := strings.TrimSpace(strings.ToUpper(merchantCode))
	if code == "" {
		// Refused rather than substituted. A document numbered without the
		// merchant code is a document that cannot be told apart from another
		// business's, and it cannot be withdrawn once issued.
		return "", fmt.Errorf("numbering: no merchant code, so no number can be issued")
	}
	if year < 2000 || year > 9999 {
		return "", fmt.Errorf("numbering: %d is not a year a document can be issued in", year)
	}
	if sequence < 1 {
		return "", fmt.Errorf("numbering: a sequence starts at 1, not %d", sequence)
	}
	return fmt.Sprintf("%04d-%s-%d", year, code, sequence), nil
}

// Parse reads a number back into its parts, which is what a search box needs.
func Parse(number string) (year int, code string, sequence int64, ok bool) {
	parts := strings.Split(number, "-")
	if len(parts) != 3 {
		return 0, "", 0, false
	}
	if _, err := fmt.Sscanf(parts[0], "%d", &year); err != nil {
		return 0, "", 0, false
	}
	if _, err := fmt.Sscanf(parts[2], "%d", &sequence); err != nil {
		return 0, "", 0, false
	}
	return year, parts[1], sequence, true
}
