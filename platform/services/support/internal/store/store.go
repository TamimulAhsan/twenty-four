// Package store is the Support service's PostgreSQL persistence.
//
// The row is the grant. Nobody approves it, so it is written live, and what it
// carries is the expiry and the revocation: nothing is readable after its
// expiry, and nothing is readable once a merchant has stopped it. Every state
// change is a conditional update rather than a read followed by a write, so two
// clicks on a stale console tab cannot both succeed.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/support/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrNotUsable is a session begun from a grant that is revoked or expired.
	ErrNotUsable = errors.New("store: that grant cannot be used")
)

type Store struct{ pool *pg.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pg.Open(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	if err := s.pool.Migrate(ctx, migrations.FS); err != nil {
		return err
	}
	return outbox.Migrate(ctx, s.pool)
}

func (s *Store) Pool() *pg.Pool { return s.pool }

type Request struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	SpecialistID   uuid.UUID
	SpecialistName string
	Reason         string
	Scope          string
	State          string
	DecidedBy      *uuid.UUID
	DecidedAt      *time.Time
	DecisionNote   string
	ExpiresAt      *time.Time
	CreatedAt      time.Time
}

const requestCols = `id, tenant_id, specialist_id, specialist_name, reason, scope,
	state, decided_by, decided_at, decision_note, expires_at, created_at`

func scanRequest(row pgx.Row) (Request, error) {
	var r Request
	err := row.Scan(&r.ID, &r.TenantID, &r.SpecialistID, &r.SpecialistName,
		&r.Reason, &r.Scope, &r.State, &r.DecidedBy, &r.DecidedAt,
		&r.DecisionNote, &r.ExpiresAt, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	return r, err
}

// Usable reports whether a grant can still be turned into a session. Expiry is
// checked here rather than by a sweeper, because a grant that is only expired
// once something notices is a grant that works until something notices.
func (r Request) Usable(now time.Time) bool {
	return r.State == "approved" && r.ExpiresAt != nil && r.ExpiresAt.After(now)
}

// Start creates a live grant and a session on it, in one transaction.
//
// The grant exists in the approved state from the moment it is written, because
// nobody is asked. It is still a row rather than nothing: the expiry lives on
// it, the revoke acts on it, and the trail reads from it, so removing it would
// mean removing the three things that remain.
func (s *Store) Start(ctx context.Context, r Request, ttl time.Duration) (Request, Session, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	expires := time.Now().Add(ttl)
	var grant Request
	var sess Session
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		grant, err = scanRequest(tx.QueryRow(ctx, `
			INSERT INTO access_requests (id, tenant_id, specialist_id, specialist_name,
			                             reason, scope, state, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,'approved',$7)
			RETURNING `+requestCols,
			r.ID, r.TenantID, r.SpecialistID, r.SpecialistName, r.Reason, r.Scope, expires))
		if err != nil {
			return err
		}
		sessionID := uuid.New()
		if _, err := tx.Exec(ctx, `
			INSERT INTO sessions (id, tenant_id, request_id, specialist_id, scope, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			sessionID, r.TenantID, r.ID, r.SpecialistID, r.Scope, expires); err != nil {
			return err
		}
		sess, err = scanSession(tx.QueryRow(ctx, `
			SELECT `+sessionCols+` FROM sessions s
			JOIN access_requests r ON r.id = s.request_id
			WHERE s.id = $1`, sessionID))
		if err != nil {
			return err
		}
		// Announced, which is what puts it in the audit trail. Nothing prompts
		// the merchant, and the record is still theirs to read.
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: r.TenantID, Topic: "support.session_started", Key: sessionID.String(),
			Payload: map[string]any{
				"session_id": sessionID, "request_id": r.ID,
				"specialist_id": r.SpecialistID, "specialist_name": r.SpecialistName,
				"reason": r.Reason, "scope": r.Scope, "expires_at": expires,
			},
		})
		return err
	})
	return grant, sess, err
}

// Revoke takes an approved grant back and ends every session under it.
//
// Ending the sessions is the point. A revocation that left a live session
// running would be a revocation in name only, and the merchant clicking it
// believes they have stopped somebody reading their books.
func (s *Store) Revoke(ctx context.Context, tenantID, id uuid.UUID) (Request, int, error) {
	var out Request
	var ended int
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scanRequest(tx.QueryRow(ctx, `
			UPDATE access_requests SET state = 'revoked'
			WHERE tenant_id = $1 AND id = $2 AND state = 'approved'
			RETURNING `+requestCols, tenantID, id))
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE sessions SET ended_at = now()
			WHERE tenant_id = $1 AND request_id = $2 AND ended_at IS NULL`,
			tenantID, id)
		if err != nil {
			return err
		}
		ended = int(tag.RowsAffected())
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "support.revoked", Key: id.String(),
			Payload: map[string]any{
				"request_id": id, "specialist_id": out.SpecialistID,
				"sessions_ended": ended,
			},
		})
		return err
	})
	return out, ended, err
}

