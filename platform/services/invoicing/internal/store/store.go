// Package store is the Invoicing service's PostgreSQL persistence.
//
// Two rules, and everything else follows from them.
//
// A number is allocated inside the transaction that issues the document, under
// a row lock on a per-tenant counter. Not a sequence: a sequence hands out a
// number before the transaction commits, and a rolled-back transaction leaves a
// hole. Gaplessness is the constraint, and serialising concurrent issues is the
// price of it.
//
// An issued document is immutable. There is no statement in this file that
// changes what a document says. The only columns that move afterwards are the
// pointer to a correction and the reporting status, and neither is part of what
// was issued.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/invoicing/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrAlreadyCorrected is a second credit note against one document, which
	// would credit the customer twice.
	ErrAlreadyCorrected = errors.New("store: that document has already been corrected")
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

type Line struct {
	Description    string
	Quantity       int32
	UnitPriceMinor int64
	NetMinor       int64
	TaxMinor       int64
	GrossMinor     int64
	TaxBasisPoints int32
}

type Document struct {
	ID              uuid.UUID
	TenantID        uuid.UUID
	Number          string
	Year            int
	Sequence        int64
	Kind            string
	OrderID         string
	CustomerName    string
	CustomerAddress string
	CustomerTaxID   string
	NetMinor        int64
	TaxMinor        int64
	GrossMinor      int64
	Currency        string
	Artifact        []byte
	ArtifactType    string
	ReportingStatus string
	ReportingRef    string
	CorrectsID      *uuid.UUID
	CorrectedByID   *uuid.UUID
	IssuedAt        time.Time
	DueAt           *time.Time
	IdempotencyKey  string
	Lines           []Line
}

const docCols = `id, tenant_id, number, year, sequence, kind, order_id,
	customer_name, customer_address, customer_tax_id, net_minor, tax_minor,
	gross_minor, currency, artifact_type, reporting_status, reporting_reference,
	corrects_id, corrected_by_id, issued_at, due_at, idempotency_key`

