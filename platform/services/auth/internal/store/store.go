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

// UserByEmail looks up within a plane, since the same address may exist in both.
func (s *Store) UserByEmail(ctx context.Context, email, plane string) (User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userCols+` FROM users WHERE lower(email) = lower($1) AND plane = $2`, email, plane))
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

func (s *Store) MarkEmailVerified(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET email_verified = TRUE, status = 'active' WHERE id = $1`, id)
	return err
}

func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr) && pgErr.SQLState() == "23505"
}
