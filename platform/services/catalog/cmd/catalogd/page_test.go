package main

import (
	"testing"

	"github.com/google/uuid"
)

func TestPageTokenRoundTrips(t *testing.T) {
	for _, name := range []string{"Espresso", "", "Ristretto \x01 odd", "Ünnepi tál", "a\x00b"} {
		id := uuid.New()
		gotName, gotID, err := decodePageToken(encodePageToken(name, id))
		if err != nil {
			t.Fatalf("decode(%q): %v", name, err)
		}
		if gotID != id {
			t.Fatalf("id changed: %v -> %v", id, gotID)
		}
		if gotName != name {
			t.Fatalf("name changed: %q -> %q", name, gotName)
		}
	}
}

func TestPageTokenRejectsWhatWeDidNotIssue(t *testing.T) {
	for _, tok := range []string{"not base64!", "", "Zm9v", "AAAA"} {
		if _, _, err := decodePageToken(tok); err == nil {
			t.Fatalf("accepted %q", tok)
		}
	}
}
