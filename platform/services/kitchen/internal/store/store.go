// Package store is the Kitchen service's PostgreSQL persistence.
//
// The shape worth understanding: a ticket's state is derived from its lines
// rather than set independently. A ticket is waiting when nothing is claimed,
// cooking when something is, ready when everything is done. Storing the ticket
// state as its own fact would give two answers to the same question, and the
// one on the screen would eventually be the wrong one.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/kitchen/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrClaimed is a second cook starting a dish somebody already has.
	ErrClaimed = errors.New("store: somebody is already on that")
	// ErrNotReady is passing a ticket with work still on it.
	ErrNotReady = errors.New("store: that ticket still has something cooking")
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
	if err := outbox.Migrate(ctx, s.pool); err != nil {
		return err
	}
	return bus.Migrate(ctx, s.pool)
}

func (s *Store) Pool() *pg.Pool { return s.pool }

type Station struct {
	ID       uuid.UUID
	TenantID uuid.UUID
	Name     string
	IsPass   bool
	Active   bool
}

func (s *Store) ListStations(ctx context.Context, tenantID uuid.UUID, includeInactive bool) ([]Station, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, name, is_pass, active FROM stations
		WHERE tenant_id = $1 AND ($2 OR active)
		ORDER BY is_pass, name`, tenantID, includeInactive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Station
	for rows.Next() {
		var st Station
		if err := rows.Scan(&st.ID, &st.TenantID, &st.Name, &st.IsPass, &st.Active); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *Store) PutStation(ctx context.Context, st Station) (Station, error) {
	if st.ID == uuid.Nil {
		st.ID = uuid.New()
	}
	var out Station
	err := s.pool.QueryRow(ctx, `
		INSERT INTO stations (id, tenant_id, name, is_pass, active)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name, is_pass = EXCLUDED.is_pass, active = EXCLUDED.active
		RETURNING id, tenant_id, name, is_pass, active`,
		st.ID, st.TenantID, st.Name, st.IsPass, st.Active).
		Scan(&out.ID, &out.TenantID, &out.Name, &out.IsPass, &out.Active)
	return out, err
}

// DeleteStation deactivates rather than deleting, because tickets point at it
// and a line routed to nothing is a dish nobody cooks.
func (s *Store) DeleteStation(ctx context.Context, tenantID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE stations SET active = FALSE WHERE tenant_id = $1 AND id = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RouteItem(ctx context.Context, tenantID, itemID uuid.UUID, stationID *uuid.UUID) error {
	if stationID == nil {
		_, err := s.pool.Exec(ctx,
			`DELETE FROM item_routes WHERE tenant_id = $1 AND item_id = $2`, tenantID, itemID)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO item_routes (tenant_id, item_id, station_id) VALUES ($1,$2,$3)
		ON CONFLICT (tenant_id, item_id) DO UPDATE SET station_id = EXCLUDED.station_id`,
		tenantID, itemID, *stationID)
	return err
}

