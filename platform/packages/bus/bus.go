// Package bus is the read side of the event platform: the half the outbox
// deliberately does not provide.
//
// The relay publishes at-least-once. It can write a batch to Kafka, fail before
// recording that it did, and write it again after a restart. That is not a bug
// to be fixed in the relay; it is the only delivery guarantee a transactional
// outbox can offer without distributed transactions, and the outbox package
// says so. The consequence lands here: every consumer must be idempotent, and
// idempotency is a property of the consumer, not of the bus.
//
// So this package is two things that belong together. A consumer group reader,
// and the table that remembers which event IDs have already been handled. A
// reader without the table is a service that double-counts on the first
// rebalance; a table without the reader is a good idea nobody applied.
//
// What it is not: a framework. A handler gets one message and returns an error.
// Returning an error means the message is not committed, which means it will
// come back. That is the whole contract.
package bus

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/twentyfour/platform/packages/pg"
)

// Header names, matching what the relay writes. Kept here rather than imported
// from the relay so a consumer does not depend on a service.
const (
	HeaderEventID = "event-id"
	HeaderTenant  = "tenant-id"
	HeaderSource  = "source"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate creates the handled-events table in the consumer's own database,
// under its own goose version table for the same reason the outbox has one:
// a change here must not renumber a service's migrations.
func Migrate(ctx context.Context, pool *pg.Pool) error {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	return pool.MigrateNamed(ctx, sub, "goose_bus_version")
}

// Message is one event off the bus, already unwrapped from the record.
type Message struct {
	// EventID is the relay's, and the same across every redelivery of the same
	// event. It is what makes deduplication possible at all.
	EventID  uuid.UUID
	TenantID uuid.UUID
	Topic    string
	// Source is the service whose outbox the event came from.
	Source string
	Key    string
	// Payload is the event body as the producing service wrote it. Money in it
	// is minor units plus a currency code, never a float.
	Payload json.RawMessage
	// At is the broker's timestamp, which is when the relay published, not when
	// the change happened. A consumer that needs the second reads it from the
	// payload, where the producing service put it.
	At time.Time
}

// Into unmarshals the payload into v.
func (m Message) Into(v any) error {
	if err := json.Unmarshal(m.Payload, v); err != nil {
		return fmt.Errorf("bus: decode %s: %w", m.Topic, err)
	}
	return nil
}

// Handler processes one message.
//
// Returning nil commits it. Returning an error does not: the message will be
// delivered again, so a handler that cannot ever succeed must not return an
// error forever. Use ErrSkip for a message this consumer will never handle,
// which is a different statement from "it worked".
type Handler func(ctx context.Context, m Message) error

// ErrSkip says the message is not this consumer's business and never will be.
// It commits, because retrying it changes nothing.
var ErrSkip = errors.New("bus: not for this consumer")

// Consumer reads one group's topics and hands each message to a handler.
type Consumer struct {
	cl      *kgo.Client
	handler Handler
	name    string
}

// NewConsumer joins the group. It does not block on the brokers being
// reachable: a service should start, report itself unready if it must, and keep
// trying, rather than crash-loop while Kafka comes up beside it.
func NewConsumer(brokers []string, group string, topics []string, h Handler) (*Consumer, error) {
	return newConsumer(brokers, group, topics, false, false, h)
}

// NewRegexConsumer matches topics by pattern rather than by name, and reads
// each newly matched topic from its beginning.
//
// One consumer wants this and it is worth the extra constructor: the audit
// trail is a record of what happened, and a trail that only covers the topics
// somebody remembered to add to a list is a trail with holes in exactly the
// places nobody was watching. Every other consumer should name its topics,
// because subscribing to everything to use three of them is a service that
// wakes up for every sale in the market.
//
// Reading from the beginning goes with it, and the two are not separable. A
// pattern consumer discovers a topic on a metadata refresh, which is after the
// topic was created and therefore after the record that created it. Starting at
// the end would skip exactly the first event on every new topic: the very
// events a growing platform produces most of. Starting at the beginning
// backfills instead, which is safe because the handled-events table makes a
// replay cheap and because a trail wants everything a topic still holds.
func NewRegexConsumer(brokers []string, group string, patterns []string, h Handler) (*Consumer, error) {
	return newConsumer(brokers, group, patterns, true, true, h)
}

func newConsumer(brokers []string, group string, topics []string, asRegex, fromStart bool, h Handler) (*Consumer, error) {
	if len(topics) == 0 {
		return nil, errors.New("bus: a consumer with no topics would poll forever for nothing")
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(brokers...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topics...),
		// Commit explicitly, after the handler has returned, so a crash between
		// handling and committing redelivers rather than loses. That is the
		// direction to fail in when the handler is idempotent, and the handled
		// table below is what makes it idempotent.
		kgo.DisableAutoCommit(),
	}
	// Where a consumer starts on a topic it has no committed offset for.
	//
	// At the end for a named consumer: a notification service joining a topic
	// for the first time must not send a year of stale email. At the beginning
	// for a pattern consumer, for the reason on NewRegexConsumer.
	if fromStart {
		opts = append(opts, kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	} else {
		opts = append(opts, kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()))
	}
	if asRegex {
		// Topics are discovered on a metadata refresh, and on a platform that
		// is still growing a service a week, five minutes of not noticing a new
		// topic is five minutes of trail that has to be backfilled instead of
		// recorded as it happens.
		opts = append(opts, kgo.ConsumeRegex(), kgo.MetadataMaxAge(time.Minute))
	}
	cl, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("bus: client: %w", err)
	}
	return &Consumer{cl: cl, handler: h, name: group}, nil
}

