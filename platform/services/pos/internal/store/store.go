// Package store is the POS service's PostgreSQL persistence.
//
// The shape to understand: an order and its lines and its tenders are written
// in one transaction, together with the event that announces it. A sale that
// committed without its lines is not a sale, and a sale that committed without
// its event is one Invoicing will never issue a receipt for.
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
	"github.com/twentyfour/platform/services/pos/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrNotParked is a settle or an edit aimed at something that is already a
	// sale. Refusing it is what stops a paid order being re-tendered.
	ErrNotParked  = errors.New("store: that sale is not parked")
	ErrNotASale   = errors.New("store: that is a parked sale, not a sale")
	ErrTableBusy  = errors.New("store: that table already has an open tab")
	ErrLineClosed = errors.New("store: that line has already been refunded")
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

type Line struct {
	ID             uuid.UUID
	ItemID         uuid.UUID
	Name           string
	Quantity       int32
	UnitPriceMinor int64
	TaxBasisPoints int32
	TaxIncluded    bool
	DiscountMinor  int64
	GrossMinor     int64
	NetMinor       int64
	TaxMinor       int64
	Position       int32
	RefundedAt     *time.Time
}

type Tender struct {
	ID            uuid.UUID
	Method        string
	AmountMinor   int64
	TenderedMinor *int64
	ChangeMinor   *int64
	PaymentID     *uuid.UUID
	Reference     string
}

type Order struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	Number         string
	Status         string
	PlacedAt       time.Time
	CustomerID     *uuid.UUID
	CustomerName   string
	DiscountCode   string
	DiscountMinor  int64
	Currency       string
	GrossMinor     int64
	NetMinor       int64
	TaxMinor       int64
	RefundedMinor  int64
	StaffID        *uuid.UUID
	Note           string
	TableID        *uuid.UUID
	VoidReason     string
	IdempotencyKey string
	Lines          []Line
	Tenders        []Tender
}

const orderCols = `id, tenant_id, number, status, placed_at, customer_id, customer_name,
                   discount_code, discount_minor, currency, gross_minor, net_minor,
                   tax_minor, refunded_minor, staff_id, note, table_id, void_reason,
                   idempotency_key`

func scanOrder(row pgx.Row) (Order, error) {
	var o Order
	err := row.Scan(&o.ID, &o.TenantID, &o.Number, &o.Status, &o.PlacedAt, &o.CustomerID,
		&o.CustomerName, &o.DiscountCode, &o.DiscountMinor, &o.Currency, &o.GrossMinor,
		&o.NetMinor, &o.TaxMinor, &o.RefundedMinor, &o.StaffID, &o.Note, &o.TableID,
		&o.VoidReason, &o.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrNotFound
	}
	return o, err
}

// nextNumber allocates the day's next order number under a row lock.
//
// A Postgres sequence would be faster and would leave holes: a rolled-back
// transaction burns its number, and a till that skips from 41 to 43 is a till
// somebody will ask about. The lock is held for the length of one insert.
func nextNumber(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, day time.Time) (string, error) {
	var n int32
	err := tx.QueryRow(ctx, `
		INSERT INTO order_counters (tenant_id, day, next) VALUES ($1,$2,2)
		ON CONFLICT (tenant_id, day) DO UPDATE SET next = order_counters.next + 1
		RETURNING next - 1`, tenantID, day).Scan(&n)
	if err != nil {
		return "", fmt.Errorf("store: allocate order number: %w", err)
	}
	return fmt.Sprintf("%s-%04d", day.Format("20060102"), n), nil
}

func insertLines(ctx context.Context, tx pgx.Tx, o Order) error {
	for i, l := range o.Lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO order_lines (id, order_id, tenant_id, item_id, name, quantity,
			                         unit_price_minor, tax_basis_points, tax_included,
			                         discount_minor, gross_minor, net_minor, tax_minor, position)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			l.ID, o.ID, o.TenantID, l.ItemID, l.Name, l.Quantity, l.UnitPriceMinor,
			l.TaxBasisPoints, l.TaxIncluded, l.DiscountMinor, l.GrossMinor, l.NetMinor,
			l.TaxMinor, int32(i)); err != nil {
			return fmt.Errorf("store: insert line: %w", err)
		}
	}
	return nil
}