func (s *Store) Request(ctx context.Context, tenantID, id uuid.UUID) (Request, error) {
	return scanRequest(s.pool.QueryRow(ctx,
		`SELECT `+requestCols+` FROM access_requests WHERE tenant_id = $1 AND id = $2`,
		tenantID, id))
}

func (s *Store) ListRequests(ctx context.Context, tenantID uuid.UUID, state string, limit int) ([]Request, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+requestCols+` FROM access_requests
		WHERE tenant_id = $1 AND ($2 = '' OR state = $2)
		ORDER BY created_at DESC LIMIT $3`, tenantID, state, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Request
	for rows.Next() {
		r, err := scanRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type Session struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	RequestID      uuid.UUID
	SpecialistID   uuid.UUID
	SpecialistName string
	Scope          string
	StartedAt      time.Time
	ExpiresAt      time.Time
	EndedAt        *time.Time
}

// Active reports whether a session is live right now, which is not the same as
// whether anybody ended it.
func (s Session) Active(now time.Time) bool {
	return s.EndedAt == nil && s.ExpiresAt.After(now)
}

const sessionCols = `s.id, s.tenant_id, s.request_id, s.specialist_id,
	r.specialist_name, s.scope, s.started_at, s.expires_at, s.ended_at`

func scanSession(row pgx.Row) (Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.TenantID, &s.RequestID, &s.SpecialistID,
		&s.SpecialistName, &s.Scope, &s.StartedAt, &s.ExpiresAt, &s.EndedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return s, err
}

func (s *Store) End(ctx context.Context, tenantID, id uuid.UUID) (Session, error) {
	var out Session
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		// Two statements rather than one, because the specialist's name lives
		// on the request and RETURNING cannot reach across the join.
		// coalesce, so ending an already-ended session is not an error: a
		// console tab closing twice is normal.
		tag, err := tx.Exec(ctx, `
			UPDATE sessions SET ended_at = coalesce(ended_at, now())
			WHERE tenant_id = $1 AND id = $2`, tenantID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		out, err = scanSession(tx.QueryRow(ctx, `
			SELECT `+sessionCols+` FROM sessions s
			JOIN access_requests r ON r.id = s.request_id
			WHERE s.id = $1`, id))
		if err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "support.session_ended", Key: id.String(),
			Payload: map[string]any{
				"session_id": id, "specialist_id": out.SpecialistID,
				"duration_seconds": int64(time.Since(out.StartedAt).Seconds()),
			},
		})
		return err
	})
	return out, err
}

func (s *Store) Session(ctx context.Context, id uuid.UUID) (Session, error) {
	return scanSession(s.pool.QueryRow(ctx, `
		SELECT `+sessionCols+` FROM sessions s
		JOIN access_requests r ON r.id = s.request_id
		WHERE s.id = $1`, id))
}

func (s *Store) ListSessions(ctx context.Context, tenantID uuid.UUID, activeOnly bool, limit int) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+sessionCols+` FROM sessions s
		JOIN access_requests r ON r.id = s.request_id
		WHERE s.tenant_id = $1
		  AND (NOT $2 OR (s.ended_at IS NULL AND s.expires_at > now()))
		ORDER BY s.started_at DESC LIMIT $3`, tenantID, activeOnly, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

// ExpireStale marks grants past their expiry, so a listing reads as expired
// rather than as approved-but-not-working.
//
// It changes nothing about what is permitted: Usable already checks the clock,
// and access stops at the expiry whether or not this has run. It exists so the
// screen tells the truth.
func (s *Store) ExpireStale(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE access_requests SET state = 'expired'
		WHERE state = 'approved' AND expires_at <= now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// RequestByID reads a grant without a tenant, because the admin plane caller
// beginning a session does not have the merchant's tenant in its context: that
// is what the grant is for. Every use of it re-checks that the grant belongs to
// the specialist asking.
func (s *Store) RequestByID(ctx context.Context, id uuid.UUID) (Request, error) {
	return scanRequest(s.pool.QueryRow(ctx,
		`SELECT `+requestCols+` FROM access_requests WHERE id = $1`, id))
}
