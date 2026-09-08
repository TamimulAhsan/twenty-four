package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The day's trading, and counting the drawer at the end of it.

type MethodTotal struct {
	Method      string
	AmountMinor int64
	Count       int32
}

type TaxBand struct {
	BasisPoints int32
	NetMinor    int64
	TaxMinor    int64
	GrossMinor  int64
}

type Takings struct {
	Date          time.Time
	OrderCount    int32
	GrossMinor    int64
	NetMinor      int64
	TaxMinor      int64
	RefundedMinor int64
	Currency      string
	ByMethod      []MethodTotal
	ByTaxBand     []TaxBand
}

// Takings for one day.
//
// Voided sales and parked ones are both excluded, for different reasons: a void
// did not happen, and a parked sale has not been paid for. Counting either
// would make the day's figures disagree with the drawer.
func (s *Store) Takings(ctx context.Context, tenantID uuid.UUID, from, to time.Time, currency string) (Takings, error) {
	t := Takings{Date: from, Currency: currency}

	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::int,
		       coalesce(sum(gross_minor),0), coalesce(sum(net_minor),0),
		       coalesce(sum(tax_minor),0), coalesce(sum(refunded_minor),0),
		       coalesce(min(currency), $4)
		FROM orders
		WHERE tenant_id = $1 AND placed_at >= $2 AND placed_at < $3
		  AND status NOT IN ('voided','open')`,
		tenantID, from, to, currency).
		Scan(&t.OrderCount, &t.GrossMinor, &t.NetMinor, &t.TaxMinor, &t.RefundedMinor, &t.Currency)
	if err != nil {
		return Takings{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT te.method, sum(te.amount_minor), count(*)::int
		FROM tenders te JOIN orders o ON o.id = te.order_id
		WHERE o.tenant_id = $1 AND o.placed_at >= $2 AND o.placed_at < $3
		  AND o.status NOT IN ('voided','open')
		GROUP BY te.method ORDER BY te.method`, tenantID, from, to)
	if err != nil {
		return Takings{}, err
	}
	for rows.Next() {
		var m MethodTotal
		if err := rows.Scan(&m.Method, &m.AmountMinor, &m.Count); err != nil {
			rows.Close()
			return Takings{}, err
		}
		t.ByMethod = append(t.ByMethod, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Takings{}, err
	}

	// Broken out by band because that is the shape a tax return is filed in,
	// and because a single total cannot be checked against anything.
	brows, err := s.pool.Query(ctx, `
		SELECT l.tax_basis_points, sum(l.net_minor), sum(l.tax_minor), sum(l.gross_minor)
		FROM order_lines l JOIN orders o ON o.id = l.order_id
		WHERE o.tenant_id = $1 AND o.placed_at >= $2 AND o.placed_at < $3
		  AND o.status NOT IN ('voided','open')
		GROUP BY l.tax_basis_points ORDER BY l.tax_basis_points`, tenantID, from, to)
	if err != nil {
		return Takings{}, err
	}
	defer brows.Close()
	for brows.Next() {
		var b TaxBand
		if err := brows.Scan(&b.BasisPoints, &b.NetMinor, &b.TaxMinor, &b.GrossMinor); err != nil {
			return Takings{}, err
		}
		t.ByTaxBand = append(t.ByTaxBand, b)
	}
	return t, brows.Err()
}

type DayClose struct {
	Date              time.Time
	OpeningFloatMinor int64
	CashTakenMinor    int64
	CashRefundedMinor int64
	CountedMinor      *int64
	Currency          string
	CountedBy         *uuid.UUID
	CountedAt         *time.Time
	Note              string
	Closed            bool
}

// DayClose reads the drawer's position for a day.
//
// Expected cash is derived from what was actually tendered in cash, never from
// the day's total: a card sale never touched the drawer. Refunds come back out
// of it in proportion to how the sale was paid, because money goes back the way
// it came.
func (s *Store) DayClose(ctx context.Context, tenantID uuid.UUID, from, to time.Time, currency string) (DayClose, error) {
	d := DayClose{Date: from, Currency: currency}

	if err := s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(te.amount_minor),0)
		FROM tenders te JOIN orders o ON o.id = te.order_id
		WHERE o.tenant_id = $1 AND o.placed_at >= $2 AND o.placed_at < $3
		  AND o.status NOT IN ('voided','open') AND te.method = 'cash'`,
		tenantID, from, to).Scan(&d.CashTakenMinor); err != nil {
		return DayClose{}, err
	}

	// A refund goes back the way it came, so the cash share of a refund is the
	// cash share of how that sale was paid. Deriving it any other way would
	// take card money out of the drawer.
	if err := s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(
			o.refunded_minor
			* coalesce((SELECT sum(amount_minor) FROM tenders
			            WHERE order_id = o.id AND method = 'cash'), 0)
			/ nullif((SELECT sum(amount_minor) FROM tenders WHERE order_id = o.id), 0)
		), 0)::bigint
		FROM orders o
		WHERE o.tenant_id = $1 AND o.placed_at >= $2 AND o.placed_at < $3
		  AND o.status IN ('refunded','partly_refunded')`,
		tenantID, from, to).Scan(&d.CashRefundedMinor); err != nil {
		return DayClose{}, err
	}

	var countedBy *uuid.UUID
	var countedAt *time.Time
	var counted *int64
	err := s.pool.QueryRow(ctx, `
		SELECT opening_float_minor, counted_minor, counted_by, counted_at, note
		FROM day_closes WHERE tenant_id = $1 AND day = $2`, tenantID, from).
		Scan(&d.OpeningFloatMinor, &counted, &countedBy, &countedAt, &d.Note)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Not closed yet. The float carried over from the last count is the
		// figure a cashier is about to type anyway, so suggest it.
		if err := s.pool.QueryRow(ctx, `
			SELECT coalesce((SELECT counted_minor FROM day_closes
			                 WHERE tenant_id = $1 AND day < $2
			                 ORDER BY day DESC LIMIT 1), 0)`,
			tenantID, from).Scan(&d.OpeningFloatMinor); err != nil {
			return DayClose{}, err
		}
	case err != nil:
		return DayClose{}, err
	default:
		d.Closed, d.CountedMinor, d.CountedBy, d.CountedAt = true, counted, countedBy, countedAt
	}
	return d, nil
}