func insertTenders(ctx context.Context, tx pgx.Tx, o Order) error {
	for _, t := range o.Tenders {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenders (id, order_id, tenant_id, method, amount_minor,
			                     tendered_minor, change_minor, payment_id, reference)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			t.ID, o.ID, o.TenantID, t.Method, t.AmountMinor,
			t.TenderedMinor, t.ChangeMinor, t.PaymentID, t.Reference); err != nil {
			return fmt.Errorf("store: insert tender: %w", err)
		}
	}
	return nil
}

// Insert writes the order, its lines, its tenders and its event as one commit.
//
// It returns the order that resulted and whether the idempotency key had
// already produced one. A retried checkout finds the sale it already made
// rather than making a second.
func (s *Store) Insert(ctx context.Context, o Order, topic string, payload func(Order) map[string]any) (Order, bool, error) {
	var out Order
	var repeat bool

	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if o.IdempotencyKey != "" {
			existing, err := scanOrder(tx.QueryRow(ctx,
				`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND idempotency_key = $2`,
				o.TenantID, o.IdempotencyKey))
			if err == nil {
				repeat, out = true, existing
				return loadInto(ctx, tx, &out)
			}
			if !errors.Is(err, ErrNotFound) {
				return err
			}
		}

		number, err := nextNumber(ctx, tx, o.TenantID, o.PlacedAt)
		if err != nil {
			return err
		}
		o.Number = number

		// A table holds at most one open tab. Checked inside the transaction,
		// because two tills seating the same table at once would both pass a
		// check made before it.
		if o.TableID != nil && o.Status == "open" {
			var busy bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM orders
				               WHERE tenant_id = $1 AND table_id = $2 AND status = 'open')`,
				o.TenantID, *o.TableID).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return ErrTableBusy
			}
		}

		out, err = scanOrder(tx.QueryRow(ctx, `
			INSERT INTO orders (id, tenant_id, number, status, placed_at, customer_id,
			                    customer_name, discount_code, discount_minor, currency,
			                    gross_minor, net_minor, tax_minor, staff_id, note,
			                    table_id, idempotency_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
			RETURNING `+orderCols,
			o.ID, o.TenantID, o.Number, o.Status, o.PlacedAt, o.CustomerID, o.CustomerName,
			o.DiscountCode, o.DiscountMinor, o.Currency, o.GrossMinor, o.NetMinor,
			o.TaxMinor, o.StaffID, o.Note, o.TableID, o.IdempotencyKey))
		if err != nil {
			return err
		}
		out.Lines, out.Tenders = o.Lines, o.Tenders
		if err := insertLines(ctx, tx, o); err != nil {
			return err
		}
		if err := insertTenders(ctx, tx, o); err != nil {
			return err
		}
		if topic == "" {
			return nil
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: o.TenantID, Topic: topic,
			// Keyed on the order, so its own lifecycle stays in order. Placed
			// then voided must never arrive reversed.
			Key: o.ID.String(), Payload: payload(out),
		})
		return err
	})
	return out, repeat, err
}

// ReplaceLines is how a parked sale is edited.
//
// The lines are replaced wholesale rather than patched, because a tab edited on
// two tills at once has to land on one answer rather than on an accumulation of
// both. Refuses anything that is no longer parked.
func (s *Store) ReplaceLines(ctx context.Context, tenantID, id uuid.UUID, o Order) (Order, error) {
	var out Order
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		current, err := scanOrder(tx.QueryRow(ctx,
			`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, id))
		if err != nil {
			return err
		}
		if current.Status != "open" {
			return ErrNotParked
		}
		if _, err := tx.Exec(ctx, `DELETE FROM order_lines WHERE order_id = $1`, id); err != nil {
			return err
		}
		o.ID, o.TenantID = id, tenantID
		if err := insertLines(ctx, tx, o); err != nil {
			return err
		}
		out, err = scanOrder(tx.QueryRow(ctx, `
			UPDATE orders SET gross_minor = $3, net_minor = $4, tax_minor = $5,
			                  note = $6, staff_id = $7, customer_id = $8,
			                  customer_name = $9, table_id = $10, updated_at = now()
			WHERE tenant_id = $1 AND id = $2
			RETURNING `+orderCols,
			tenantID, id, o.GrossMinor, o.NetMinor, o.TaxMinor, o.Note,
			o.StaffID, o.CustomerID, o.CustomerName, o.TableID))
		if err != nil {
			return err
		}
		return loadInto(ctx, tx, &out)
	})
	return out, err
}

