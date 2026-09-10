// Package templates holds the platform's own message wording, and the
// substitution that turns one into a message.
//
// These live in code rather than in a row per tenant. Seeding them at
// provisioning would make every wording fix a data migration across every
// tenant in the market, and a tenant who never edits anything would carry a
// private copy of text that is identical everywhere. A row in the templates
// table is therefore always an override, and deleting one restores the text
// here rather than leaving a business unable to send a receipt.
//
// The wording is deliberately plain. A receipt is not a marketing surface, and
// a business that wants its own voice has the editor.
package templates

import (
	"regexp"
	"sort"
	"strings"
)

// Definition is one built-in message.
type Definition struct {
	Key      string
	Channel  string
	Category string
	Subject  string
	Body     string
}

// The keys are semantic, never display terms: a hotel's confirmation is
// booking.confirmed, not room.confirmed. Renaming what a merchant calls a
// booking must not change what a template is called, or the override a tenant
// wrote would stop matching the message it was written for.
var builtins = []Definition{
	{
		Key: "staff.invitation", Channel: "email", Category: "transactional",
		Subject: "{{business_name}} has invited you",
		Body: "Hello {{name}},\n\n" +
			"{{inviter}} has invited you to work on {{business_name}}.\n\n" +
			"Accept the invitation here:\n{{accept_url}}\n\n" +
			"The link stops working in {{expires_in}}.",
	},
	{
		Key: "password.reset", Channel: "email", Category: "transactional",
		Subject: "Reset your password",
		Body: "Hello {{name}},\n\n" +
			"Somebody asked to reset the password for this address. If it was " +
			"not you, nothing has changed and you can ignore this.\n\n" +
			"Set a new password here:\n{{reset_url}}\n\n" +
			"The link stops working in {{expires_in}}.",
	},
	{
		Key: "order.receipt", Channel: "email", Category: "receipt",
		Subject: "Your receipt from {{business_name}}",
		Body: "Thank you.\n\n" +
			"{{business_name}}\nReceipt {{reference}}\n{{placed_at}}\n\n" +
			"{{lines}}\n\n" +
			"Total {{total}}\nPaid by {{method}}\n\n" +
			"Keep this for your records.",
	},
	{
		Key: "booking.confirmed", Channel: "email", Category: "transactional",
		Subject: "Your booking with {{business_name}} is confirmed",
		Body: "Hello {{name}},\n\n" +
			"You are booked for {{service}} on {{starts_at}}.\n\n" +
			"{{business_name}}\n{{address}}\n\n" +
			"To change or cancel it, reply to this message.",
	},
	{
		Key: "booking.reminder", Channel: "email", Category: "reminder",
		Subject: "Tomorrow: {{service}} at {{business_name}}",
		Body: "Hello {{name}},\n\n" +
			"A reminder that you are booked for {{service}} on {{starts_at}}.\n\n" +
			"{{business_name}}\n{{address}}",
	},
	{
		Key: "booking.cancelled", Channel: "email", Category: "transactional",
		Subject: "Your booking with {{business_name}} is cancelled",
		Body: "Hello {{name}},\n\n" +
			"Your booking for {{service}} on {{starts_at}} has been cancelled.\n\n" +
			"{{business_name}}",
	},
	{
		Key: "invoice.issued", Channel: "email", Category: "transactional",
		Subject: "Invoice {{number}} from {{business_name}}",
		Body: "Hello {{name}},\n\n" +
			"Invoice {{number}} for {{total}} is attached, due {{due_date}}.\n\n" +
			"{{business_name}}",
	},
	{
		Key: "stock.low", Channel: "email", Category: "operational",
		Subject: "Running low: {{item_name}}",
		Body: "{{item_name}} is down to {{on_hand}}, at or below the {{threshold}} " +
			"you set.\n\nThis is sent once per crossing, not once per sale.",
	},
	{
		Key: "day.closed", Channel: "email", Category: "operational",
		Subject: "{{business_name}}: {{date}} closed",
		Body: "{{date}} is closed.\n\n" +
			"Counted {{counted}}\nExpected {{expected}}\nDifference {{difference}}\n\n" +
			"{{note}}",
	},
}

var index = func() map[string]Definition {
	m := make(map[string]Definition, len(builtins))
	for _, d := range builtins {
		m[d.Key] = d
	}
	return m
}()

// Builtin returns the platform's version of a template.
func Builtin(key string) (Definition, bool) {
	d, ok := index[key]
	return d, ok
}

// All returns every built-in, in a stable order.
func All() []Definition {
	out := make([]Definition, len(builtins))
	copy(out, builtins)
	return out
}

var placeholder = regexp.MustCompile(`\{\{\s*([a-z0-9_]+)\s*\}\}`)

// Params reports the placeholder names a template refers to, so the editor can
// say which are available rather than making a merchant guess.
func Params(subject, body string) []string {
	seen := map[string]bool{}
	for _, m := range placeholder.FindAllStringSubmatch(subject+"\n"+body, -1) {
		seen[m[1]] = true
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Render substitutes params into a template.
//
// A placeholder with no value becomes empty rather than staying as literal
// braces. A customer seeing "Hello {{name}}" is worse than seeing "Hello", and
// the delivery log records what was actually sent either way, so the mistake is
// findable without also being published.
func Render(text string, params map[string]string) string {
	return placeholder.ReplaceAllStringFunc(text, func(m string) string {
		name := placeholder.FindStringSubmatch(m)[1]
		return params[name]
	})
}

// Missing reports which placeholders had no value, so a caller can be told it
// sent a message with a hole in it.
func Missing(subject, body string, params map[string]string) []string {
	var out []string
	for _, name := range Params(subject, body) {
		if strings.TrimSpace(params[name]) == "" {
			out = append(out, name)
		}
	}
	return out
}
