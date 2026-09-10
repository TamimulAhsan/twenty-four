package templates

import (
	"strings"
	"testing"
)

func TestAMissingParameterLeavesAGapRatherThanBraces(t *testing.T) {
	// A customer reading "Hello {{name}}" is worse than a customer reading
	// "Hello". The mistake is still findable, because the delivery log records
	// what was actually sent, and Missing names it for the log.
	got := Render("Hello {{name}}, your table is at {{time}}.", map[string]string{"name": "Anna"})
	if strings.Contains(got, "{{") {
		t.Fatalf("a placeholder survived into the message: %q", got)
	}
	if got != "Hello Anna, your table is at ." {
		t.Fatalf("got %q", got)
	}
}

func TestMissingNamesTheGaps(t *testing.T) {
	missing := Missing("Receipt {{number}}", "Total {{total}} paid by {{method}}",
		map[string]string{"number": "1", "total": "  "})
	if len(missing) != 2 || missing[0] != "method" || missing[1] != "total" {
		t.Fatalf("got %v, want method and total, sorted", missing)
	}
}

func TestEveryBuiltinDeclaresItsOwnParameters(t *testing.T) {
	for _, d := range All() {
		if d.Key == "" || d.Body == "" {
			t.Fatalf("%q is not a usable template", d.Key)
		}
		if d.Channel == "" || d.Category == "" {
			t.Fatalf("%q has no channel or category, so nothing can decide whether to send it", d.Key)
		}
		if len(Params(d.Subject, d.Body)) == 0 {
			t.Fatalf("%q takes no parameters, which is unlikely to be intended", d.Key)
		}
	}
}

func TestNoBuiltinNamesATrade(t *testing.T) {
	// The trade-neutrality rule reaches message wording too. A template saying
	// "your room" is a template wrong for the forty other industries, and the
	// term set is where a hotel's word for it belongs.
	forbidden := []string{"room", "dish", "menu", "treatment", "table"}
	for _, d := range All() {
		text := strings.ToLower(d.Subject + " " + d.Body)
		for _, word := range forbidden {
			if strings.Contains(text, word) {
				t.Errorf("%q says %q, which only holds for one trade", d.Key, word)
			}
		}
	}
}
