// Package store is the Bookings service's PostgreSQL persistence.
//
// The one thing worth understanding: a booking is written under a lock on its
// resource, and the capacity check happens inside that lock. A check outside it
// is a check that two customers pass at the same moment, and the gap between
// "the page said it was free" and "the button was pressed" is exactly where a
// double booking comes from.
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
	"github.com/twentyfour/platform/services/bookings/internal/slots"
	"github.com/twentyfour/platform/services/bookings/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrTaken is the double-booking refusal. It is the whole point of the
	// service, so it has a name rather than being an anonymous conflict.
	ErrTaken = errors.New("store: that time is already taken")
	// ErrBadTransition is a status change that does not describe anything that
	// happened, such as completing a cancelled booking.
	ErrBadTransition = errors.New("store: a booking cannot go that way")
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

type Resource struct {
	ID       uuid.UUID
	TenantID uuid.UUID
	Name     string
	StaffID  *uuid.UUID
	Capacity int32
	Active   bool
	Opening  []slots.Window
}

func (s *Store) ListResources(ctx context.Context, tenantID uuid.UUID, includeInactive bool) ([]Resource, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, name, staff_id, capacity, active
		FROM resources WHERE tenant_id = $1 AND ($2 OR active)
		ORDER BY name`, tenantID, includeInactive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Resource
	for rows.Next() {
		var r Resource
		if err := rows.Scan(&r.ID, &r.TenantID, &r.Name, &r.StaffID, &r.Capacity, &r.Active); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.attachOpening(ctx, tenantID, out)
}

// attachOpening loads every resource's hours in one query rather than one per
// resource, because a calendar draws all of them at once.
func (s *Store) attachOpening(ctx context.Context, tenantID uuid.UUID, list []Resource) error {
	if len(list) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT resource_id, weekday, opens, closes
		FROM opening_windows WHERE tenant_id = $1
		ORDER BY weekday, opens`, tenantID)
	if err != nil {
		return err
	}
	defer rows.Close()
	byResource := map[uuid.UUID][]slots.Window{}
	for rows.Next() {
		var id uuid.UUID
		var w slots.Window
		if err := rows.Scan(&id, &w.Weekday, &w.Opens, &w.Closes); err != nil {
			return err
		}
		byResource[id] = append(byResource[id], w)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range list {
		list[i].Opening = byResource[list[i].ID]
	}
	return nil
}

func (s *Store) Resource(ctx context.Context, tenantID, id uuid.UUID) (Resource, error) {
	var r Resource
	err := s.pool.QueryRow(ctx, `
		SELECT id, tenant_id, name, staff_id, capacity, active
		FROM resources WHERE tenant_id = $1 AND id = $2`, tenantID, id).
		Scan(&r.ID, &r.TenantID, &r.Name, &r.StaffID, &r.Capacity, &r.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return Resource{}, ErrNotFound
	}
	if err != nil {
		return Resource{}, err
	}
	list := []Resource{r}
	if err := s.attachOpening(ctx, tenantID, list); err != nil {
		return Resource{}, err
	}
	return list[0], nil
}

// PutResource creates or replaces a resource and its whole opening pattern.
//
// The pattern is replaced rather than merged, because a merge cannot express
// "we no longer work Saturdays": the absence of a row is the fact being stated,
// and a merge has no way to represent an absence.
func (s *Store) PutResource(ctx context.Context, r Resource) (Resource, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO resources (id, tenant_id, name, staff_id, capacity, active)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name, staff_id = EXCLUDED.staff_id,
				capacity = EXCLUDED.capacity, active = EXCLUDED.active`,
			r.ID, r.TenantID, r.Name, r.StaffID, r.Capacity, r.Active); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM opening_windows WHERE tenant_id = $1 AND resource_id = $2`,
			r.TenantID, r.ID); err != nil {
			return err
		}
		for _, w := range r.Opening {
			if _, err := tx.Exec(ctx, `
				INSERT INTO opening_windows (tenant_id, resource_id, weekday, opens, closes)
				VALUES ($1,$2,$3,$4,$5)`,
				r.TenantID, r.ID, w.Weekday, w.Opens, w.Closes); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Resource{}, err
	}
	return s.Resource(ctx, r.TenantID, r.ID)
}