// CloseDay records the count. Idempotent on the day: closing twice replaces the
// figures rather than failing, because a miscount is corrected by recounting.
func (s *Store) CloseDay(ctx context.Context, tenantID uuid.UUID, day time.Time,
	openingFloat, counted int64, currency, note string, by *uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO day_closes (tenant_id, day, opening_float_minor, counted_minor,
		                        currency, counted_by, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (tenant_id, day) DO UPDATE SET
			opening_float_minor = EXCLUDED.opening_float_minor,
			counted_minor = EXCLUDED.counted_minor,
			counted_by = EXCLUDED.counted_by,
			counted_at = now(),
			note = EXCLUDED.note`,
		tenantID, day, openingFloat, counted, currency, by, note)
	return err
}

type Table struct {
	ID        uuid.UUID
	Label     string
	Seats     int32
	Area      string
	Status    string
	PartySize *int32
	SeatedAt  *time.Time
	StaffID   *uuid.UUID
	OrderID   *uuid.UUID
}

const tableCols = `t.id, t.label, t.seats, t.area, t.status, t.party_size, t.seated_at, t.staff_id,
                   (SELECT o.id FROM orders o
                    WHERE o.table_id = t.id AND o.status = 'open' LIMIT 1)`

func scanTable(row pgx.Row) (Table, error) {
	var t Table
	err := row.Scan(&t.ID, &t.Label, &t.Seats, &t.Area, &t.Status,
		&t.PartySize, &t.SeatedAt, &t.StaffID, &t.OrderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Table{}, ErrNotFound
	}
	return t, err
}

func (s *Store) Tables(ctx context.Context, tenantID uuid.UUID) ([]Table, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+tableCols+` FROM dining_tables t WHERE t.tenant_id = $1 ORDER BY t.area, t.label`,
		tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Table
	for rows.Next() {
		t, err := scanTable(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) CreateTable(ctx context.Context, tenantID uuid.UUID, t Table) (Table, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO dining_tables (id, tenant_id, label, seats, area)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		t.ID, tenantID, t.Label, t.Seats, t.Area).Scan(&id)
	if err != nil {
		return Table{}, err
	}
	return scanTable(s.pool.QueryRow(ctx,
		`SELECT `+tableCols+` FROM dining_tables t WHERE t.tenant_id = $1 AND t.id = $2`, tenantID, id))
}

// UpdateTable moves a table between states.
//
// It refuses to free a table that still has an open tab: clearing it would
// strand a sale nobody can find again. That check is in the statement rather
// than in a caller, because a caller is the thing that forgets.
func (s *Store) UpdateTable(ctx context.Context, tenantID, id uuid.UUID,
	status string, partySize *int32, clearParty bool, staffID *uuid.UUID, clearStaff bool) (Table, error) {
	var out Table
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if status == "free" {
			var busy bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM orders
				               WHERE tenant_id = $1 AND table_id = $2 AND status = 'open')`,
				tenantID, id).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return ErrTableBusy
			}
		}
		var err error
		out, err = scanTable(tx.QueryRow(ctx, `
			UPDATE dining_tables t SET
				status = coalesce($3, status),
				party_size = CASE WHEN $5 THEN NULL ELSE coalesce($4, party_size) END,
				staff_id = CASE WHEN $7 THEN NULL ELSE coalesce($6, staff_id) END,
				-- Seating starts the clock; freeing stops it. Every other move
				-- leaves it where it is, so "seated 40 minutes" stays true
				-- across ordering and asking for the bill.
				seated_at = CASE
					WHEN $3 = 'seated' AND t.status = 'free' THEN now()
					WHEN $3 = 'free' THEN NULL
					ELSE t.seated_at END
			WHERE t.tenant_id = $1 AND t.id = $2
			RETURNING `+tableCols,
			tenantID, id, nullIfEmpty(status), partySize, clearParty, staffID, clearStaff))
		return err
	})
	return out, err
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