// Run polls until the context is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	for {
		fetches := c.cl.PollFetches(ctx)
		if ctx.Err() != nil {
			return nil
		}
		var fatal error
		fetches.EachError(func(topic string, partition int32, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			// A fetch error is usually a rebalance or a broker restart. Log it
			// and keep polling: the client reconnects on its own, and exiting
			// here would turn a blip into a restart loop.
			slog.Warn("bus fetch", "group", c.name, "topic", topic,
				"partition", partition, "err", err)
		})
		if fatal != nil {
			return fatal
		}

		var failed bool
		fetches.EachRecord(func(rec *kgo.Record) {
			if failed {
				// Stop handing over messages once one has failed. Committing
				// past a message that did not succeed is how a gap appears.
				return
			}
			m := decode(rec)
			err := c.handler(ctx, m)
			switch {
			case err == nil, errors.Is(err, ErrSkip):
			case errors.Is(err, context.Canceled):
				failed = true
			default:
				slog.Error("bus handler", "group", c.name, "topic", rec.Topic,
					"event", m.EventID, "err", err)
				failed = true
			}
		})
		if failed {
			// Do not commit. The batch comes back, and the handled table means
			// the messages that did succeed are cheap the second time.
			continue
		}
		if err := c.cl.CommitUncommittedOffsets(ctx); err != nil && ctx.Err() == nil {
			slog.Error("bus commit", "group", c.name, "err", err)
		}
	}
}

func (c *Consumer) Close() { c.cl.Close() }

func decode(rec *kgo.Record) Message {
	m := Message{
		Topic:   rec.Topic,
		Key:     string(rec.Key),
		Payload: json.RawMessage(rec.Value),
		At:      rec.Timestamp,
	}
	for _, h := range rec.Headers {
		switch h.Key {
		case HeaderEventID:
			m.EventID, _ = uuid.Parse(string(h.Value))
		case HeaderTenant:
			m.TenantID, _ = uuid.Parse(string(h.Value))
		case HeaderSource:
			m.Source = string(h.Value)
		}
	}
	return m
}

// Once runs fn exactly once per event ID, in one transaction with the record
// that says it ran.
//
// This is the whole of idempotency, and it is deliberately not optional
// machinery a handler can forget: the insert is what claims the event, so two
// deliveries racing each other cannot both pass. A handler that writes outside
// this transaction has opted out of the guarantee and should say so in a
// comment, because it is now responsible for its own.
//
// It reports whether fn actually ran, which a caller usually only wants for a
// log line: a redelivery is normal, not exceptional.
func Once(ctx context.Context, pool *pg.Pool, consumer string, m Message,
	fn func(ctx context.Context, tx pgx.Tx) error) (bool, error) {
	if m.EventID == uuid.Nil {
		// Without an ID there is nothing to deduplicate on, and pretending
		// otherwise would silently drop the guarantee.
		return false, fmt.Errorf("bus: %s carries no %s header", m.Topic, HeaderEventID)
	}
	ran := false
	err := pool.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO handled_events (consumer, event_id, tenant_id, topic)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (consumer, event_id) DO NOTHING`,
			consumer, m.EventID, m.TenantID, m.Topic)
		if err != nil {
			return fmt.Errorf("bus: claim %s: %w", m.EventID, err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		ran = true
		return fn(ctx, tx)
	})
	if err != nil {
		return false, err
	}
	return ran, nil
}
