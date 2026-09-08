// Package store is the Auth service's PostgreSQL persistence.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/twentyfour/platform/services/auth/migrations"
)

var (
	ErrNotFound      = errors.New("store: not found")
	ErrEmailTaken    = errors.New("store: email already registered")
	ErrSessionClosed = errors.New("store: session revoked or expired")
)

type Store struct{ pool *pgxpool.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDB(*s.pool.Config().ConnConfig)
	defer db.Close()
	return goose.UpContext(ctx, db, ".")
}

type User struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	Email          string
	DisplayName    string
	PasswordHash   string
	Status         string
	Plane          string
	EmailVerified  bool
	TOTPSecret     *string
	FailedAttempts int
	LockedUntil    *time.Time
	CreatedAt      time.Time
	LastLoginAt    *time.Time
}

const userCols = `id, tenant_id, email, display_name, password_hash, status, plane,
                  email_verified, totp_secret, failed_attempts, locked_until, created_at, last_login_at`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.TenantID, &u.Email, &u.DisplayName, &u.PasswordHash,
		&u.Status, &u.Plane, &u.EmailVerified, &u.TOTPSecret,
		&u.FailedAttempts, &u.LockedUntil, &u.CreatedAt, &u.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) CreateUser(ctx context.Context, u User) (User, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (id, tenant_id, email, display_name, password_hash, status, plane, email_verified)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING `+userCols,
		u.ID, u.TenantID, u.Email, u.DisplayName, u.PasswordHash, u.Status, u.Plane, u.EmailVerified).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.DisplayName, &u.PasswordHash, &u.Status,
			&u.Plane, &u.EmailVerified, &u.TOTPSecret, &u.FailedAttempts,
			&u.LockedUntil, &u.CreatedAt, &u.LastLoginAt)
	if err != nil && isUniqueViolation(err) {
		return User{}, ErrEmailTaken
	}
	return u, err
}

// UserByEmail finds an account by address alone.
//
// There is no plane argument because an address names one account: the unique
// index on lower(email) is what lets a single sign-in form resolve where
// somebody belongs instead of asking them.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE lower(email) = lower($1)`, email))
}

func (s *Store) UserByID(ctx context.Context, id uuid.UUID) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id))
}

func (s *Store) ListUsers(ctx context.Context, tenantID uuid.UUID, includeDeactivated bool) ([]User, int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+userCols+` FROM users
		WHERE tenant_id = $1 AND ($2 OR status <> 'deactivated')
		ORDER BY created_at`, tenantID, includeDeactivated)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []User
	active := 0
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		if u.Status == "active" {
			active++
		}
		out = append(out, u)
	}
	return out, active, rows.Err()
}

// AcceptInvite is one statement so a half-accepted invitation cannot exist: the
// password, the status and the verification all land together or none do.
func (s *Store) AcceptInvite(ctx context.Context, id uuid.UUID, hash string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET password_hash = $2, status = 'active', email_verified = TRUE,
		                 failed_attempts = 0, locked_until = NULL
		WHERE id = $1 AND status = 'invited'
		RETURNING `+userCols, id, hash))
}

// RecordLoginFailure increments the counter and locks the account once the
// threshold is hit, so an online guessing attack becomes impractical.
func (s *Store) RecordLoginFailure(ctx context.Context, id uuid.UUID, maxAttempts int, lockFor time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET
			failed_attempts = failed_attempts + 1,
			locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + $3::interval ELSE locked_until END,
			status = CASE WHEN failed_attempts + 1 >= $2 THEN 'locked' ELSE status END
		WHERE id = $1`, id, maxAttempts, lockFor.String())
	return err
}

func (s *Store) RecordLoginSuccess(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET failed_attempts = 0, locked_until = NULL,
		                 last_login_at = now(),
		                 status = CASE WHEN status = 'locked' THEN 'active' ELSE status END
		WHERE id = $1`, id)
	return err
}

func (s *Store) SetPasswordHash(ctx context.Context, id uuid.UUID, hash string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1`, id, hash)
	return err
}

