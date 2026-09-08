// Package store is the Inventory service's PostgreSQL persistence.
//
// The shape to understand: every change is a move, and the level is updated in
// the same transaction as the move that caused it. Nothing writes a level
// directly. That is what makes the audit trail complete rather than
// best-effort, and it is what lets the outbox event be written atomically
// alongside both.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/inventory/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrOverRelease is a release or consume of more than is actually held.
	// Refusing it matters: reserved going negative would quietly make stock
	// available that is already promised to someone.
	ErrOverRelease = errors.New("store: more than is reserved")
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

// Migrate runs the service's own schema and then the shared outbox schema.
// They are versioned separately so a change to one never renumbers the other.
func (s *Store) Migrate(ctx context.Context) error {
	if err := s.pool.Migrate(ctx, migrations.FS); err != nil {
		return err
	}
	return outbox.Migrate(ctx, s.pool)
}

// Pool is exposed so the relay's stats query and tests can reach it. Nothing
// outside this service ever connects to this database.
func (s *Store) Pool() *pg.Pool { return s.pool }

type Level struct {
	TenantID  uuid.UUID
	ItemID    uuid.UUID
	OnHand    int32
	Reserved  int32
	Threshold *int32
	UpdatedAt time.Time
}

// Move is one recorded change.
type Move struct {
	TenantID       uuid.UUID
	ItemID         uuid.UUID
	Delta          int32
	Kind           string // adjustment, reserve, release, consume
	Reason         string
	ReferenceType  string
	ReferenceID    string
	ActorID        *uuid.UUID
	IdempotencyKey string
}

const levelCols = `tenant_id, item_id, on_hand, reserved, low_stock_threshold, updated_at`

func scanLevel(row pgx.Row) (Level, error) {
	var l Level
	err := row.Scan(&l.TenantID, &l.ItemID, &l.OnHand, &l.Reserved, &l.Threshold, &l.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Level{}, ErrNotFound
	}
	return l, err
}

func (s *Store) Level(ctx context.Context, tenantID, itemID uuid.UUID) (Level, error) {
	return scanLevel(s.pool.QueryRow(ctx,
		`SELECT `+levelCols+` FROM stock_levels WHERE tenant_id = $1 AND item_id = $2`,
		tenantID, itemID))
}

