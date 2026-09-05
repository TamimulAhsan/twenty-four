// Package credential handles passwords. It uses argon2id via the standard
// x/crypto implementation — nothing here invents cryptography, it only wires
// well-reviewed pieces together correctly.
package credential

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Parameters follow the OWASP argon2id guidance: memory is the dominant cost,
// so prefer raising it over raising iterations. These are per-hash costs paid
// on login, so they trade directly against login latency.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)

// Minimum length only. Composition rules ("must contain a symbol") push people
// toward predictable substitutions and measurably reduce entropy, so length is
// the requirement and nothing else is.
const DefaultMinPasswordLength = 12

// MinPasswordLength is the value actually enforced. It is a variable rather
// than a constant so local development can lower it for convenience via
// SetMinPasswordLength. Nothing else may change it, and production never calls
// that function, so the default stands wherever a real password is set.
var MinPasswordLength = DefaultMinPasswordLength

// SetMinPasswordLength lowers or raises the minimum. Development only: a short
// minimum in production is an invitation to guess.
func SetMinPasswordLength(n int) {
	if n < 1 {
		n = 1
	}
	MinPasswordLength = n
	ErrTooShort = fmt.Errorf("password must be at least %d characters", n)
}

// MaxPasswordLength caps the input so a huge password cannot be used to burn
// CPU in the hash — a cheap denial-of-service otherwise.
const MaxPasswordLength = 1024

var (
	ErrTooShort     = fmt.Errorf("password must be at least %d characters", DefaultMinPasswordLength)
	ErrTooLong      = fmt.Errorf("password must be at most %d characters", MaxPasswordLength)
	ErrBadHash      = errors.New("credential: malformed stored hash")
	ErrMismatch     = errors.New("credential: password does not match")
	ErrIncompatible = errors.New("credential: unsupported hash version")
)

// Validate checks a candidate password before it is ever hashed.
func Validate(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < MinPasswordLength {
		return ErrTooShort
	}
	if n > MaxPasswordLength {
		return ErrTooLong
	}
	return nil
}

// Hash returns a PHC-format string that carries its own parameters, so the
// cost can be raised later without invalidating existing hashes.
func Hash(pw string) (string, error) {
	if err := Validate(pw); err != nil {
		return "", err
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("credential: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify compares a password against a stored hash in constant time.
func Verify(pw, encoded string) error {
	p, salt, want, err := decode(encoded)
	if err != nil {
		return err
	}
	got := argon2.IDKey([]byte(pw), salt, p.time, p.memory, p.threads, uint32(len(want)))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}

// dummyHash is a real argon2id hash of a random value, used to spend the same
// CPU when an account does not exist. Without it, login timing tells an
// attacker which email addresses are registered.
var dummyHash string

func init() {
	h, err := Hash(strings.Repeat("x", DefaultMinPasswordLength))
	if err != nil {
		panic("credential: cannot build dummy hash: " + err.Error())
	}
	dummyHash = h
}

// VerifyDummy burns equivalent work for a non-existent account so that the
// "unknown user" and "wrong password" paths take the same time.
func VerifyDummy(pw string) {
	_ = Verify(pw, dummyHash)
}

type params struct {
	memory  uint32
	time    uint32
	threads uint8
}

func decode(encoded string) (params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return params{}, nil, nil, ErrBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return params{}, nil, nil, ErrBadHash
	}
	if version != argon2.Version {
		return params{}, nil, nil, ErrIncompatible
	}
	var p params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return params{}, nil, nil, ErrBadHash
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil {
		return params{}, nil, nil, ErrBadHash
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil {
		return params{}, nil, nil, ErrBadHash
	}
	return p, salt, key, nil
}