// ReactivateUser brings a deactivated account back. It does not restore
// sessions: those were revoked when the account was switched off, and reviving
// them would mean a browser left open in a back office starts working again
// without anyone signing in.
func (s *Store) ReactivateUser(ctx context.Context, tenantID, id uuid.UUID) (User, error) {
	return scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		SET status = CASE WHEN email_verified THEN 'active' ELSE 'invited' END,
		    failed_attempts = 0, locked_until = NULL
		WHERE id = $2 AND tenant_id = $1 AND status = 'deactivated'
		RETURNING `+userCols, tenantID, id))
}

// DeleteUser removes an account outright, and only ever an invitation that was
// never accepted.
//
// Anyone who has signed in has their name on orders and documents that must
// stay resolvable, so those accounts are deactivated instead. The status check
// is in the WHERE clause rather than in a caller, because a delete that depends
// on a caller remembering to check is a delete that will eventually not.
func (s *Store) DeleteUser(ctx context.Context, tenantID, id uuid.UUID) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM users
		WHERE id = $2 AND tenant_id = $1 AND status = 'invited' AND last_login_at IS NULL`,
		tenantID, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *Store) DeactivateUser(ctx context.Context, tenantID, id uuid.UUID) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET status = 'deactivated' WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return false, err
	}
	// Deactivating must also end every live session, or the user keeps working
	// until their token happens to expire.
	if tag.RowsAffected() > 0 {
		_, err = s.pool.Exec(ctx,
			`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, id)
	}
	return tag.RowsAffected() > 0, err
}

type Session struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TenantID  uuid.UUID
	Plane     string
	IssuedAt  time.Time
	ExpiresAt time.Time
	UserAgent string
	IP        string
}

func (s *Store) CreateSession(ctx context.Context, sess Session) (Session, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, tenant_id, plane, expires_at, user_agent, ip)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING issued_at`,
		sess.ID, sess.UserID, sess.TenantID, sess.Plane, sess.ExpiresAt, sess.UserAgent, sess.IP).
		Scan(&sess.IssuedAt)
	return sess, err
}

// LiveSession returns the session only if it is neither revoked nor expired.
// This is what makes logout take effect immediately.
func (s *Store) LiveSession(ctx context.Context, id uuid.UUID) (Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, tenant_id, plane, issued_at, expires_at
		FROM sessions
		WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, id).
		Scan(&sess.ID, &sess.UserID, &sess.TenantID, &sess.Plane, &sess.IssuedAt, &sess.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionClosed
	}
	return sess, err
}

func (s *Store) RevokeSession(ctx context.Context, id uuid.UUID) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// HashToken is how one-time tokens are stored: the plaintext goes to the user,
// only the digest is kept, so a database leak yields nothing usable.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateOneTimeToken(ctx context.Context, userID uuid.UUID, purpose, raw string, ttl time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO one_time_tokens (token_hash, user_id, purpose, expires_at)
		VALUES ($1,$2,$3, now() + $4::interval)`,
		HashToken(raw), userID, purpose, ttl.String())
	return err
}

// ConsumeOneTimeToken atomically marks the token used and returns its owner.
// Doing it in one statement is what stops the same reset link working twice.
func (s *Store) ConsumeOneTimeToken(ctx context.Context, purpose, raw string) (uuid.UUID, error) {
	var userID uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE one_time_tokens SET used_at = now()
		WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id`, HashToken(raw), purpose).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	return userID, err
}

// --- plane handoff ----------------------------------------------------------