// Settle turns a parked sale into a sale. Same id, same number: it becomes the
// sale it always was, rather than a new one leaving the parked one behind.
func (s *Store) Settle(ctx context.Context, tenantID, id uuid.UUID, tenders []Tender, payload func(Order) map[string]any) (Order, error) {
	var out Order
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		current, err := scanOrder(tx.QueryRow(ctx,
			`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, id))
		if err != nil {
			return err
		}
		if current.Status != "open" {
			return ErrNotParked
		}
		out, err = scanOrder(tx.QueryRow(ctx, `
			UPDATE orders SET status = 'paid', placed_at = now(),
			                  table_id = NULL, updated_at = now()
			WHERE tenant_id = $1 AND id = $2
			RETURNING `+orderCols, tenantID, id))
		if err != nil {
			return err
		}
		out.Tenders = tenders
		if err := insertTenders(ctx, tx, Order{ID: id, TenantID: tenantID, Tenders: tenders}); err != nil {
			return err
		}
		if err := loadInto(ctx, tx, &out); err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "order.placed", Key: id.String(), Payload: payload(out),
		})
		return err
	})
	return out, err
}

func (s *Store) Void(ctx context.Context, tenantID, id uuid.UUID, reason string, payload func(Order) map[string]any) (Order, error) {
	var out Order
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		current, err := scanOrder(tx.QueryRow(ctx,
			`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, id))
		if err != nil {
			return err
		}
		// A parked sale is discarded, not voided: nothing was ever sold, so
		// there is nothing to cancel and no record worth keeping.
		if current.Status == "open" {
			return ErrNotASale
		}
		if current.Status == "voided" {
			out = current
			return loadInto(ctx, tx, &out)
		}
		out, err = scanOrder(tx.QueryRow(ctx, `
			UPDATE orders SET status = 'voided', void_reason = $3, updated_at = now()
			WHERE tenant_id = $1 AND id = $2
			RETURNING `+orderCols, tenantID, id, reason))
		if err != nil {
			return err
		}
		if err := loadInto(ctx, tx, &out); err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "order.voided", Key: id.String(), Payload: payload(out),
		})
		return err
	})
	return out, err
}

// MarkRefunded records which lines went back and how much, in one statement per
// line so a line cannot be refunded twice by two concurrent requests.
func (s *Store) MarkRefunded(ctx context.Context, tenantID, id uuid.UUID, lineIDs []uuid.UUID, amount int64) (Order, error) {
	var out Order
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		for _, lineID := range lineIDs {
			tag, err := tx.Exec(ctx, `
				UPDATE order_lines SET refunded_at = now()
				WHERE id = $1 AND order_id = $2 AND refunded_at IS NULL`, lineID, id)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrLineClosed
			}
		}
		var err error
		out, err = scanOrder(tx.QueryRow(ctx, `
			UPDATE orders SET
				refunded_minor = refunded_minor + $3,
				status = CASE WHEN refunded_minor + $3 >= gross_minor
				              THEN 'refunded' ELSE 'partly_refunded' END,
				updated_at = now()
			WHERE tenant_id = $1 AND id = $2 AND status IN ('paid','partly_refunded')
			RETURNING `+orderCols, tenantID, id, amount))
		if errors.Is(err, ErrNotFound) {
			return ErrNotASale
		}
		if err != nil {
			return err
		}
		return loadInto(ctx, tx, &out)
	})
	return out, err
}