func scanDoc(row pgx.Row) (Document, error) {
	var d Document
	err := row.Scan(&d.ID, &d.TenantID, &d.Number, &d.Year, &d.Sequence, &d.Kind,
		&d.OrderID, &d.CustomerName, &d.CustomerAddress, &d.CustomerTaxID,
		&d.NetMinor, &d.TaxMinor, &d.GrossMinor, &d.Currency, &d.ArtifactType,
		&d.ReportingStatus, &d.ReportingRef, &d.CorrectsID, &d.CorrectedByID,
		&d.IssuedAt, &d.DueAt, &d.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	return d, err
}

// NextNumber takes the next sequence for a tenant and year, under a lock.
//
// Exported so the caller can format the number and render the artifact with it
// on the face of the document, but it is only ever called from inside Issue's
// transaction: taking a number and not using it is exactly the hole this design
// exists to prevent.
func NextNumber(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, year int) (int64, error) {
	var next int64
	// The upsert is the lock. Two concurrent issues serialise here, which is
	// the correct trade for a document with legal weight.
	//
	// The row is created holding 2 and the conflicting path increments, so
	// "next - 1" is the number just taken in both cases. One statement rather
	// than a read and a write, because between those two a second transaction
	// takes the same number.
	err := tx.QueryRow(ctx, `
		INSERT INTO number_counters (tenant_id, year, next) VALUES ($1,$2,2)
		ON CONFLICT (tenant_id, year) DO UPDATE SET next = number_counters.next + 1
		RETURNING next - 1`, tenantID, year).Scan(&next)
	return next, err
}

// Issue writes the document, its lines and its event, in one transaction with
// the number allocation.
//
// number is a function rather than a value because the number cannot be known
// before the counter is read, and the artifact has the number printed on it:
// the caller is handed the sequence and gives back the finished document.
func (s *Store) Issue(ctx context.Context, d Document,
	finish func(year int, sequence int64) (number string, artifact []byte, err error)) (Document, bool, error) {
	if d.ID == uuid.Nil {
		d.ID = uuid.New()
	}
	if d.IssuedAt.IsZero() {
		d.IssuedAt = time.Now()
	}
	d.Year = d.IssuedAt.UTC().Year()

	var out Document
	repeat := false
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if d.IdempotencyKey != "" {
			// Checked before a number is taken. Allocating and then discovering
			// the document already exists would burn a sequence value, and a
			// burnt value is the gap this whole design avoids.
			existing, err := scanDoc(tx.QueryRow(ctx,
				`SELECT `+docCols+` FROM documents WHERE tenant_id = $1 AND idempotency_key = $2`,
				d.TenantID, d.IdempotencyKey))
			if err == nil {
				repeat = true
				out = existing
				return loadLines(ctx, tx, &out)
			}
			if !errors.Is(err, ErrNotFound) {
				return err
			}
		}

		sequence, err := NextNumber(ctx, tx, d.TenantID, d.Year)
		if err != nil {
			return err
		}
		number, artifact, err := finish(d.Year, sequence)
		if err != nil {
			return err
		}
		d.Sequence, d.Number, d.Artifact = sequence, number, artifact

		out, err = scanDoc(tx.QueryRow(ctx, `
			INSERT INTO documents (id, tenant_id, number, year, sequence, kind,
			                       order_id, customer_name, customer_address,
			                       customer_tax_id, net_minor, tax_minor, gross_minor,
			                       currency, artifact, artifact_type, reporting_status,
			                       corrects_id, issued_at, due_at, idempotency_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			RETURNING `+docCols,
			d.ID, d.TenantID, d.Number, d.Year, d.Sequence, d.Kind, d.OrderID,
			d.CustomerName, d.CustomerAddress, d.CustomerTaxID, d.NetMinor,
			d.TaxMinor, d.GrossMinor, d.Currency, d.Artifact, d.ArtifactType,
			d.ReportingStatus, d.CorrectsID, d.IssuedAt, d.DueAt, d.IdempotencyKey))
		if err != nil {
			return err
		}
		for _, l := range d.Lines {
			if _, err := tx.Exec(ctx, `
				INSERT INTO document_lines (document_id, description, quantity,
				                            unit_price_minor, net_minor, tax_minor,
				                            gross_minor, tax_basis_points)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				out.ID, l.Description, l.Quantity, l.UnitPriceMinor, l.NetMinor,
				l.TaxMinor, l.GrossMinor, l.TaxBasisPoints); err != nil {
				return err
			}
		}
		out.Lines = d.Lines

		// The original gains its pointer in the same transaction as the credit
		// note that corrects it, so there is no moment where one exists without
		// the other.
		if d.CorrectsID != nil {
			if _, err := tx.Exec(ctx,
				`UPDATE documents SET corrected_by_id = $2 WHERE id = $1`,
				*d.CorrectsID, out.ID); err != nil {
				return err
			}
		}

		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: d.TenantID, Topic: "invoice.issued", Key: out.ID.String(),
			Payload: map[string]any{
				"document_id": out.ID, "number": out.Number, "kind": out.Kind,
				"order_id": out.OrderID, "customer_name": out.CustomerName,
				"total":       map[string]any{"minor": out.GrossMinor, "currency": out.Currency},
				"net":         map[string]any{"minor": out.NetMinor, "currency": out.Currency},
				"tax":         map[string]any{"minor": out.TaxMinor, "currency": out.Currency},
				"corrects_id": out.CorrectsID,
			},
		})
		return err
	})
	return out, repeat, err
}

func loadLines(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, d *Document) error {
	rows, err := q.Query(ctx, `
		SELECT description, quantity, unit_price_minor, net_minor, tax_minor,
		       gross_minor, tax_basis_points
		FROM document_lines WHERE document_id = $1 ORDER BY id`, d.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	d.Lines = nil
	for rows.Next() {
		var l Line
		if err := rows.Scan(&l.Description, &l.Quantity, &l.UnitPriceMinor,
			&l.NetMinor, &l.TaxMinor, &l.GrossMinor, &l.TaxBasisPoints); err != nil {
			return err
		}
		d.Lines = append(d.Lines, l)
	}
	return rows.Err()
}

func (s *Store) Document(ctx context.Context, tenantID, id uuid.UUID) (Document, error) {
	d, err := scanDoc(s.pool.QueryRow(ctx,
		`SELECT `+docCols+` FROM documents WHERE tenant_id = $1 AND id = $2`, tenantID, id))
	if err != nil {
		return Document{}, err
	}
	return d, loadLines(ctx, s.pool, &d)
}

// Artifact returns the stored bytes. Kept out of the usual column list because
// a listing of a hundred documents does not want a hundred artifacts with it.
func (s *Store) Artifact(ctx context.Context, tenantID, id uuid.UUID) ([]byte, string, string, error) {
	var body []byte
	var contentType, number string
	err := s.pool.QueryRow(ctx,
		`SELECT artifact, artifact_type, number FROM documents WHERE tenant_id = $1 AND id = $2`,
		tenantID, id).Scan(&body, &contentType, &number)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", "", ErrNotFound
	}
	return body, contentType, number, err
}

// LockForCorrection reads a document for correcting and refuses a second one.
func (s *Store) LockForCorrection(ctx context.Context, tx pgx.Tx, tenantID, id uuid.UUID) (Document, error) {
	d, err := scanDoc(tx.QueryRow(ctx,
		`SELECT `+docCols+` FROM documents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
		tenantID, id))
	if err != nil {
		return Document{}, err
	}
	if d.CorrectedByID != nil {
		return Document{}, ErrAlreadyCorrected
	}
	return d, loadLines(ctx, tx, &d)
}

// Correcting reads the original outside a transaction, for the caller to build
// the credit note from before issuing it.
func (s *Store) Correcting(ctx context.Context, tenantID, id uuid.UUID) (Document, error) {
	d, err := s.Document(ctx, tenantID, id)
	if err != nil {
		return Document{}, err
	}
	if d.CorrectedByID != nil {
		return Document{}, ErrAlreadyCorrected
	}
	return d, nil
}

type Filter struct {
	Kind     string
	OrderID  string
	From     *time.Time
	To       *time.Time
	Limit    int
	BeforeAt *time.Time
	BeforeID *uuid.UUID
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Document, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+docCols+` FROM documents
		WHERE tenant_id = $1
		  AND ($2 = '' OR kind = $2)
		  AND ($3 = '' OR order_id = $3)
		  AND ($4::timestamptz IS NULL OR issued_at >= $4)
		  AND ($5::timestamptz IS NULL OR issued_at < $5)
		  AND ($6::timestamptz IS NULL OR (issued_at, id) < ($6, $7))
		ORDER BY issued_at DESC, id DESC
		LIMIT $8`,
		tenantID, f.Kind, f.OrderID, f.From, f.To, f.BeforeAt, f.BeforeID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Document
	for rows.Next() {
		d, err := scanDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
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

// Subscription is what the tenant is on and what it costs.
type Subscription struct {
	TenantID    uuid.UUID
	Tier        string
	Status      string
	Period      string
	AmountMinor int64
	Currency    string
	PeriodStart time.Time
	RenewsAt    time.Time
	CancelsAt   *time.Time
}

const subCols = `tenant_id, tier, status, period, amount_minor, currency,
	current_period_start, renews_at, cancels_at`

func scanSub(row pgx.Row) (Subscription, error) {
	var s Subscription
	err := row.Scan(&s.TenantID, &s.Tier, &s.Status, &s.Period, &s.AmountMinor,
		&s.Currency, &s.PeriodStart, &s.RenewsAt, &s.CancelsAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscription{}, ErrNotFound
	}
	return s, err
}

func (s *Store) Subscription(ctx context.Context, tenantID uuid.UUID) (Subscription, error) {
	return scanSub(s.pool.QueryRow(ctx,
		`SELECT `+subCols+` FROM subscriptions WHERE tenant_id = $1`, tenantID))
}

// EnsureSubscription creates the row on first read, so a tenant provisioned
// before this service existed has one without a backfill.
func (s *Store) EnsureSubscription(ctx context.Context, sub Subscription) (Subscription, error) {
	return scanSub(s.pool.QueryRow(ctx, `
		INSERT INTO subscriptions (tenant_id, tier, period, amount_minor, currency, renews_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
		RETURNING `+subCols,
		sub.TenantID, sub.Tier, sub.Period, sub.AmountMinor, sub.Currency, sub.RenewsAt))
}

// ChangeSubscription moves a tenant onto another tier or period, or cancels.
//
// Cancelling sets a date rather than flipping the status, because a merchant
// who has paid for the month keeps the month. The status changes when the
// billing cycle reaches the date.
func (s *Store) ChangeSubscription(ctx context.Context, tenantID uuid.UUID,
	tier, period string, amount int64, cancel bool) (Subscription, error) {
	var out Subscription
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		current, err := scanSub(tx.QueryRow(ctx,
			`SELECT `+subCols+` FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, tenantID))
		if err != nil {
			return err
		}
		var cancelsAt *time.Time
		if cancel {
			at := current.RenewsAt
			cancelsAt = &at
		}
		out, err = scanSub(tx.QueryRow(ctx, `
			UPDATE subscriptions
			SET tier = $2, period = $3, amount_minor = $4, cancels_at = $5,
			    status = CASE WHEN $5::timestamptz IS NULL AND status = 'cancelled'
			                  THEN 'active' ELSE status END,
			    updated_at = now()
			WHERE tenant_id = $1
			RETURNING `+subCols,
			tenantID, tier, period, amount, cancelsAt))
		if err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "subscription.changed", Key: tenantID.String(),
			Payload: map[string]any{
				"tier": out.Tier, "period": out.Period, "status": out.Status,
				"amount":     map[string]any{"minor": out.AmountMinor, "currency": out.Currency},
				"cancels_at": out.CancelsAt,
			},
		})
		return err
	})
	return out, err
}

// DueForBilling returns subscriptions whose period has ended.
func (s *Store) DueForBilling(ctx context.Context, through time.Time, limit int) ([]Subscription, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+subCols+` FROM subscriptions
		WHERE status <> 'cancelled' AND renews_at <= $1
		ORDER BY renews_at LIMIT $2`, through, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subscription
	for rows.Next() {
		sub, err := scanSub(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

// AdvancePeriod moves a subscription on after it has been billed, or ends it if
// the merchant cancelled.
func (s *Store) AdvancePeriod(ctx context.Context, tenantID uuid.UUID, next time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE subscriptions
		SET current_period_start = renews_at,
		    renews_at = $2,
		    status = CASE WHEN cancels_at IS NOT NULL AND cancels_at <= now()
		                  THEN 'cancelled' ELSE status END,
		    updated_at = now()
		WHERE tenant_id = $1`, tenantID, next)
	return err
}