// CreateHandoff stores a one-time code standing for a live session.
//
// It stores the session, not a token. Redeeming issues a fresh token against
// that session, so nothing here is a credential at rest.
func (s *Store) CreateHandoff(ctx context.Context, userID, sessionID uuid.UUID, raw, ip string, ttl time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO one_time_tokens (token_hash, user_id, purpose, expires_at, session_id, issued_ip)
		VALUES ($1,$2,'plane_handoff', now() + $3::interval, $4, $5)`,
		HashToken(raw), userID, ttl.String(), sessionID, ip)
	return err
}

// RedeemHandoff consumes a code and returns the session it stood for.
//
// One statement, like every other one-time token here, because two statements
// is a window in which the same code redeems twice. The address is part of the
// match rather than a check afterwards: a code that arrives from somewhere else
// finds no row, and finding no row and being refused are the same answer.
func (s *Store) RedeemHandoff(ctx context.Context, raw, ip string) (uuid.UUID, error) {
	var sessionID uuid.UUID
	err := s.pool.QueryRow(ctx, `
		UPDATE one_time_tokens SET used_at = now()
		WHERE token_hash = $1 AND purpose = 'plane_handoff'
		  AND used_at IS NULL AND expires_at > now() AND issued_ip = $2
		RETURNING session_id`, HashToken(raw), ip).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	return sessionID, err
}

func (s *Store) MarkEmailVerified(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET email_verified = TRUE, status = 'active' WHERE id = $1`, id)
	return err
}

// --- merchant codes ---------------------------------------------------------

// ErrNoMerchantCode means the tenant has no code. Every tenant created through
// Signup gets one, so this is either a tenant from before the column existed or
// a tenant ID that was never real.
var ErrNoMerchantCode = errors.New("store: tenant has no merchant code")

// AssignMerchantCode gives a tenant its permanent code, or returns the one it
// already has.
//
// gen supplies candidates. The loop retries on a unique violation rather than
// checking whether a code is free first: a check followed by an insert is a
// race between two concurrent signups, and the constraint already answers the
// question authoritatively. At 32^6 codes a collision is vanishingly rare, so
// the retry is a correctness measure rather than a performance one.
func (s *Store) AssignMerchantCode(ctx context.Context, tenantID uuid.UUID, gen func() (string, error)) (string, error) {
	const attempts = 8
	for i := 0; i < attempts; i++ {
		code, err := gen()
		if err != nil {
			return "", err
		}
		var assigned string
		err = s.pool.QueryRow(ctx, `
			INSERT INTO merchant_codes (tenant_id, code) VALUES ($1,$2)
			ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
			RETURNING code`, tenantID, code).Scan(&assigned)
		if err == nil {
			return assigned, nil
		}
		if !isUniqueViolation(err) {
			return "", err
		}
		// Another tenant holds that code. Draw again.
	}
	return "", fmt.Errorf("store: could not find a free merchant code in %d attempts", attempts)
}

// MerchantCode reads a tenant's code. Released tenants still resolve: their
// documents are still out there and still have to be explicable.
func (s *Store) MerchantCode(ctx context.Context, tenantID uuid.UUID) (string, time.Time, error) {
	var code string
	var at time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT code, assigned_at FROM merchant_codes WHERE tenant_id = $1`, tenantID).Scan(&code, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, ErrNoMerchantCode
	}
	return code, at, err
}

// MerchantCodes reads a page of codes in one query.
//
// One statement for a whole directory page, rather than one per row. A tenant
// with no code is absent from the map: the caller renders nothing for it, which
// is the truth, and a zero value would read as a code.
func (s *Store) MerchantCodes(ctx context.Context, tenantIDs []uuid.UUID) (map[uuid.UUID]string, error) {
	out := make(map[uuid.UUID]string, len(tenantIDs))
	if len(tenantIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT tenant_id, code FROM merchant_codes WHERE tenant_id = ANY($1)`, tenantIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var code string
		if err := rows.Scan(&id, &code); err != nil {
			return nil, err
		}
		out[id] = code
	}
	return out, rows.Err()
}

// TenantsWithoutMerchantCode lists tenants that predate the merchant_codes
// table. Every tenant created through Signup gets a code, so this is only ever
// the accounts that existed before the column did.
func (s *Store) TenantsWithoutMerchantCode(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT u.tenant_id FROM users u
		LEFT JOIN merchant_codes m ON m.tenant_id = u.tenant_id
		WHERE m.tenant_id IS NULL AND u.plane = 'tenant'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// TenantByMerchantCode is the reverse lookup, for support: someone reads a code
// off an invoice and needs to know whose it is.
func (s *Store) TenantByMerchantCode(ctx context.Context, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT tenant_id FROM merchant_codes WHERE code = $1`, code).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoMerchantCode
	}
	return id, err
}

func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr) && pgErr.SQLState() == "23505"
}
