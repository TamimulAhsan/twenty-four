// Package store is the Notification service's PostgreSQL persistence.
//
// The shape to understand: a delivery row is written with its rendered text
// already in it, and never re-rendered. That mirrors the invoicing rule for the
// same reason. The question asked later is what the customer actually received,
// and re-rendering against a template edited since answers a different
// question convincingly enough that nobody notices it is the wrong one.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/notification/migrations"
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

// Migrate runs the service's own schema, then the shared outbox and consumer
// schemas. Three version tables, so a change to one never renumbers another.
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

// Preferences is the tenant's sending policy.
type Preferences struct {
	TenantID         uuid.UUID
	Channels         []string
	QuietFrom        string
	QuietTo          string
	TimeZone         string
	BookingReminders bool
	ReceiptByEmail   bool
	Marketing        bool
	UpdatedAt        time.Time
}

// Allows reports whether this policy permits a message on a channel in a
// category.
//
// Two separate refusals, and they are not the same thing. A channel the
// business has not set up cannot carry anything, transactional included: there
// is no transport. A category switched off is a choice about content, and
// transactional messages override it, because a password reset is not a
// preference.
func (p Preferences) Allows(channel, category string) (bool, string) {
	allowed := false
	for _, c := range p.Channels {
		if c == channel {
			allowed = true
			break
		}
	}
	if !allowed {
		return false, "this business does not send on " + channel
	}
	if category == "transactional" {
		return true, ""
	}
	switch category {
	case "reminder":
		if !p.BookingReminders {
			return false, "reminders are switched off"
		}
	case "receipt":
		if !p.ReceiptByEmail && channel == "email" {
			return false, "emailed receipts are switched off"
		}
	case "marketing":
		if !p.Marketing {
			return false, "marketing messages are not opted into"
		}
	}
	return true, ""
}

// HeldUntil reports when a message may go out, or the zero time if it may go
// now.
//
// Transactional messages are never held. Somebody is standing there waiting for
// the reset link, and a quiet-hours window that delays it turns a setting about
// politeness into a support ticket.
func (p Preferences) HeldUntil(now time.Time, category string) time.Time {
	if category == "transactional" || p.QuietFrom == p.QuietTo {
		return time.Time{}
	}
	loc, err := time.LoadLocation(p.TimeZone)
	if err != nil {
		// An unknown zone must not become "send it anyway at 3am". Falling back
		// to UTC keeps the window a window; it may be the wrong hours, and that
		// is visible in the log, which a silent bypass would not be.
		loc = time.UTC
	}
	local := now.In(loc)
	from, okFrom := parseClock(p.QuietFrom)
	to, okTo := parseClock(p.QuietTo)
	if !okFrom || !okTo {
		return time.Time{}
	}
	minutes := local.Hour()*60 + local.Minute()

	// The window usually wraps midnight, which is why this is not a simple
	// range test: 21:00 to 08:00 is quiet at 23:00 and at 02:00, and noisy at
	// noon. Both orders are legitimate.
	quiet := false
	if from <= to {
		quiet = minutes >= from && minutes < to
	} else {
		quiet = minutes >= from || minutes < to
	}
	if !quiet {
		return time.Time{}
	}

	end := time.Date(local.Year(), local.Month(), local.Day(), to/60, to%60, 0, 0, loc)
	if !end.After(local) {
		end = end.AddDate(0, 0, 1)
	}
	return end.UTC()
}