// DeleteResource deactivates rather than deleting.
//
// A resource with bookings against it cannot go: the bookings would lose the
// thing they were made against, and a calendar full of appointments with
// nothing attached is worse than a chair marked inactive.
func (s *Store) DeleteResource(ctx context.Context, tenantID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE resources SET active = FALSE WHERE tenant_id = $1 AND id = $2`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type Booking struct {
	ID              uuid.UUID
	TenantID        uuid.UUID
	Reference       string
	ItemID          uuid.UUID
	ItemName        string
	ResourceID      uuid.UUID
	StaffID         *uuid.UUID
	CustomerName    string
	CustomerPhone   string
	CustomerEmail   string
	StartsAt        time.Time
	EndsAt          time.Time
	Status          string
	DepositMinor    *int64
	DepositCurrency string
	PaymentID       string
	Note            string
	CreatedAt       time.Time
	CancelledAt     *time.Time
	CancelReason    string
	IdempotencyKey  string
}

const bookingCols = `b.id, b.tenant_id, b.reference, b.item_id, b.item_name,
	b.resource_id, r.staff_id, b.customer_name, b.customer_phone, b.customer_email,
	b.starts_at, b.ends_at, b.status, b.deposit_minor, b.deposit_currency,
	b.payment_id, b.note, b.created_at, b.cancelled_at, b.cancellation_reason,
	b.idempotency_key`

func scanBooking(row pgx.Row) (Booking, error) {
	var b Booking
	err := row.Scan(&b.ID, &b.TenantID, &b.Reference, &b.ItemID, &b.ItemName,
		&b.ResourceID, &b.StaffID, &b.CustomerName, &b.CustomerPhone, &b.CustomerEmail,
		&b.StartsAt, &b.EndsAt, &b.Status, &b.DepositMinor, &b.DepositCurrency,
		&b.PaymentID, &b.Note, &b.CreatedAt, &b.CancelledAt, &b.CancelReason,
		&b.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Booking{}, ErrNotFound
	}
	return b, err
}

// ByIdempotencyKey finds a booking already made under a key.
//
// Asked before anything else on the create path, because everything else is a
// question about a slot that this booking is itself occupying. A retried
// request that goes looking for a free resource first finds the one it already
// took and is told there is nothing free, which is precisely the answer the key
// exists to prevent.
func (s *Store) ByIdempotencyKey(ctx context.Context, tenantID uuid.UUID, key string) (Booking, error) {
	if key == "" {
		return Booking{}, ErrNotFound
	}
	return scanBooking(s.pool.QueryRow(ctx, `
		SELECT `+bookingCols+` FROM bookings b
		JOIN resources r ON r.id = b.resource_id
		WHERE b.tenant_id = $1 AND b.idempotency_key = $2`, tenantID, key))
}

// Busy returns what is already booked on a resource over a window.
//
// Only confirmed and arrived count. A cancelled booking is not holding a slot,
// and a completed one in the past does not block the same time next week.
func (s *Store) Busy(ctx context.Context, tenantID, resourceID uuid.UUID, from, to time.Time) ([]slots.Busy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT starts_at, ends_at FROM bookings
		WHERE tenant_id = $1 AND resource_id = $2
		  AND status IN ('confirmed','arrived')
		  AND starts_at < $4 AND ends_at > $3`,
		tenantID, resourceID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []slots.Busy
	for rows.Next() {
		var b slots.Busy
		if err := rows.Scan(&b.Start, &b.End); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Create writes a booking, checking capacity under a lock on the resource.
//
// The lock is the whole design. Two customers pressing Book at the same instant
// both saw a free slot; only one of them can have it, and the only place that
// can be decided is inside a transaction that the other has to wait for.
func (s *Store) Create(ctx context.Context, b Booking, reference func() string) (Booking, bool, error) {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	var out Booking
	repeat := false
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if b.IdempotencyKey != "" {
			existing, err := scanBooking(tx.QueryRow(ctx, `
				SELECT `+bookingCols+` FROM bookings b
				JOIN resources r ON r.id = b.resource_id
				WHERE b.tenant_id = $1 AND b.idempotency_key = $2`,
				b.TenantID, b.IdempotencyKey))
			if err == nil {
				repeat = true
				out = existing
				return nil
			}
			if !errors.Is(err, ErrNotFound) {
				return err
			}
		}

		// The lock. Everything after this is serialised per resource, which is
		// the correct granularity: two different chairs do not interact.
		var capacity int32
		if err := tx.QueryRow(ctx,
			`SELECT capacity FROM resources WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			b.TenantID, b.ResourceID).Scan(&capacity); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}

		var taken int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM bookings
			WHERE tenant_id = $1 AND resource_id = $2
			  AND status IN ('confirmed','arrived')
			  AND starts_at < $4 AND ends_at > $3
			  AND id <> $5`,
			b.TenantID, b.ResourceID, b.StartsAt, b.EndsAt, b.ID).Scan(&taken); err != nil {
			return err
		}
		if int32(taken) >= capacity {
			return ErrTaken
		}

		// The reference is generated inside the transaction and retried on a
		// collision, rather than checked first: a check followed by an insert
		// is a race, and this one is between two customers booking at once.
		//
		// The insert and the read back are two statements, not one. A
		// data-modifying CTE's rows are invisible to the same statement's outer
		// SELECT, because that SELECT reads the snapshot from before the
		// statement began. Reading the join in the same statement therefore
		// returns nothing, which here looked exactly like a reference
		// collision and sent every booking into the retry loop.
		inserted := false
		for attempt := 0; attempt < 5; attempt++ {
			b.Reference = reference()
			tag, err := tx.Exec(ctx, `
				INSERT INTO bookings (id, tenant_id, reference, item_id, item_name,
				                      resource_id, customer_name, customer_phone,
				                      customer_email, starts_at, ends_at,
				                      deposit_minor, deposit_currency, payment_id,
				                      note, idempotency_key)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				ON CONFLICT (tenant_id, reference) DO NOTHING`,
				b.ID, b.TenantID, b.Reference, b.ItemID, b.ItemName, b.ResourceID,
				b.CustomerName, b.CustomerPhone, b.CustomerEmail, b.StartsAt, b.EndsAt,
				b.DepositMinor, b.DepositCurrency, b.PaymentID, b.Note, b.IdempotencyKey)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				inserted = true
				break
			}
		}
		if !inserted {
			return fmt.Errorf("store: could not find an unused reference")
		}

		var err error
		out, err = scanBooking(tx.QueryRow(ctx, `
			SELECT `+bookingCols+` FROM bookings b
			JOIN resources r ON r.id = b.resource_id
			WHERE b.id = $1`, b.ID))
		if err != nil {
			return err
		}

		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: b.TenantID, Topic: "booking.created", Key: out.ID.String(),
			Payload: bookingPayload(out),
		})
		return err
	})
	return out, repeat, err
}

