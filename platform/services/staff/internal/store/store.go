// Package store is the Staff service's PostgreSQL persistence.
//
// It is deliberately small. Staff holds the employment view of a person; the
// login belongs to Auth and the role belongs to RBAC, and duplicating either
// here would create a second place for them to be wrong.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/staff/migrations"
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
	return outbox.Migrate(ctx, s.pool)
}

type Member struct {
	TenantID  uuid.UUID
	UserID    uuid.UUID
	Colour    string
	CreatedAt time.Time
}

// Palette is the set of till colours, in assignment order.
//
// Chosen to stay distinguishable next to each other on a busy screen, and to
// stay distinguishable to the roughly one person in twelve who cannot tell red
// from green. A rota where two people look the same is a rota that gets misread
// at the exact moment nobody has time to look twice.
var Palette = []string{
	"#2563eb", // blue
	"#d97706", // amber
	"#7c3aed", // violet
	"#0d9488", // teal
	"#db2777", // pink
	"#65a30d", // lime
	"#0284c7", // sky
	"#b45309", // bronze
}

// Upsert records the member and, in the same transaction, the event.
//
// Same transaction because CRM Sync will provision a Twenty workspace member
// from staff.added. An event that escapes without its row, or a row without its
// event, is a person who exists in one system and not the other.
func (s *Store) Upsert(ctx context.Context, m Member, topic string, payload map[string]any) (Member, error) {
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO members (tenant_id, user_id, colour)
			VALUES ($1,$2,$3)
			ON CONFLICT (tenant_id, user_id) DO UPDATE SET updated_at = now()
			RETURNING tenant_id, user_id, colour, created_at`,
			m.TenantID, m.UserID, m.Colour).
			Scan(&m.TenantID, &m.UserID, &m.Colour, &m.CreatedAt)
		if err != nil {
			return err
		}
		if topic == "" {
			return nil
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: m.TenantID, Topic: topic,
			// Keyed on the person, so their own events stay in order relative
			// to each other. Added then removed must never arrive reversed.
			Key: m.UserID.String(), Payload: payload,
		})
		return err
	})
	return m, err
}

// Announce records an event with no accompanying row change, for things that
// happened entirely in Auth or RBAC.
func (s *Store) Announce(ctx context.Context, tenantID, userID uuid.UUID, topic string, payload map[string]any) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		_, err := outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: topic, Key: userID.String(), Payload: payload,
		})
		return err
	})
}

func (s *Store) Delete(ctx context.Context, tenantID, userID uuid.UUID, payload map[string]any) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`DELETE FROM members WHERE tenant_id = $1 AND user_id = $2`, tenantID, userID); err != nil {
			return err
		}
		_, err := outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "staff.removed",
			Key: userID.String(), Payload: payload,
		})
		return err
	})
}

// Colours returns every member's colour, so a list can be assembled in one
// query rather than one per person.
func (s *Store) Colours(ctx context.Context, tenantID uuid.UUID) (map[uuid.UUID]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT user_id, colour FROM members WHERE tenant_id = $1`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uuid.UUID]string{}
	for rows.Next() {
		var id uuid.UUID
		var colour string
		if err := rows.Scan(&id, &colour); err != nil {
			return nil, err
		}
		out[id] = colour
	}
	return out, rows.Err()
}

// NextColour picks the least-used colour in the palette, so a small team gets
// eight distinct ones before any repeats.
func (s *Store) NextColour(ctx context.Context, tenantID uuid.UUID) (string, error) {
	taken, err := s.Colours(ctx, tenantID)
	if err != nil {
		return Palette[0], err
	}
	count := map[string]int{}
	for _, c := range taken {
		count[c]++
	}
	best, bestN := Palette[0], -1
	for _, c := range Palette {
		if n := count[c]; bestN < 0 || n < bestN {
			best, bestN = c, n
		}
	}
	return best, nil
}
