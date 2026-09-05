// Package token issues and reads session tokens.
//
// PASETO v4.local rather than JWT: PASETO has no algorithm field, so the
// "alg: none" and RS256→HS256 confusion attacks that plague JWT simply cannot
// be expressed. The token is encrypted, not merely signed, so its contents are
// opaque to the holder as well as tamper-evident.
//
// A token is only half the answer. It proves what was true when it was issued;
// VerifyToken also checks the session is still live, so revocation is immediate
// rather than waiting for expiry.
package token

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"aidanwoods.dev/go-paseto"
)

var (
	ErrInvalid = errors.New("token: invalid")
	ErrExpired = errors.New("token: expired")
)

// Claims are the minimum needed to identify the caller. Deliberately no roles
// or permissions: those change, and a token that carried them would grant
// access after the role was revoked.
type Claims struct {
	UserID    string
	TenantID  string
	SessionID string
	Plane     string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

type Issuer struct {
	key paseto.V4SymmetricKey
	ttl time.Duration
}

// NewIssuer takes a 32-byte key as hex. In production this comes from OpenBao;
// in dev it is generated at boot, which invalidates sessions on restart.
func NewIssuer(hexKey string, ttl time.Duration) (*Issuer, error) {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("token: key must be hex: %w", err)
	}
	key, err := paseto.V4SymmetricKeyFromBytes(raw)
	if err != nil {
		return nil, fmt.Errorf("token: key must be 32 bytes: %w", err)
	}
	return &Issuer{key: key, ttl: ttl}, nil
}

// GenerateKey returns a fresh hex key, for dev and for key rotation.
func GenerateKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (i *Issuer) TTL() time.Duration { return i.ttl }

func (i *Issuer) Issue(c Claims) (string, time.Time, error) {
	now := time.Now().UTC()
	exp := now.Add(i.ttl)

	t := paseto.NewToken()
	t.SetIssuedAt(now)
	t.SetNotBefore(now)
	t.SetExpiration(exp)
	t.SetString("uid", c.UserID)
	t.SetString("tid", c.TenantID)
	t.SetString("sid", c.SessionID)
	t.SetString("pln", c.Plane)

	return t.V4Encrypt(i.key, nil), exp, nil
}

// Parse decrypts and validates the token's own claims. It does not know
// whether the session behind it still exists — the caller checks that.
func (i *Issuer) Parse(s string) (Claims, error) {
	p := paseto.NewParser()
	p.AddRule(paseto.NotExpired(), paseto.ValidAt(time.Now()))

	t, err := p.ParseV4Local(i.key, s, nil)
	if err != nil {
		// Distinguish expiry so the caller can ask for a refresh rather than
		// treating it as a forgery, but never leak more than that.
		if errors.Is(err, paseto.RuleError{}) || containsExpired(err) {
			return Claims{}, ErrExpired
		}
		return Claims{}, ErrInvalid
	}

	var c Claims
	if c.UserID, err = t.GetString("uid"); err != nil {
		return Claims{}, ErrInvalid
	}
	if c.TenantID, err = t.GetString("tid"); err != nil {
		return Claims{}, ErrInvalid
	}
	if c.SessionID, err = t.GetString("sid"); err != nil {
		return Claims{}, ErrInvalid
	}
	if c.Plane, err = t.GetString("pln"); err != nil {
		return Claims{}, ErrInvalid
	}
	if c.IssuedAt, err = t.GetIssuedAt(); err != nil {
		return Claims{}, ErrInvalid
	}
	if c.ExpiresAt, err = t.GetExpiration(); err != nil {
		return Claims{}, ErrInvalid
	}
	return c, nil
}

func containsExpired(err error) bool {
	return err != nil && (errors.Is(err, ErrExpired) ||
		// go-paseto reports rule failures as plain errors; match on text as a
		// last resort so an expired token is not reported as a forgery.
		contains(err.Error(), "expired"))
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