// Routes returns the item to station map for a tenant.
func (s *Store) Routes(ctx context.Context, tenantID uuid.UUID) (map[uuid.UUID]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT item_id, station_id FROM item_routes WHERE tenant_id = $1`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uuid.UUID]uuid.UUID{}
	for rows.Next() {
		var item, station uuid.UUID
		if err := rows.Scan(&item, &station); err != nil {
			return nil, err
		}
		out[item] = station
	}
	return out, rows.Err()
}

type Line struct {
	ID          uuid.UUID
	TicketID    uuid.UUID
	ItemID      uuid.UUID
	Name        string
	Quantity    int32
	Note        string
	StationID   *uuid.UUID
	StationName string
	State       string
	ClaimedBy   *uuid.UUID
	ClaimedAt   *time.Time
	DoneAt      *time.Time
	VoidReason  string
}

type Ticket struct {
	ID          uuid.UUID
	TenantID    uuid.UUID
	OrderID     uuid.UUID
	OrderNumber string
	TableLabel  string
	State       string
	Note        string
	PlacedAt    time.Time
	PassedAt    *time.Time
	Lines       []Line
}

// stateFromLines derives what the ticket is doing from what its lines are
// doing.
//
// Derived rather than stored, because two records of one fact eventually
// disagree and the one on the screen would be the wrong one. Waiting until
// somebody claims something; cooking while anything is claimed; ready when
// every line that is still on is done.
func stateFromLines(lines []Line) string {
	live, done, claimed := 0, 0, 0
	for _, l := range lines {
		switch l.State {
		case "voided":
			continue
		case "done":
			done++
		case "claimed":
			claimed++
		}
		live++
	}
	switch {
	case live == 0:
		// Every line voided. The ticket is not ready, it is gone.
		return "voided"
	case done == live:
		return "ready"
	case claimed > 0 || done > 0:
		return "cooking"
	default:
		return "waiting"
	}
}

const ticketCols = `id, tenant_id, order_id, order_number, table_label, state,
	note, placed_at, passed_at`

func scanTicket(row pgx.Row) (Ticket, error) {
	var t Ticket
	err := row.Scan(&t.ID, &t.TenantID, &t.OrderID, &t.OrderNumber, &t.TableLabel,
		&t.State, &t.Note, &t.PlacedAt, &t.PassedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, ErrNotFound
	}
	return t, err
}

// Create writes a ticket and its lines, once per order.
//
// The unique index on the order is the deduplication: delivery is at-least-once
// and a redelivered order event must not print a second ticket and have the
// meal cooked twice.
func (s *Store) Create(ctx context.Context, t Ticket) (Ticket, bool, error) {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	var out Ticket
	repeat := false
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO tickets (id, tenant_id, order_id, order_number, table_label,
			                     note, placed_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (tenant_id, order_id) DO NOTHING`,
			t.ID, t.TenantID, t.OrderID, t.OrderNumber, t.TableLabel, t.Note, t.PlacedAt)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			repeat = true
			out, err = scanTicket(tx.QueryRow(ctx,
				`SELECT `+ticketCols+` FROM tickets WHERE tenant_id = $1 AND order_id = $2`,
				t.TenantID, t.OrderID))
			if err != nil {
				return err
			}
			return loadLines(ctx, tx, &out)
		}

		for _, l := range t.Lines {
			if _, err := tx.Exec(ctx, `
				INSERT INTO ticket_lines (id, tenant_id, ticket_id, item_id, name,
				                          quantity, note, station_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				uuid.New(), t.TenantID, t.ID, l.ItemID, l.Name, l.Quantity,
				l.Note, l.StationID); err != nil {
				return err
			}
		}
		out, err = scanTicket(tx.QueryRow(ctx,
			`SELECT `+ticketCols+` FROM tickets WHERE id = $1`, t.ID))
		if err != nil {
			return err
		}
		return loadLines(ctx, tx, &out)
	})
	return out, repeat, err
}

func loadLines(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, t *Ticket) error {
	rows, err := q.Query(ctx, `
		SELECT l.id, l.ticket_id, l.item_id, l.name, l.quantity, l.note,
		       l.station_id, coalesce(s.name, ''), l.state, l.claimed_by,
		       l.claimed_at, l.done_at, l.void_reason
		FROM ticket_lines l
		LEFT JOIN stations s ON s.id = l.station_id
		WHERE l.ticket_id = $1
		ORDER BY l.id`, t.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	t.Lines = nil
	for rows.Next() {
		var l Line
		if err := rows.Scan(&l.ID, &l.TicketID, &l.ItemID, &l.Name, &l.Quantity,
			&l.Note, &l.StationID, &l.StationName, &l.State, &l.ClaimedBy,
			&l.ClaimedAt, &l.DoneAt, &l.VoidReason); err != nil {
			return err
		}
		t.Lines = append(t.Lines, l)
	}
	return rows.Err()
}

func (s *Store) Ticket(ctx context.Context, tenantID, id uuid.UUID) (Ticket, error) {
	t, err := scanTicket(s.pool.QueryRow(ctx,
		`SELECT `+ticketCols+` FROM tickets WHERE tenant_id = $1 AND id = $2`, tenantID, id))
	if err != nil {
		return Ticket{}, err
	}
	return t, loadLines(ctx, s.pool, &t)
}

// List returns what is on the screen.
//
// A station sees only tickets with a line routed to it. The pass sees
// everything, because knowing when a table's whole order is ready is the job.
func (s *Store) List(ctx context.Context, tenantID uuid.UUID, stationID *uuid.UUID,
	includeFinished bool, limit int) ([]Ticket, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+ticketCols+` FROM tickets t
		WHERE t.tenant_id = $1
		  AND ($2 OR t.state IN ('waiting','cooking','ready'))
		  AND ($3::uuid IS NULL OR EXISTS (
		        SELECT 1 FROM ticket_lines l
		        WHERE l.ticket_id = t.id AND l.station_id = $3))
		ORDER BY t.placed_at
		LIMIT $4`, tenantID, includeFinished, stationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Ticket
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := loadLines(ctx, s.pool, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Claim marks a line as somebody's, refusing if it is already taken.
//
// The state is in the WHERE clause rather than checked first, so two cooks
// pressing at the same instant produce one claim. That race is the reason this
// operation exists at all.
func (s *Store) Claim(ctx context.Context, tenantID, lineID, staffID uuid.UUID) (Ticket, error) {
	return s.mutateLine(ctx, tenantID, lineID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE ticket_lines SET state = 'claimed', claimed_by = $3, claimed_at = now()
			WHERE tenant_id = $1 AND id = $2 AND state = 'waiting'`,
			tenantID, lineID, staffID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrClaimed
		}
		return nil
	})
}