func bookingPayload(b Booking) map[string]any {
	payload := map[string]any{
		"booking_id": b.ID, "reference": b.Reference,
		"item_id": b.ItemID, "item_name": b.ItemName,
		"resource_id":   b.ResourceID,
		"customer_name": b.CustomerName, "customer_email": b.CustomerEmail,
		"starts_at": b.StartsAt, "ends_at": b.EndsAt, "status": b.Status,
	}
	// Absent rather than zero, the same way the analytics projection treats an
	// unrecorded cost: no deposit asked for is not a deposit of nothing.
	if b.DepositMinor != nil {
		payload["deposit"] = map[string]any{
			"minor": *b.DepositMinor, "currency": b.DepositCurrency,
		}
	}
	return payload
}

func (s *Store) Booking(ctx context.Context, tenantID, id uuid.UUID) (Booking, error) {
	return scanBooking(s.pool.QueryRow(ctx, `
		SELECT `+bookingCols+` FROM bookings b
		JOIN resources r ON r.id = b.resource_id
		WHERE b.tenant_id = $1 AND b.id = $2`, tenantID, id))
}

type Filter struct {
	From       *time.Time
	To         *time.Time
	ResourceID *uuid.UUID
	Status     string
	Limit      int
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Booking, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+bookingCols+` FROM bookings b
		JOIN resources r ON r.id = b.resource_id
		WHERE b.tenant_id = $1
		  AND ($2::timestamptz IS NULL OR b.ends_at > $2)
		  AND ($3::timestamptz IS NULL OR b.starts_at < $3)
		  AND ($4::uuid IS NULL OR b.resource_id = $4)
		  AND ($5 = '' OR b.status = $5)
		ORDER BY b.starts_at
		LIMIT $6`,
		tenantID, f.From, f.To, f.ResourceID, f.Status, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Booking
	for rows.Next() {
		b, err := scanBooking(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Reschedule moves a booking, under the same lock and the same check.
//
// It is the create path with an existing row, which is what it actually is: a
// move that lands on a full slot has to be refused exactly as a new booking
// would be, and writing that check twice is writing it differently twice.
func (s *Store) Reschedule(ctx context.Context, tenantID, id, resourceID uuid.UUID,
	startsAt, endsAt time.Time) (Booking, error) {
	var out Booking
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var capacity int32
		if err := tx.QueryRow(ctx,
			`SELECT capacity FROM resources WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
			tenantID, resourceID).Scan(&capacity); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var taken int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM bookings
			WHERE tenant_id = $1 AND resource_id = $2
			  AND status IN ('confirmed','arrived')
			  AND starts_at < $4 AND ends_at > $3
			  AND id <> $5`,
			tenantID, resourceID, startsAt, endsAt, id).Scan(&taken); err != nil {
			return err
		}
		if int32(taken) >= capacity {
			return ErrTaken
		}

		// Two statements, for the reason in Create: a data-modifying CTE's rows
		// are not visible to the same statement's outer SELECT.
		tag, err := tx.Exec(ctx, `
			UPDATE bookings
			SET resource_id = $3, starts_at = $4, ends_at = $5
			WHERE tenant_id = $1 AND id = $2 AND status IN ('confirmed','arrived')`,
			tenantID, id, resourceID, startsAt, endsAt)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Either it does not exist, or it has been and gone. Told apart,
			// because "no such booking" sent to somebody looking at the booking
			// on their screen is a message that reads as a broken system.
			var state string
			if err := tx.QueryRow(ctx,
				`SELECT status FROM bookings WHERE tenant_id = $1 AND id = $2`,
				tenantID, id).Scan(&state); err != nil {
				return ErrNotFound
			}
			return fmt.Errorf("%w: a %s booking cannot be moved", ErrBadTransition, state)
		}
		out, err = scanBooking(tx.QueryRow(ctx, `
			SELECT `+bookingCols+` FROM bookings b
			JOIN resources r ON r.id = b.resource_id
			WHERE b.id = $1`, id))
		if err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "booking.rescheduled", Key: id.String(),
			Payload: bookingPayload(out),
		})
		return err
	})
	return out, err
}

