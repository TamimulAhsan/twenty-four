// Package store is the Payments service's PostgreSQL persistence.
//
// It belongs to the development provider. A real market implementation deploys
// its own schema, shaped by what its provider actually returns; what must not
// differ between them is the gRPC contract in front.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/payments/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrWrongState is asked for something the payment cannot do from where it
	// is: capturing a failed payment, approving one already captured.
	ErrWrongState = errors.New("store: the payment is not in a state for that")
	ErrTooMuch    = errors.New("store: more than is refundable")
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

type Payment struct {
	ID                uuid.UUID
	TenantID          uuid.UUID
	IdempotencyKey    string
	AmountMinor       int64
	Currency          string
	RefundedMinor     int64
	Status            string
	MethodKey         string
	ReferenceType     string
	ReferenceID       string
	ProviderReference string
	FailureReason     string
	Metadata          map[string]string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	CapturedAt        *time.Time
}

const cols = `id, tenant_id, idempotency_key, amount_minor, currency, refunded_minor,
              status, method_key, reference_type, reference_id, provider_reference,
              failure_reason, metadata, created_at, updated_at, captured_at`

func scan(row pgx.Row) (Payment, error) {
	var p Payment
	var meta []byte
	err := row.Scan(&p.ID, &p.TenantID, &p.IdempotencyKey, &p.AmountMinor, &p.Currency,
		&p.RefundedMinor, &p.Status, &p.MethodKey, &p.ReferenceType, &p.ReferenceID,
		&p.ProviderReference, &p.FailureReason, &meta,
		&p.CreatedAt, &p.UpdatedAt, &p.CapturedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Payment{}, ErrNotFound
	}
	if err == nil && len(meta) > 0 {
		_ = json.Unmarshal(meta, &p.Metadata)
	}
	return p, err
}

// Create is idempotent on the caller's key.
//
// This is the single most important property in the service. A till that loses
// its network mid-tender and sends the request again must get the same payment
// back, not a second charge. It is one statement with ON CONFLICT rather than a
// lookup followed by an insert, because two retries arriving at once would both
// pass a lookup.
//
// It reports whether the payment already existed, so a caller can tell a fresh
// intent from a replay.
func (s *Store) Create(ctx context.Context, p Payment) (Payment, bool, error) {
	meta, err := json.Marshal(p.Metadata)
	if err != nil {
		return Payment{}, false, fmt.Errorf("store: metadata: %w", err)
	}
	out, err := scan(s.pool.QueryRow(ctx, `
		INSERT INTO payments (id, tenant_id, idempotency_key, amount_minor, currency,
		                      status, method_key, reference_type, reference_id,
		                      provider_reference, metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
		RETURNING `+cols,
		p.ID, p.TenantID, p.IdempotencyKey, p.AmountMinor, p.Currency,
		p.Status, p.MethodKey, p.ReferenceType, p.ReferenceID, p.ProviderReference, meta))
	if err == nil {
		return out, false, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Payment{}, false, err
	}
	// The key was already used. Hand back what it produced the first time.
	existing, err := s.ByKey(ctx, p.TenantID, p.IdempotencyKey)
	return existing, true, err
}

func (s *Store) ByID(ctx context.Context, tenantID, id uuid.UUID) (Payment, error) {
	return scan(s.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM payments WHERE tenant_id = $1 AND id = $2`, tenantID, id))
}

func (s *Store) ByKey(ctx context.Context, tenantID uuid.UUID, key string) (Payment, error) {
	return scan(s.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM payments WHERE tenant_id = $1 AND idempotency_key = $2`, tenantID, key))
}

// Unscoped finds a payment by ID alone.
//
// Only the approval desk uses it, because whoever is standing at the terminal
// is not signed in as anyone: they are the customer, or the person holding the
// card machine. Knowing the UUID is what stands in for holding the card. Every
// other read is tenant-scoped, and this one is deliberately the exception.
func (s *Store) Unscoped(ctx context.Context, id uuid.UUID) (Payment, error) {
	return scan(s.pool.QueryRow(ctx, `SELECT `+cols+` FROM payments WHERE id = $1`, id))
}

