// Package store is the Audit service's PostgreSQL persistence.
//
// It is append only by construction: there is no update and no delete anywhere
// in it, and the service exposes neither. A record that can be edited is a
// record nobody has to believe, and the whole reason this service exists is to
// be believed.
//
// It has no outbox. Audit announces nothing, because an event saying "something
// was recorded" would be an event the trail then records, and the trail would
// grow by writing about itself.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/audit/migrations"
)

var ErrNotFound = errors.New("store: not found")

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
	// The handled-events table, because this service consumes the bus. No
	// outbox: see the package comment.
	return bus.Migrate(ctx, s.pool)
}

func (s *Store) Pool() *pg.Pool { return s.pool }

// Entry is one line of the trail.
type Entry struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	EventID        *uuid.UUID
	Action         string
	ActorKind      string
	ActorID        string
	ActorLabel     string
	SubjectType    string
	SubjectID      string
	Summary        string
	Detail         json.RawMessage
	Source         string
	OccurredAt     time.Time
	RecordedAt     time.Time
	IdempotencyKey string
}

const entryCols = `id, tenant_id, event_id, action, actor_kind, actor_id, actor_label,
	subject_type, subject_id, summary, detail, source, occurred_at, recorded_at,
	idempotency_key`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(&e.ID, &e.TenantID, &e.EventID, &e.Action, &e.ActorKind,
		&e.ActorID, &e.ActorLabel, &e.SubjectType, &e.SubjectID, &e.Summary,
		&e.Detail, &e.Source, &e.OccurredAt, &e.RecordedAt, &e.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	return e, err
}

// Append writes one line, and does nothing if that line is already there.
//
// The two unique indexes are what make it safe to call twice: once on the event
// ID, for redelivery, and once on an idempotency key, for a retried saga step.
// It returns the row either way, so a caller cannot tell the difference and
// does not have to care.
func (s *Store) Append(ctx context.Context, e Entry) (Entry, error) {
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	if e.OccurredAt.IsZero() {
		e.OccurredAt = time.Now()
	}
	out, err := scanEntry(s.pool.QueryRow(ctx, `
		INSERT INTO entries (id, tenant_id, event_id, action, actor_kind, actor_id,
		                     actor_label, subject_type, subject_id, summary, detail,
		                     source, occurred_at, idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT DO NOTHING
		RETURNING `+entryCols,
		e.ID, e.TenantID, e.EventID, e.Action, e.ActorKind, e.ActorID, e.ActorLabel,
		e.SubjectType, e.SubjectID, e.Summary, e.Detail, e.Source, e.OccurredAt,
		e.IdempotencyKey))
	if err == nil {
		return out, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Entry{}, err
	}
	// Already recorded. Find which of the two keys matched and answer with the
	// line that is there.
	if e.EventID != nil {
		return scanEntry(s.pool.QueryRow(ctx,
			`SELECT `+entryCols+` FROM entries WHERE tenant_id = $1 AND event_id = $2`,
			e.TenantID, e.EventID))
	}
	return scanEntry(s.pool.QueryRow(ctx,
		`SELECT `+entryCols+` FROM entries WHERE tenant_id = $1 AND idempotency_key = $2`,
		e.TenantID, e.IdempotencyKey))
}

func (s *Store) Entry(ctx context.Context, tenantID, id uuid.UUID) (Entry, error) {
	return scanEntry(s.pool.QueryRow(ctx,
		`SELECT `+entryCols+` FROM entries WHERE tenant_id = $1 AND id = $2`, tenantID, id))
}

// Filter narrows a listing. Every field is optional.
type Filter struct {
	Action    string
	ActorKind string
	ActorID   string
	From      *time.Time
	To        *time.Time
	Limit     int
	// Keyset over (occurred_at, id). The trail grows at the head while it is
	// being read, and an offset would show the same line twice.
	BeforeAt *time.Time
	BeforeID *uuid.UUID
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Entry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+entryCols+` FROM entries
		WHERE tenant_id = $1
		  AND ($2 = '' OR action = $2)
		  AND ($3 = '' OR actor_kind = $3)
		  AND ($4 = '' OR actor_id = $4)
		  AND ($5::timestamptz IS NULL OR occurred_at >= $5)
		  AND ($6::timestamptz IS NULL OR occurred_at < $6)
		  AND ($7::timestamptz IS NULL OR (occurred_at, id) < ($7, $8))
		ORDER BY occurred_at DESC, id DESC
		LIMIT $9`,
		tenantID, f.Action, f.ActorKind, f.ActorID, f.From, f.To,
		f.BeforeAt, f.BeforeID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collect(rows)
}

// Trail is everything recorded about one thing, oldest first. A trail read
// backwards is a story told backwards.
func (s *Store) Trail(ctx context.Context, tenantID uuid.UUID, subjectType, subjectID string, limit int) ([]Entry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+entryCols+` FROM entries
		WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
		ORDER BY occurred_at, id
		LIMIT $4`, tenantID, subjectType, subjectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collect(rows)
}

func collect(rows pgx.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