func (s *Store) Complete(ctx context.Context, tenantID, lineID uuid.UUID) (Ticket, error) {
	return s.mutateLine(ctx, tenantID, lineID, func(ctx context.Context, tx pgx.Tx) error {
		// From waiting as well as claimed: a cook who did the dish without
		// pressing claim first has still done the dish, and refusing would
		// leave a finished plate marked as work.
		tag, err := tx.Exec(ctx, `
			UPDATE ticket_lines SET state = 'done', done_at = now()
			WHERE tenant_id = $1 AND id = $2 AND state IN ('waiting','claimed')`,
			tenantID, lineID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Store) VoidLine(ctx context.Context, tenantID, lineID uuid.UUID, reason string) (Ticket, error) {
	return s.mutateLine(ctx, tenantID, lineID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE ticket_lines SET state = 'voided', void_reason = $3
			WHERE tenant_id = $1 AND id = $2 AND state <> 'voided'`,
			tenantID, lineID, reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// mutateLine applies a change to a line and re-derives the ticket's state from
// what its lines now say.
//
// One place, so the derivation cannot be forgotten on a path somebody adds
// later. That is the failure this shape prevents: a line marked done and a
// ticket still saying cooking, on a screen a chef is looking at.
func (s *Store) mutateLine(ctx context.Context, tenantID, lineID uuid.UUID,
	change func(context.Context, pgx.Tx) error) (Ticket, error) {
	var out Ticket
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var ticketID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT ticket_id FROM ticket_lines WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, lineID).Scan(&ticketID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if err := change(ctx, tx); err != nil {
			return err
		}

		t, err := scanTicket(tx.QueryRow(ctx,
			`SELECT `+ticketCols+` FROM tickets WHERE id = $1 FOR UPDATE`, ticketID))
		if err != nil {
			return err
		}
		if err := loadLines(ctx, tx, &t); err != nil {
			return err
		}
		// A passed ticket stays passed. Somebody correcting a line after the
		// food has gone out is not un-serving the table.
		if t.State != "passed" {
			t.State = stateFromLines(t.Lines)
			if _, err := tx.Exec(ctx,
				`UPDATE tickets SET state = $2 WHERE id = $1`, t.ID, t.State); err != nil {
				return err
			}
		}
		out = t
		return nil
	})
	return out, err
}

// Pass hands the ticket over, and only when there is nothing still cooking.
//
// A ticket passed with a line outstanding is a table waiting for food nobody is
// making, and nothing on any screen would say so.
func (s *Store) Pass(ctx context.Context, tenantID, id uuid.UUID) (Ticket, error) {
	var out Ticket
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		t, err := scanTicket(tx.QueryRow(ctx,
			`SELECT `+ticketCols+` FROM tickets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, id))
		if err != nil {
			return err
		}
		if err := loadLines(ctx, tx, &t); err != nil {
			return err
		}
		if t.State == "passed" {
			out = t
			return nil
		}
		if stateFromLines(t.Lines) != "ready" {
			return ErrNotReady
		}
		if _, err := tx.Exec(ctx,
			`UPDATE tickets SET state = 'passed', passed_at = now() WHERE id = $1`,
			id); err != nil {
			return err
		}
		t.State = "passed"
		now := time.Now()
		t.PassedAt = &now
		out = t

		// Announced because it is the one moment anybody outside the kitchen
		// cares about: how long a table waited is a service metric, and it is
		// measurable only from here.
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "kitchen.passed", Key: id.String(),
			Payload: map[string]any{
				"ticket_id": id, "order_id": t.OrderID, "order_number": t.OrderNumber,
				"table_label": t.TableLabel, "placed_at": t.PlacedAt,
				"prep_seconds": int64(now.Sub(t.PlacedAt).Seconds()),
			},
		})
		return err
	})
	return out, err
}

// VoidTicket takes a whole ticket off the screen, which is what happens when
// the sale it came from is voided at the till.
func (s *Store) VoidTicket(ctx context.Context, tenantID, orderID uuid.UUID) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var id uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM tickets WHERE tenant_id = $1 AND order_id = $2`,
			tenantID, orderID).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ticket_lines SET state = 'voided', void_reason = 'the sale was voided'
			WHERE ticket_id = $1 AND state <> 'voided'`, id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`UPDATE tickets SET state = 'voided' WHERE id = $1 AND state <> 'passed'`, id)
		return err
	})
}