func parseClock(s string) (int, bool) {
	var h, m int
	if _, err := fmt.Sscanf(s, "%d:%d", &h, &m); err != nil {
		return 0, false
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

const prefCols = `tenant_id, channels, quiet_from, quiet_to, time_zone,
	booking_reminders, receipt_by_email, marketing, updated_at`

func scanPrefs(row pgx.Row) (Preferences, error) {
	var p Preferences
	err := row.Scan(&p.TenantID, &p.Channels, &p.QuietFrom, &p.QuietTo, &p.TimeZone,
		&p.BookingReminders, &p.ReceiptByEmail, &p.Marketing, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return p, err
}

// Preferences returns the tenant's policy, creating it from the platform
// defaults on first read.
//
// Created on read rather than at provisioning, because a service that only
// works for tenants provisioned after it existed is a service with a migration
// waiting to be written. The defaults are in the schema, so there is one copy
// of them.
func (s *Store) Preferences(ctx context.Context, tenantID uuid.UUID) (Preferences, error) {
	p, err := scanPrefs(s.pool.QueryRow(ctx,
		`SELECT `+prefCols+` FROM preferences WHERE tenant_id = $1`, tenantID))
	if err == nil || !errors.Is(err, ErrNotFound) {
		return p, err
	}
	return scanPrefs(s.pool.QueryRow(ctx, `
		INSERT INTO preferences (tenant_id) VALUES ($1)
		ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
		RETURNING `+prefCols, tenantID))
}

// PreferencePatch is a partial update. A nil field is left alone, which is what
// stops a merchant editing quiet hours from silently resetting their channels.
type PreferencePatch struct {
	Channels         *[]string
	QuietFrom        *string
	QuietTo          *string
	TimeZone         *string
	BookingReminders *bool
	ReceiptByEmail   *bool
	Marketing        *bool
}

func (s *Store) UpdatePreferences(ctx context.Context, tenantID uuid.UUID, patch PreferencePatch) (Preferences, error) {
	if _, err := s.Preferences(ctx, tenantID); err != nil {
		return Preferences{}, err
	}
	return scanPrefs(s.pool.QueryRow(ctx, `
		UPDATE preferences SET
			channels          = coalesce($2, channels),
			quiet_from        = coalesce($3, quiet_from),
			quiet_to          = coalesce($4, quiet_to),
			time_zone         = coalesce($5, time_zone),
			booking_reminders = coalesce($6, booking_reminders),
			receipt_by_email  = coalesce($7, receipt_by_email),
			marketing         = coalesce($8, marketing),
			updated_at        = now()
		WHERE tenant_id = $1
		RETURNING `+prefCols,
		tenantID, patch.Channels, patch.QuietFrom, patch.QuietTo, patch.TimeZone,
		patch.BookingReminders, patch.ReceiptByEmail, patch.Marketing))
}

// Template is a tenant's own wording for a message.
type Template struct {
	Key       string
	Channel   string
	Category  string
	Subject   string
	Body      string
	UpdatedAt time.Time
}

func (s *Store) Template(ctx context.Context, tenantID uuid.UUID, key string) (Template, error) {
	var t Template
	err := s.pool.QueryRow(ctx, `
		SELECT key, channel, category, subject, body, updated_at
		FROM templates WHERE tenant_id = $1 AND key = $2`, tenantID, key).
		Scan(&t.Key, &t.Channel, &t.Category, &t.Subject, &t.Body, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Template{}, ErrNotFound
	}
	return t, err
}

func (s *Store) ListTemplates(ctx context.Context, tenantID uuid.UUID) ([]Template, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT key, channel, category, subject, body, updated_at
		FROM templates WHERE tenant_id = $1 ORDER BY key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Template
	for rows.Next() {
		var t Template
		if err := rows.Scan(&t.Key, &t.Channel, &t.Category, &t.Subject, &t.Body, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) UpsertTemplate(ctx context.Context, tenantID uuid.UUID, t Template) (Template, error) {
	var out Template
	err := s.pool.QueryRow(ctx, `
		INSERT INTO templates (tenant_id, key, channel, category, subject, body)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (tenant_id, key) DO UPDATE
		SET channel = EXCLUDED.channel, category = EXCLUDED.category,
		    subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()
		RETURNING key, channel, category, subject, body, updated_at`,
		tenantID, t.Key, t.Channel, t.Category, t.Subject, t.Body).
		Scan(&out.Key, &out.Channel, &out.Category, &out.Subject, &out.Body, &out.UpdatedAt)
	return out, err
}

func (s *Store) DeleteTemplate(ctx context.Context, tenantID uuid.UUID, key string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM templates WHERE tenant_id = $1 AND key = $2`, tenantID, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Delivery is one message, and the record that it happened.
type Delivery struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	TemplateKey    string
	Channel        string
	Category       string
	Status         string
	Recipient      string
	Subject        string
	Body           string
	ReferenceType  string
	ReferenceID    string
	DeliverAfter   *time.Time
	Attempts       int32
	FailureReason  string
	CreatedAt      time.Time
	SentAt         *time.Time
	IdempotencyKey string
}

const deliveryCols = `id, tenant_id, template_key, channel, category, status,
	recipient, subject, body, reference_type, reference_id, deliver_after,
	attempts, failure_reason, created_at, sent_at, idempotency_key`

func scanDelivery(row pgx.Row) (Delivery, error) {
	var d Delivery
	err := row.Scan(&d.ID, &d.TenantID, &d.TemplateKey, &d.Channel, &d.Category,
		&d.Status, &d.Recipient, &d.Subject, &d.Body, &d.ReferenceType, &d.ReferenceID,
		&d.DeliverAfter, &d.Attempts, &d.FailureReason, &d.CreatedAt, &d.SentAt,
		&d.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Delivery{}, ErrNotFound
	}
	return d, err
}

// Enqueue records a message and, when it is not suppressed, an event saying so.
//
// It returns the existing row for a repeated idempotency key rather than
// writing a second one, so a till that retries a receipt after losing its
// network does not send two.
func (s *Store) Enqueue(ctx context.Context, d Delivery) (Delivery, bool, error) {
	var out Delivery
	repeat := false
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scanDelivery(tx.QueryRow(ctx, `
			INSERT INTO deliveries (id, tenant_id, template_key, channel, category,
			                        status, recipient, subject, body,
			                        reference_type, reference_id, deliver_after,
			                        failure_reason, idempotency_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key <> ''
			DO NOTHING
			RETURNING `+deliveryCols,
			uuid.New(), d.TenantID, d.TemplateKey, d.Channel, d.Category, d.Status,
			d.Recipient, d.Subject, d.Body, d.ReferenceType, d.ReferenceID,
			d.DeliverAfter, d.FailureReason, d.IdempotencyKey))
		if errors.Is(err, ErrNotFound) {
			repeat = true
			out, err = scanDelivery(tx.QueryRow(ctx,
				`SELECT `+deliveryCols+` FROM deliveries
				 WHERE tenant_id = $1 AND idempotency_key = $2`,
				d.TenantID, d.IdempotencyKey))
			return err
		}
		if err != nil {
			return err
		}
		// A suppressed message is recorded but never announced. An event saying
		// a notification was queued, for one that will never go, is an event
		// every consumer has to learn to disbelieve.
		if out.Status == "suppressed" {
			return nil
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: d.TenantID,
			Topic:    "notification.queued",
			Key:      out.ID.String(),
			Payload: map[string]any{
				"delivery_id": out.ID, "template_key": out.TemplateKey,
				"channel": out.Channel, "category": out.Category,
				"reference_type": out.ReferenceType, "reference_id": out.ReferenceID,
				"held": out.Status == "held",
			},
		})
		return err
	})
	return out, repeat, err
}

func (s *Store) Delivery(ctx context.Context, tenantID, id uuid.UUID) (Delivery, error) {
	return scanDelivery(s.pool.QueryRow(ctx,
		`SELECT `+deliveryCols+` FROM deliveries WHERE tenant_id = $1 AND id = $2`,
		tenantID, id))
}

// DeliveryFilter narrows the log. Every field is optional.
type DeliveryFilter struct {
	Status        string
	Channel       string
	ReferenceType string
	ReferenceID   string
	Limit         int
	// Keyset, not offset: the log grows at the head while it is being read, and
	// an offset would show the same row twice.
	BeforeCreated *time.Time
	BeforeID      *uuid.UUID
}

func (s *Store) ListDeliveries(ctx context.Context, tenantID uuid.UUID, f DeliveryFilter) ([]Delivery, error) {
	q := `SELECT ` + deliveryCols + ` FROM deliveries WHERE tenant_id = $1
	      AND ($2 = '' OR status = $2)
	      AND ($3 = '' OR channel = $3)
	      AND ($4 = '' OR reference_type = $4)
	      AND ($5 = '' OR reference_id = $5)
	      AND ($6::timestamptz IS NULL OR (created_at, id) < ($6, $7))
	      ORDER BY created_at DESC, id DESC
	      LIMIT $8`
	rows, err := s.pool.Query(ctx, q, tenantID, f.Status, f.Channel,
		f.ReferenceType, f.ReferenceID, f.BeforeCreated, f.BeforeID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ClaimDue takes up to n messages whose time has come, marking them in flight
// so a second sender does not take the same ones.
//
// SKIP LOCKED rather than a status flip in a separate statement: two senders
// racing on the same row is exactly the case that sends a message twice, and
// the lock is what makes the claim atomic with the read.
func (s *Store) ClaimDue(ctx context.Context, n int) ([]Delivery, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE deliveries SET attempts = attempts + 1
		WHERE id IN (
			SELECT id FROM deliveries
			WHERE status IN ('queued','held')
			  AND (deliver_after IS NULL OR deliver_after <= now())
			ORDER BY created_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING `+deliveryCols, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// MarkSent records a delivery and announces it, in one transaction.
func (s *Store) MarkSent(ctx context.Context, d Delivery) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE deliveries
			SET status = 'sent', sent_at = now(), deliver_after = NULL, failure_reason = ''
			WHERE id = $1`, d.ID); err != nil {
			return err
		}
		_, err := outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: d.TenantID,
			Topic:    "notification.sent",
			Key:      d.ID.String(),
			Payload: map[string]any{
				"delivery_id": d.ID, "template_key": d.TemplateKey,
				"channel": d.Channel, "category": d.Category,
				"reference_type": d.ReferenceType, "reference_id": d.ReferenceID,
			},
		})
		return err
	})
}

// MarkFailed backs a message off, and gives up after enough attempts.
//
// Giving up is deliberate rather than retrying forever. A wrong address never
// becomes a right one, and a queue that keeps a dead message at its head is a
// queue that stops moving.
func (s *Store) MarkFailed(ctx context.Context, d Delivery, reason string, maxAttempts int32) error {
	if d.Attempts >= maxAttempts {
		_, err := s.pool.Exec(ctx, `
			UPDATE deliveries SET status = 'failed', failure_reason = $2, deliver_after = NULL
			WHERE id = $1`, d.ID, reason)
		return err
	}
	backoff := time.Duration(1<<uint(d.Attempts)) * time.Minute
	if backoff > 30*time.Minute {
		backoff = 30 * time.Minute
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE deliveries SET status = 'queued', failure_reason = $2, deliver_after = $3
		WHERE id = $1`, d.ID, reason, time.Now().Add(backoff))
	return err
}

// Recent and Unscoped serve the development desk, which is not tenant scoped.
//
// That is not an oversight and it is not a hole in tenantctx: the desk stands
// in for a provider's own dashboard, and a provider sees every message it was
// asked to carry. It is also why the desk must never be deployed anywhere real,
// which is the same sentence the payment desk carries.
func (s *Store) Recent(ctx context.Context, n int) ([]Delivery, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+deliveryCols+` FROM deliveries ORDER BY created_at DESC, id DESC LIMIT $1`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) Unscoped(ctx context.Context, id uuid.UUID) (Delivery, error) {
	return scanDelivery(s.pool.QueryRow(ctx,
		`SELECT `+deliveryCols+` FROM deliveries WHERE id = $1`, id))
}
