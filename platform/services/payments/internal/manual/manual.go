// Package manual is the development payment provider: a person, deciding.
//
// It implements the same shape a real provider does. A payment that needs a
// customer or a terminal to act is created pending, with an external action
// URL; something outside the software then happens; the provider reports the
// outcome. Here the something is you, clicking Approve or Decline on a page.
//
// That is deliberately not a shortcut. The market-swap design rests on nothing
// upstream being able to tell which implementation is behind the contract, and
// a provider that always approved instantly would let callers quietly grow a
// dependence on synchronous success. A till that has been made to wait for a
// human is a till that will cope with a card machine.
//
// This page is not part of the PaymentsService contract, and it must not be.
// No real provider exposes an Approve call.
package manual

import (
	"embed"
	"fmt"
	"html/template"
	"strings"
)

// Methods are what this deployment can accept. The set is open by design: a
// real market's implementation returns its own, and the till renders buttons
// from whatever it is told rather than hardcoding "cash or card".
type Method struct {
	Key                    string
	Label                  string
	RequiresExternalAction bool
	Electronic             bool
}

// Cash is the one method that completes without the desk, because cash
// genuinely needs nothing outside the software: the money is already in the
// drawer by the time the button is pressed. Everything else waits for a person,
// which is the whole point of this provider.
var Methods = []Method{
	{Key: "cash", Label: "Cash", RequiresExternalAction: false, Electronic: false},
	{Key: "card", Label: "Card terminal", RequiresExternalAction: true, Electronic: true},
	{Key: "transfer", Label: "Bank transfer", RequiresExternalAction: true, Electronic: true},
}

func MethodByKey(key string) (Method, bool) {
	for _, m := range Methods {
		if m.Key == key {
			return m, true
		}
	}
	return Method{}, false
}

// Reference is what a real provider would return as its own identifier. It is
// opaque upstream: nothing parses it, and it exists so support and
// reconciliation have something to quote.
func Reference(id string) string {
	return "DEV-" + strings.ToUpper(strings.ReplaceAll(id, "-", ""))[:12]
}

//go:embed desk.html pay.html
var pages embed.FS

var Templates = template.Must(template.New("").Funcs(template.FuncMap{
	// Amounts arrive as integer minor units and a currency code, and are
	// formatted for display only here. Nothing downstream ever sees the
	// formatted string, because a formatted amount is not an amount.
	"amount": func(minor int64, currency string) string {
		switch currency {
		case "HUF":
			return fmt.Sprintf("%d Ft", minor)
		default:
			return fmt.Sprintf("%d.%02d %s", minor/100, abs(minor%100), currency)
		}
	},
}).ParseFS(pages, "*.html"))

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