// loadInto fills in the lines and tenders of an order already read.
func loadInto(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, o *Order) error {
	rows, err := q.Query(ctx, `
		SELECT id, item_id, name, quantity, unit_price_minor, tax_basis_points,
		       tax_included, discount_minor, gross_minor, net_minor, tax_minor,
		       position, refunded_at
		FROM order_lines WHERE order_id = $1 ORDER BY position`, o.ID)
	if err != nil {
		return err
	}
	o.Lines = nil
	for rows.Next() {
		var l Line
		if err := rows.Scan(&l.ID, &l.ItemID, &l.Name, &l.Quantity, &l.UnitPriceMinor,
			&l.TaxBasisPoints, &l.TaxIncluded, &l.DiscountMinor, &l.GrossMinor,
			&l.NetMinor, &l.TaxMinor, &l.Position, &l.RefundedAt); err != nil {
			rows.Close()
			return err
		}
		o.Lines = append(o.Lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	trows, err := q.Query(ctx, `
		SELECT id, method, amount_minor, tendered_minor, change_minor, payment_id, reference
		FROM tenders WHERE order_id = $1 ORDER BY created_at`, o.ID)
	if err != nil {
		return err
	}
	defer trows.Close()
	o.Tenders = nil
	for trows.Next() {
		var t Tender
		if err := trows.Scan(&t.ID, &t.Method, &t.AmountMinor, &t.TenderedMinor,
			&t.ChangeMinor, &t.PaymentID, &t.Reference); err != nil {
			return err
		}
		o.Tenders = append(o.Tenders, t)
	}
	return trows.Err()
}

// ByKey finds the sale a checkout already made. A replay must not price again,
// take money again, or move stock again.
func (s *Store) ByKey(ctx context.Context, tenantID uuid.UUID, key string) (Order, error) {
	o, err := scanOrder(s.pool.QueryRow(ctx,
		`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND idempotency_key = $2`,
		tenantID, key))
	if err != nil {
		return Order{}, err
	}
	return o, loadInto(ctx, s.pool, &o)
}

func (s *Store) Order(ctx context.Context, tenantID, id uuid.UUID) (Order, error) {
	o, err := scanOrder(s.pool.QueryRow(ctx,
		`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND id = $2`, tenantID, id))
	if err != nil {
		return Order{}, err
	}
	return o, loadInto(ctx, s.pool, &o)
}

type Filter struct {
	From   time.Time
	To     time.Time
	Status string
	Parked bool
	Limit  int
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Order, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 200
	}
	q := `SELECT ` + orderCols + ` FROM orders WHERE tenant_id = $1`
	args := []any{tenantID}
	if f.Parked {
		q += ` AND status = 'open'`
	} else {
		// A parked sale is not a sale. It stays out of the orders list unless
		// asked for by name, or it would appear in a day's trading having
		// never been paid for.
		q += ` AND status <> 'open'`
	}
	if !f.From.IsZero() {
		args = append(args, f.From)
		q += fmt.Sprintf(` AND placed_at >= $%d`, len(args))
	}
	if !f.To.IsZero() {
		args = append(args, f.To)
		q += fmt.Sprintf(` AND placed_at < $%d`, len(args))
	}
	if f.Status != "" {
		args = append(args, f.Status)
		q += fmt.Sprintf(` AND status = $%d`, len(args))
	}
	args = append(args, f.Limit)
	q += fmt.Sprintf(` ORDER BY placed_at DESC LIMIT $%d`, len(args))

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	var out []Order
	for rows.Next() {
		o, err := scanOrder(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := loadInto(ctx, s.pool, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Store) Discard(ctx context.Context, tenantID, id uuid.UUID) (Order, error) {
	var out Order
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		o, err := scanOrder(tx.QueryRow(ctx,
			`SELECT `+orderCols+` FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, id))
		if err != nil {
			return err
		}
		if o.Status != "open" {
			return ErrNotParked
		}
		if err := loadInto(ctx, tx, &o); err != nil {
			return err
		}
		out = o
		// Deleted rather than kept. Nothing was sold, no document was issued,
		// and a discarded basket is not history anyone needs. The number it
		// held is not reused, which is correct: it was allocated.
		_, err = tx.Exec(ctx, `DELETE FROM orders WHERE tenant_id = $1 AND id = $2`, tenantID, id)
		return err
	})
	return out, err
}
