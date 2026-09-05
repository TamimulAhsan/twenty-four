package credential

import (
	"strings"
	"testing"
)

func TestHashVerify_RoundTrip(t *testing.T) {
	pw := "correct horse battery staple"
	h, err := Hash(pw)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(pw, h); err != nil {
		t.Fatalf("correct password rejected: %v", err)
	}
	if err := Verify(pw+"x", h); err == nil {
		t.Fatal("wrong password accepted")
	}
}

// Two hashes of the same password must differ, or the salt is not doing its job
// and the store becomes vulnerable to precomputation.
func TestHash_IsSalted(t *testing.T) {
	pw := "correct horse battery staple"
	a, _ := Hash(pw)
	b, _ := Hash(pw)
	if a == b {
		t.Fatal("identical hashes for the same password — salt is not random")
	}
	if err := Verify(pw, a); err != nil {
		t.Fatal(err)
	}
	if err := Verify(pw, b); err != nil {
		t.Fatal(err)
	}
}

// The encoded hash must carry its own parameters so cost can be raised later
// without locking existing users out.
func TestHash_EncodesItsParameters(t *testing.T) {
	h, _ := Hash("correct horse battery staple")
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=1,p=4$") {
		t.Fatalf("unexpected hash format: %s", h)
	}
}

func TestValidate(t *testing.T) {
	if err := Validate(strings.Repeat("a", MinPasswordLength-1)); err == nil {
		t.Error("short password accepted")
	}
	if err := Validate(strings.Repeat("a", MinPasswordLength)); err != nil {
		t.Errorf("minimum-length password rejected: %v", err)
	}
	// A megabyte password must not be hashed — that is free CPU burn.
	if err := Validate(strings.Repeat("a", MaxPasswordLength+1)); err == nil {
		t.Error("oversized password accepted")
	}
	// Length is counted in runes, not bytes: emoji are one character each.
	if err := Validate(strings.Repeat("🔐", MinPasswordLength)); err != nil {
		t.Errorf("multi-byte password of valid length rejected: %v", err)
	}
}

func TestVerify_RejectsMalformedHashes(t *testing.T) {
	for name, h := range map[string]string{
		"empty":          "",
		"not phc":        "hunter2",
		"wrong algo":     "$bcrypt$v=19$m=65536,t=1,p=4$c2FsdA$a2V5",
		"truncated":      "$argon2id$v=19$m=65536,t=1,p=4$c2FsdA",
		"bad base64":     "$argon2id$v=19$m=65536,t=1,p=4$!!!!$!!!!",
		"future version": "$argon2id$v=99$m=65536,t=1,p=4$c2FsdA$a2V5",
	} {
		if err := Verify("anything", h); err == nil {
			t.Errorf("%s: malformed hash accepted", name)
		}
	}
}

// VerifyDummy exists so an unknown account costs the same as a wrong password.
// If it were a no-op, login timing would leak which emails are registered.
func TestVerifyDummy_DoesRealWork(t *testing.T) {
	if dummyHash == "" {
		t.Fatal("dummy hash not initialised")
	}
	if !strings.HasPrefix(dummyHash, "$argon2id$") {
		t.Fatal("dummy hash is not a real argon2id hash")
	}
}
