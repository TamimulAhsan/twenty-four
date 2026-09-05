package token

import (
	"strings"
	"testing"
	"time"
)

func newIssuer(t *testing.T, ttl time.Duration) *Issuer {
	t.Helper()
	k, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	i, err := NewIssuer(k, ttl)
	if err != nil {
		t.Fatal(err)
	}
	return i
}

func TestIssueParse_RoundTrip(t *testing.T) {
	i := newIssuer(t, time.Hour)
	in := Claims{UserID: "u1", TenantID: "t1", SessionID: "s1", Plane: "tenant"}
	tok, exp, err := i.Issue(in)
	if err != nil {
		t.Fatal(err)
	}
	if !exp.After(time.Now()) {
		t.Fatal("expiry is not in the future")
	}
	got, err := i.Parse(tok)
	if err != nil {
		t.Fatal(err)
	}
	if got.UserID != "u1" || got.TenantID != "t1" || got.SessionID != "s1" || got.Plane != "tenant" {
		t.Fatalf("claims did not survive the round trip: %+v", got)
	}
}

// The token must be encrypted, not just signed: a stolen token should not
// reveal the tenant or user it belongs to.
func TestIssue_PayloadIsOpaque(t *testing.T) {
	i := newIssuer(t, time.Hour)
	tok, _, _ := i.Issue(Claims{UserID: "secret-user", TenantID: "secret-tenant", SessionID: "s", Plane: "tenant"})
	if strings.Contains(tok, "secret-user") || strings.Contains(tok, "secret-tenant") {
		t.Fatal("token leaks its claims in plaintext")
	}
	if !strings.HasPrefix(tok, "v4.local.") {
		t.Fatalf("expected a v4.local token, got %.12s…", tok)
	}
}

// A token from one deployment must be worthless against another.
func TestParse_RejectsForeignKey(t *testing.T) {
	a, b := newIssuer(t, time.Hour), newIssuer(t, time.Hour)
	tok, _, _ := a.Issue(Claims{UserID: "u", TenantID: "t", SessionID: "s", Plane: "tenant"})
	if _, err := b.Parse(tok); err == nil {
		t.Fatal("token minted with a different key was accepted")
	}
}

func TestParse_RejectsExpired(t *testing.T) {
	i := newIssuer(t, -time.Minute) // already expired on issue
	tok, _, _ := i.Issue(Claims{UserID: "u", TenantID: "t", SessionID: "s", Plane: "tenant"})
	if _, err := i.Parse(tok); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestParse_RejectsTampering(t *testing.T) {
	i := newIssuer(t, time.Hour)
	tok, _, _ := i.Issue(Claims{UserID: "u", TenantID: "t", SessionID: "s", Plane: "tenant"})
	// Flip a character in the payload.
	b := []byte(tok)
	b[len(b)/2] ^= 0x01
	if _, err := i.Parse(string(b)); err == nil {
		t.Fatal("tampered token accepted")
	}
	for name, bad := range map[string]string{
		"empty":     "",
		"garbage":   "not-a-token",
		"wrong ver": "v2.local.abcdef",
		"truncated": tok[:len(tok)/2],
	} {
		if _, err := i.Parse(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestNewIssuer_RejectsBadKeys(t *testing.T) {
	for name, k := range map[string]string{
		"not hex":   "zzzz",
		"too short": "abcd",
		"empty":     "",
	} {
		if _, err := NewIssuer(k, time.Hour); err == nil {
			t.Errorf("%s: accepted as a key", name)
		}
	}
}