func (s *Store) ListLevels(ctx context.Context, tenantID uuid.UUID, lowOnly bool) ([]Level, error) {
	q := `SELECT ` + levelCols + ` FROM stock_levels WHERE tenant_id = $1`
	if lowOnly {
		q += ` AND low_stock_threshold IS NOT NULL AND on_hand <= low_stock_threshold`
	}
	q += ` ORDER BY item_id`
	rows, err := s.pool.Query(ctx, q, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Level
	for rows.Next() {
		l, err := scanLevel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) SetThreshold(ctx context.Context, tenantID, itemID uuid.UUID, threshold *int32) (Level, error) {
	return scanLevel(s.pool.QueryRow(ctx, `
		INSERT INTO stock_levels (tenant_id, item_id, low_stock_threshold)
		VALUES ($1,$2,$3)
		ON CONFLICT (tenant_id, item_id) DO UPDATE
		SET low_stock_threshold = EXCLUDED.low_stock_threshold,
		    -- Changing the threshold re-arms the warning. Lowering it below a
		    -- level that already warned should not keep warning; raising it
		    -- above should be able to warn again.
		    low_announced = FALSE,
		    updated_at = now()
		RETURNING `+levelCols, tenantID, itemID, threshold))
}

// Apply records a move, updates the level, and enqueues the events, all in one
// transaction.
//
// That atomicity is the whole design. A move without a level update is a
// number that drifts; a level update without an event is a warning that never
// reaches anyone; an event without the move is a warning about something that
// did not happen.
//
// It returns the resulting level, and whether this move is a repeat of one
// already applied under the same idempotency key.
func (s *Store) Apply(ctx context.Context, m Move) (Level, bool, error) {
	var out Level
	var repeat bool

	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		// The idempotency check is an insert that may conflict, not a lookup
		// followed by an insert: two retries arriving at once would both pass
		// a lookup.
		var moveID uuid.UUID
		err := tx.QueryRow(ctx, `
			INSERT INTO stock_moves (id, tenant_id, item_id, delta, kind, reason,
			                         reference_type, reference_id, actor_id, idempotency_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key <> ''
			DO NOTHING
			RETURNING id`,
			uuid.New(), m.TenantID, m.ItemID, m.Delta, m.Kind, m.Reason,
			m.ReferenceType, m.ReferenceID, m.ActorID, m.IdempotencyKey).Scan(&moveID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Already applied. Return the level as it stands, which is what the
			// first attempt produced, and say nothing changed.
			repeat = true
			out, err = scanLevel(tx.QueryRow(ctx,
				`SELECT `+levelCols+` FROM stock_levels WHERE tenant_id = $1 AND item_id = $2`,
				m.TenantID, m.ItemID))
			return err
		}
		if err != nil {
			return fmt.Errorf("store: record move: %w", err)
		}

		// How a move changes the two counters. Reserving moves stock from
		// available to held without changing what is physically there;
		// consuming a reservation takes it off the shelf.
		var dOnHand, dReserved int32
		switch m.Kind {
		case "adjustment":
			dOnHand = m.Delta
		case "reserve":
			dReserved = m.Delta
		case "release":
			dReserved = -m.Delta
		case "consume":
			dOnHand, dReserved = -m.Delta, -m.Delta
		case "consume_unreserved":
			// A walk-in sale that was never held. Only the shelf changes.
			dOnHand = -m.Delta
		default:
			return fmt.Errorf("store: unknown move kind %q", m.Kind)
		}

		// Ensure the row exists, then move it. Two statements rather than one
		// upsert, because PostgreSQL evaluates CHECK constraints against the
		// tuple an INSERT proposes before it discovers the conflict and
		// switches to the update path. An upsert applying a delta of -2 would
		// therefore fail "reserved >= 0" on the proposed row even when the
		// resulting row is perfectly valid. Checking the final value is the
		// whole point of the constraint.
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_levels (tenant_id, item_id) VALUES ($1,$2)
			ON CONFLICT (tenant_id, item_id) DO NOTHING`, m.TenantID, m.ItemID); err != nil {
			return fmt.Errorf("store: ensure level: %w", err)
		}

		var wasLow bool
		err = tx.QueryRow(ctx, `
			UPDATE stock_levels
			SET on_hand = on_hand + $3, reserved = reserved + $4, updated_at = now()
			WHERE tenant_id = $1 AND item_id = $2
			RETURNING `+levelCols+`, low_announced`,
			m.TenantID, m.ItemID, dOnHand, dReserved).
			Scan(&out.TenantID, &out.ItemID, &out.OnHand, &out.Reserved,
				&out.Threshold, &out.UpdatedAt, &wasLow)
		if err != nil {
			// The CHECK on reserved is what refuses releasing more than is
			// held. Reserved going negative would make stock available that
			// is already promised to somebody.
			if isCheckViolation(err) {
				return ErrOverRelease
			}
			return fmt.Errorf("store: update level: %w", err)
		}

		nowLow := out.Threshold != nil && out.OnHand <= *out.Threshold

		// stock.adjusted carries every movement, because the ledger and the
		// analytics pipeline both want the whole series, not the interesting
		// parts of it.
		if _, err := outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: m.TenantID,
			Topic:    "stock.adjusted",
			// Keyed on the item, so one item's movements stay in order
			// relative to each other. That is the only ordering that matters
			// here: two different items do not interact.
			Key: m.ItemID.String(),
			Payload: map[string]any{
				"move_id": moveID, "item_id": m.ItemID, "delta": m.Delta,
				"kind": m.Kind, "reason": m.Reason,
				"reference_type": m.ReferenceType, "reference_id": m.ReferenceID,
				"on_hand": out.OnHand, "reserved": out.Reserved,
			},
		}); err != nil {
			return err
		}

		// stock.low fires on the crossing, not on every movement below the
		// line. A warning that arrives forty times is a warning nobody reads.
		switch {
		case nowLow && !wasLow:
			if _, err := outbox.Enqueue(ctx, tx, outbox.Event{
				TenantID: m.TenantID, Topic: "stock.low", Key: m.ItemID.String(),
				Payload: map[string]any{
					"item_id": m.ItemID, "on_hand": out.OnHand, "threshold": *out.Threshold,
				},
			}); err != nil {
				return err
			}
			_, err = tx.Exec(ctx,
				`UPDATE stock_levels SET low_announced = TRUE WHERE tenant_id = $1 AND item_id = $2`,
				m.TenantID, m.ItemID)
		case !nowLow && wasLow:
			// Re-arm, so the next crossing warns again.
			_, err = tx.Exec(ctx,
				`UPDATE stock_levels SET low_announced = FALSE WHERE tenant_id = $1 AND item_id = $2`,
				m.TenantID, m.ItemID)
		}
		return err
	})
	return out, repeat, err
}

// Reserved reports how much of an item is held against one reference, so a
// release can refuse to give back more than was taken.
func (s *Store) ReservedFor(ctx context.Context, tenantID, itemID uuid.UUID, refType, refID string) (int32, error) {
	var net int32
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(CASE kind
			WHEN 'reserve' THEN delta
			WHEN 'release' THEN -delta
			WHEN 'consume' THEN -delta
			ELSE 0 END), 0)::int
		FROM stock_moves
		WHERE tenant_id = $1 AND item_id = $2 AND reference_type = $3 AND reference_id = $4`,
		tenantID, itemID, refType, refID).Scan(&net)
	return net, err
}

func isCheckViolation(err error) bool {
	var e interface{ SQLState() string }
	return errors.As(err, &e) && e.SQLState() == "23514"
}