type Filter struct {
	ReferenceType string
	ReferenceID   string
	Status        string
	Limit         int
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Payment, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+cols+` FROM payments
		WHERE tenant_id = $1
		  AND ($2 = '' OR reference_type = $2)
		  AND ($3 = '' OR reference_id = $3)
		  AND ($4 = '' OR status = $4)
		ORDER BY created_at DESC
		LIMIT $5`, tenantID, f.ReferenceType, f.ReferenceID, f.Status, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Payment
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Pending is the approval desk's list. Unscoped for the same reason as above.
func (s *Store) Pending(ctx context.Context, limit int) ([]Payment, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+cols+` FROM payments WHERE status = 'pending' ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Payment
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Settle moves a pending or authorised payment to its outcome and, in the same
// transaction, enqueues the event.
//
// One transaction because Invoicing issues a receipt from payment.succeeded. A
// payment that captured without its event is a sale with no receipt; an event
// without the capture is a receipt for money nobody took.
//
// `from` names the states the move is legal from, so the check is in the WHERE
// clause rather than in a caller who might forget it.
func (s *Store) Settle(ctx context.Context, id uuid.UUID, to, failureReason, providerRef string, from ...string) (Payment, error) {
	var out Payment
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scan(tx.QueryRow(ctx, `
			UPDATE payments SET
				status = $2,
				failure_reason = $3,
				provider_reference = CASE WHEN $4 = '' THEN provider_reference ELSE $4 END,
				captured_at = CASE WHEN $2 = 'captured' THEN now() ELSE captured_at END,
				updated_at = now()
			WHERE id = $1 AND status = ANY($5)
			RETURNING `+cols, id, to, failureReason, providerRef, from))
		if errors.Is(err, ErrNotFound) {
			// Either it does not exist or it is not in a state this move is
			// legal from. The caller distinguishes those; here they are the
			// same "nothing changed".
			return ErrWrongState
		}
		if err != nil {
			return err
		}
		if to != "captured" {
			return nil
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: out.TenantID, Topic: "payment.succeeded",
			// Keyed on the payment, so its own lifecycle stays in order.
			// Succeeded then refunded must never arrive reversed.
			Key: out.ID.String(),
			Payload: map[string]any{
				"payment_id": out.ID, "method_key": out.MethodKey,
				"amount":         map[string]any{"minor": out.AmountMinor, "currency": out.Currency},
				"reference_type": out.ReferenceType, "reference_id": out.ReferenceID,
				"provider_reference": out.ProviderReference,
			},
		})
		return err
	})
	return out, err
}

type Refund struct {
	ID             uuid.UUID
	PaymentID      uuid.UUID
	TenantID       uuid.UUID
	AmountMinor    int64
	Currency       string
	Reason         string
	IdempotencyKey string
}

// Refund records the refund, moves the payment's running total, and enqueues
// the event, in one transaction.
//
// The amount check is the database's, not this function's: refunded_minor may
// not exceed amount_minor, so two concurrent refunds cannot both pass a check
// and together exceed the payment.
func (s *Store) Refund(ctx context.Context, r Refund) (Payment, bool, error) {
	var out Payment
	var repeat bool

	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if r.IdempotencyKey != "" {
			var existing uuid.UUID
			err := tx.QueryRow(ctx, `
				INSERT INTO refunds (id, payment_id, tenant_id, amount_minor, currency, reason, idempotency_key)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key <> ''
				DO NOTHING
				RETURNING id`,
				r.ID, r.PaymentID, r.TenantID, r.AmountMinor, r.Currency, r.Reason, r.IdempotencyKey).
				Scan(&existing)
			if errors.Is(err, pgx.ErrNoRows) {
				repeat = true
				out, err = scan(tx.QueryRow(ctx,
					`SELECT `+cols+` FROM payments WHERE id = $1`, r.PaymentID))
				return err
			}
			if err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `
				INSERT INTO refunds (id, payment_id, tenant_id, amount_minor, currency, reason)
				VALUES ($1,$2,$3,$4,$5,$6)`,
				r.ID, r.PaymentID, r.TenantID, r.AmountMinor, r.Currency, r.Reason); err != nil {
				return err
			}
		}

		var err error
		out, err = scan(tx.QueryRow(ctx, `
			UPDATE payments SET
				refunded_minor = refunded_minor + $2,
				status = CASE WHEN refunded_minor + $2 >= amount_minor
				              THEN 'refunded' ELSE 'partially_refunded' END,
				updated_at = now()
			WHERE id = $1 AND status IN ('captured','partially_refunded')
			RETURNING `+cols, r.PaymentID, r.AmountMinor))
		if isCheckViolation(err) {
			return ErrTooMuch
		}
		if errors.Is(err, ErrNotFound) {
			return ErrWrongState
		}
		if err != nil {
			return err
		}

		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: out.TenantID, Topic: "payment.refunded", Key: out.ID.String(),
			Payload: map[string]any{
				"payment_id": out.ID, "refund_id": r.ID,
				"amount":         map[string]any{"minor": r.AmountMinor, "currency": r.Currency},
				"refunded_total": map[string]any{"minor": out.RefundedMinor, "currency": out.Currency},
				"reason":         r.Reason,
				"reference_type": out.ReferenceType,
				"reference_id":   out.ReferenceID,
				"fully_refunded": out.Status == "refunded",
			},
		})
		return err
	})
	return out, repeat, err
}

func isCheckViolation(err error) bool {
	var e interface{ SQLState() string }
	return errors.As(err, &e) && e.SQLState() == "23514"
}
