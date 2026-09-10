// Package desk is the development transport's read side: the page that shows
// what would have been sent.
//
// It exists for the same reason the payment desk does. A development transport
// that only wrote a log line would make every message invisible to the person
// checking whether the invitation worked, and "check the pod logs" is not an
// answer you can give a specialist onboarding a merchant.
//
// It is unauthenticated and it is not part of the NotificationService contract.
// A real provider has a dashboard of its own; this stands in exactly there, and
// like the payment desk it must never be deployed anywhere real, because it
// shows every message for every tenant.
package desk

import (
	"embed"
	"html/template"
	"strings"
)

//go:embed *.html
var files embed.FS

var Templates = template.Must(template.New("desk").Funcs(template.FuncMap{
	// The first line of a message, for the list. Trimmed rather than truncated
	// mid-word, because a list of messages cut at forty characters is a list
	// nobody can scan.
	"preview": func(body string) string {
		line := strings.TrimSpace(strings.SplitN(body, "\n", 2)[0])
		if len(line) > 90 {
			if cut := strings.LastIndex(line[:90], " "); cut > 40 {
				return line[:cut] + "..."
			}
			return line[:90] + "..."
		}
		return line
	},
}).ParseFS(files, "*.html"))
