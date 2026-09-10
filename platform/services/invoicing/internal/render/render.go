// Package render produces the artifact that is stored with a document.
//
// Stored, not recomputed. An issued document has to re-render exactly as it was
// issued, and recomputing it from current prices and current tax rates would
// answer a different question convincingly enough that nobody would notice it
// was the wrong one. So this runs once, at issue, and its output is a column.
//
// It writes plain text. Gotenberg is in the stack for PDF and belongs here
// eventually, but it is a second workload and a second failure mode on the path
// that issues a legal document, and "a third party being down must never block
// a sale" applies to the document as much as to the payment. Text now, rendered
// once, stored; PDF later, from the same function, with the same guarantee.
package render

import (
	"fmt"
	"strings"
	"time"
)

// Money is minor units and a code, exactly as it is everywhere else.
type Money struct {
	Minor    int64
	Currency string
}

// String prints the integer and the code. This package has no currency table,
// so it must not decide where a decimal point goes: HUF has no subunit and 2340
// is not 23.40.
func (m Money) String() string {
	return fmt.Sprintf("%d %s", m.Minor, m.Currency)
}

type Line struct {
	Description string
	Quantity    int32
	UnitPrice   Money
	Net         Money
	Tax         Money
	Gross       Money
	TaxBasis    int32
}

// Document is what gets rendered.
type Document struct {
	Number   string
	Kind     string
	IssuedAt time.Time
	DueAt    *time.Time

	BusinessName    string
	BusinessAddress string
	MerchantCode    string

	CustomerName    string
	CustomerAddress string
	CustomerTaxID   string

	Lines []Line
	Net   Money
	Tax   Money
	Gross Money

	// Set on a credit note.
	Corrects string
	Reason   string
}

// Heading is what the document calls itself.
//
// The words are the platform's, not a trade's: a document is an invoice whether
// the business sells rooms or haircuts. Trade vocabulary applies to what is on
// the lines, and the term set is applied before the lines reach here.
func heading(kind string) string {
	switch kind {
	case "invoice":
		return "INVOICE"
	case "receipt":
		return "RECEIPT"
	case "credit_note":
		return "CREDIT NOTE"
	case "subscription_invoice":
		return "INVOICE"
	}
	return strings.ToUpper(strings.ReplaceAll(kind, "_", " "))
}

// Text renders the document.
func Text(d Document) []byte {
	var b strings.Builder
	line := func(format string, args ...any) {
		fmt.Fprintf(&b, format+"\n", args...)
	}

	line("%s", heading(d.Kind))
	line("%s", strings.Repeat("=", len(heading(d.Kind))))
	line("")
	line("Number      %s", d.Number)
	line("Issued      %s", d.IssuedAt.UTC().Format("2006-01-02"))
	if d.DueAt != nil {
		line("Due         %s", d.DueAt.UTC().Format("2006-01-02"))
	}
	if d.Corrects != "" {
		// Named on the face of the document, because a credit note that does
		// not say what it corrects is a credit note nobody can match up.
		line("Corrects    %s", d.Corrects)
		if d.Reason != "" {
			line("Reason      %s", d.Reason)
		}
	}
	line("")

	line("From")
	line("  %s", d.BusinessName)
	if d.BusinessAddress != "" {
		for _, l := range strings.Split(d.BusinessAddress, "\n") {
			line("  %s", l)
		}
	}
	if d.MerchantCode != "" {
		line("  Merchant code %s", d.MerchantCode)
	}
	line("")

	if d.CustomerName != "" || d.CustomerAddress != "" {
		line("To")
		if d.CustomerName != "" {
			line("  %s", d.CustomerName)
		}
		for _, l := range strings.Split(d.CustomerAddress, "\n") {
			if strings.TrimSpace(l) != "" {
				line("  %s", l)
			}
		}
		if d.CustomerTaxID != "" {
			line("  %s", d.CustomerTaxID)
		}
		line("")
	}

	line("%-34s %4s %12s %12s", "DESCRIPTION", "QTY", "NET", "GROSS")
	line("%s", strings.Repeat("-", 66))
	for _, l := range d.Lines {
		desc := l.Description
		if len(desc) > 34 {
			desc = desc[:31] + "..."
		}
		line("%-34s %4d %12s %12s", desc, l.Quantity, l.Net.String(), l.Gross.String())
	}
	line("%s", strings.Repeat("-", 66))
	line("%-39s %12s", "Net", d.Net.String())
	line("%-39s %12s", "Tax", d.Tax.String())
	line("%-39s %12s", "Total", d.Gross.String())

	return []byte(b.String())
}
