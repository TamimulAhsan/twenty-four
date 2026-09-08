// Package outbox is the transactional outbox: the only honest way to write to
// PostgreSQL and publish to Kafka without losing events or inventing them.
//
// Nothing in the stack offers that atomically. A service that commits and then
// publishes loses the event when the publish fails; one that publishes and then
// commits emits an event for a change that never happened. Inventory, the
// ledger and the CRM all derive state from these events, so either failure
// corrupts data that nobody is watching.
//
// The write side is one extra INSERT inside the transaction that already
// exists. The read side is the relay, which is the only thing that talks to
// Kafka.
//
// Delivery is at-least-once. The relay can publish a batch, fail before
// recording that it did, and publish it again after a restart. Every consumer
// must therefore be idempotent, keyed on the event ID or on a natural key such
// as the order reference. That is a property of the consumers; no relay can
// provide it.
package outbox

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/twentyfour/platform/packages/pg"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate creates the outbox table in the caller's own database.
//
// It runs under its own goose version table so the shared schema and the
// service's schema move independently: adding a column here must not renumber
// anyone's migrations, and a service rolling its own schema back must not take
// the outbox with it.
func Migrate(ctx context.Context, pool *pg.Pool) error {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	return pool.MigrateNamed(ctx, sub, "goose_outbox_version")
}

// Execer is satisfied by both pgx.Tx and a pool, so an event can be enqueued
// inside a transaction, which is the point, or on its own where there is no
// state change to be atomic with.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Event is what a service enqueues.
type Event struct {
	// Optional. Generated when zero, and returned, so a caller that wants to
	// reference the event ID elsewhere can.
	ID uuid.UUID
	// Required. Every event belongs to exactly one tenant.
	TenantID uuid.UUID
	// The Kafka topic, from the architecture's catalogue: "order.placed".
	Topic string
	// The partition key, and the thing that gives ordering its meaning. Events
	// that must stay in order relative to each other need the same key: an
	// order's lifecycle keyed on the order ID, say. Empty falls back to the
	// tenant, which keeps a tenant's events ordered among themselves.
	Key string
	// Marshalled to JSON. Money inside it is minor units plus a currency code,
	// never a float, exactly as it is everywhere else.
	Payload any
}

// Enqueue writes the event in the caller's transaction. It does not publish
// anything; the relay does that, later, from another process.
func Enqueue(ctx context.Context, db Execer, ev Event) (uuid.UUID, error) {
	if ev.TenantID == uuid.Nil {
		return uuid.Nil, fmt.Errorf("outbox: %q has no tenant", ev.Topic)
	}
	if ev.Topic == "" {
		return uuid.Nil, fmt.Errorf("outbox: event has no topic")
	}
	if ev.ID == uuid.Nil {
		ev.ID = uuid.New()
	}
	key := ev.Key
	if key == "" {
		key = ev.TenantID.String()
	}
	payload, err := json.Marshal(ev.Payload)
	if err != nil {
		return uuid.Nil, fmt.Errorf("outbox: marshal %s: %w", ev.Topic, err)
	}
	_, err = db.Exec(ctx, `
		INSERT INTO outbox (id, tenant_id, topic, key, payload)
		VALUES ($1,$2,$3,$4,$5)`,
		ev.ID, ev.TenantID, ev.Topic, key, payload)
	if err != nil {
		return uuid.Nil, fmt.Errorf("outbox: enqueue %s: %w", ev.Topic, err)
	}
	return ev.ID, nil
}

// Record is one row on its way out.
type Record struct {
	ID        uuid.UUID
	TenantID  uuid.UUID
	Topic     string
	Key       string
	Payload   []byte
	Attempts  int
	CreatedAt time.Time
}

// Publisher is whatever puts the batch on the bus. The relay supplies a Kafka
// implementation; tests supply one that records what it was given.
//
// It must publish the batch in the order it was handed, and return an error if
// any record was not acknowledged.
type Publisher interface {
	Publish(ctx context.Context, recs []Record) error
}

// maxBackoff caps the retry delay. Beyond a few minutes the extra wait buys
// nothing: whatever is broken needs a person, not more patience.
const maxBackoff = 5 * time.Minute

// Drain claims a batch, publishes it, and marks it published, all in one
// transaction.
//
// Holding a transaction open across a network call is the deliberate part.
// SELECT ... FOR UPDATE SKIP LOCKED means a second relay takes different rows
// rather than the same ones, and committing only after Kafka acknowledges means
// a crash re-publishes rather than drops. The cost is at-least-once delivery,
// which the consumers already have to tolerate.
//
// It returns the number of records published.
func Drain(ctx context.Context, pool *pg.Pool, batch int, pub Publisher) (int, error) {
	if batch <= 0 {
		batch = 100
	}
	var published int
	var publishErr error

	err := pool.Tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, topic, key, payload, attempts, created_at
			FROM outbox
			WHERE published_at IS NULL AND available_at <= now()
			ORDER BY created_at, id
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, batch)
		if err != nil {
			return fmt.Errorf("outbox: claim: %w", err)
		}
		var recs []Record
		for rows.Next() {
			var r Record
			if err := rows.Scan(&r.ID, &r.TenantID, &r.Topic, &r.Key,
				&r.Payload, &r.Attempts, &r.CreatedAt); err != nil {
				rows.Close()
				return fmt.Errorf("outbox: scan: %w", err)
			}
			recs = append(recs, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("outbox: claim: %w", err)
		}
		if len(recs) == 0 {
			return nil
		}

		ids := make([]uuid.UUID, len(recs))
		for i, r := range recs {
			ids[i] = r.ID
		}

		if err := pub.Publish(ctx, recs); err != nil {
			// Record the failure and commit it. Rolling back here would
			// discard the attempt count, and the backoff with it, so the same
			// unpublishable row would spin at the head of the queue.
			publishErr = err
			_, uerr := tx.Exec(ctx, `
				UPDATE outbox SET
					attempts     = attempts + 1,
					last_error   = $2,
					available_at = now() + least(power(2, attempts + 1), $3)::int * interval '1 second'
				WHERE id = ANY($1)`, ids, truncate(err.Error(), 500), int(maxBackoff.Seconds()))
			return uerr
		}

		if _, err := tx.Exec(ctx,
			`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1)`, ids); err != nil {
			return fmt.Errorf("outbox: mark published: %w", err)
		}
		published = len(recs)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return published, publishErr
}

// Purge deletes published rows older than age, and reports how many went.
//
// Retention is not settled: the rows are an audit trail of everything the
// system has ever announced, and they also grow without bound. The relay
// therefore ships with this turned off, so the decision is made deliberately
// rather than by whatever the default happened to be.
func Purge(ctx context.Context, pool *pg.Pool, age time.Duration) (int64, error) {
	if age <= 0 {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `
		DELETE FROM outbox
		WHERE published_at IS NOT NULL AND published_at < now() - $1::int * interval '1 second'`,
		int(age.Seconds()))
	if err != nil {
		return 0, fmt.Errorf("outbox: purge: %w", err)
	}
	return tag.RowsAffected(), nil
}

// Backlog is what a health check and a dashboard both want: how far behind the
// relay is, and whether anything is stuck.
type Backlog struct {
	Pending int64
	Failing int64
	Oldest  time.Time
}

func Stats(ctx context.Context, pool *pg.Pool) (Backlog, error) {
	var b Backlog
	var oldest *time.Time
	err := pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE attempts > 0),
		       min(created_at)
		FROM outbox WHERE published_at IS NULL`).Scan(&b.Pending, &b.Failing, &oldest)
	if oldest != nil {
		b.Oldest = *oldest
	}
	return b, err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