// allowed is the state machine, written once.
//
// A free status field would let a cancelled booking be completed, which did not
// happen and cannot be undone once it is in the diary and in the analytics
// projection behind it.
var allowed = map[string][]string{
	"confirmed": {"arrived", "cancelled", "no_show"},
	// Somebody who is here can still leave without being served, but they
	// cannot become a no-show: they showed.
	"arrived": {"completed", "cancelled"},
	// Terminal. A completed booking that is later refunded is a refund, not a
	// booking that stopped having happened.
	"completed": {},
	"cancelled": {},
	"no_show":   {},
}

func (s *Store) SetStatus(ctx context.Context, tenantID, id uuid.UUID, to, reason string) (Booking, error) {
	var out Booking
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		current, err := scanBooking(tx.QueryRow(ctx, `
			SELECT `+bookingCols+` FROM bookings b
			JOIN resources r ON r.id = b.resource_id
			WHERE b.tenant_id = $1 AND b.id = $2 FOR UPDATE OF b`, tenantID, id))
		if err != nil {
			return err
		}
		if current.Status == to {
			out = current
			return nil
		}
		ok := false
		for _, next := range allowed[current.Status] {
			if next == to {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%w: %s to %s", ErrBadTransition, current.Status, to)
		}

		if _, err := tx.Exec(ctx, `
			UPDATE bookings SET status = $3,
				cancelled_at = CASE WHEN $3 IN ('cancelled','no_show') THEN now() ELSE cancelled_at END,
				cancellation_reason = CASE WHEN $3 IN ('cancelled','no_show') THEN $4 ELSE cancellation_reason END
			WHERE tenant_id = $1 AND id = $2`, tenantID, id, to, reason); err != nil {
			return err
		}
		out, err = scanBooking(tx.QueryRow(ctx, `
			SELECT `+bookingCols+` FROM bookings b
			JOIN resources r ON r.id = b.resource_id
			WHERE b.id = $1`, id))
		if err != nil {
			return err
		}

		// Only the two states anybody downstream acts on get their own topic.
		// A booking marked arrived is an operational detail; a cancellation
		// frees a slot and may refund a deposit, and a no-show is what a
		// deposit policy turns on.
		topic := ""
		switch to {
		case "cancelled":
			topic = "booking.cancelled"
		case "no_show":
			topic = "booking.no_show"
		}
		if topic == "" {
			return nil
		}
		payload := bookingPayload(out)
		payload["reason"] = reason
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: topic, Key: id.String(), Payload: payload,
		})
		return err
	})
	return out, err
}
