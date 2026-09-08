// Package kafka is the relay's publisher: the only place in the platform that
// writes to the bus directly.
//
// Every other service enqueues into its own outbox and stops caring. That is
// what makes "a broker outage must never block a sale" true rather than
// aspirational: with the bus down, orders still commit and events pile up in
// Postgres until it comes back.
package kafka

import (
	"context"
	"fmt"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/twentyfour/platform/packages/outbox"
)

// Header names carried on every record. Consumers dedupe on event-id, because
// delivery is at-least-once and a redelivered batch is normal, not exceptional.
const (
	HeaderEventID = "event-id"
	HeaderTenant  = "tenant-id"
	HeaderSource  = "source"
)

// Publisher is shared by every source. One client, not one per database: the
// brokers are the same, and a single client is also what makes the readiness
// probe answerable before any source has been discovered.
type Publisher struct {
	cl *kgo.Client
}

// New connects to the brokers. It does not block on reachability: the relay
// should start, report itself unready, and keep trying, rather than crash-loop
// while Kafka is coming up beside it.
func New(brokers []string) (*Publisher, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		// The whole point of the outbox is that a record is durable before it
		// is acknowledged. Anything weaker than all in-sync replicas would
		// throw that away at the last step.
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.ProducerBatchMaxBytes(4<<20),
		kgo.RecordRetries(3),
		kgo.ProduceRequestTimeout(15*time.Second),
		// Development convenience. In a real environment topics are created
		// with a chosen partition count and retention, not implicitly.
		kgo.AllowAutoTopicCreation(),
	)
	if err != nil {
		return nil, fmt.Errorf("kafka: client: %w", err)
	}
	return &Publisher{cl: cl}, nil
}

// For returns a publisher bound to one source, which is the shape the outbox
// package's Drain expects. The source name rides along as a record header so a
// consumer can tell which service announced something.
func (p *Publisher) For(source string) outbox.Publisher {
	return sourcePublisher{p: p, source: source}
}

type sourcePublisher struct {
	p      *Publisher
	source string
}

func (s sourcePublisher) Publish(ctx context.Context, recs []outbox.Record) error {
	return s.p.publish(ctx, s.source, recs)
}

func (p *Publisher) Close() { p.cl.Close() }

// Publish sends the batch and waits for every acknowledgement.
//
// Synchronous on purpose. The relay is holding a database transaction open
// while this runs, and only commits once Kafka has the records; returning
// before then would mean marking rows published that are not.
func (p *Publisher) publish(ctx context.Context, source string, recs []outbox.Record) error {
	if len(recs) == 0 {
		return nil
	}
	out := make([]*kgo.Record, len(recs))
	for i, r := range recs {
		out[i] = &kgo.Record{
			Topic: r.Topic,
			Key:   []byte(r.Key),
			Value: r.Payload,
			Headers: []kgo.RecordHeader{
				{Key: HeaderEventID, Value: []byte(r.ID.String())},
				{Key: HeaderTenant, Value: []byte(r.TenantID.String())},
				{Key: HeaderSource, Value: []byte(source)},
			},
		}
	}
	results := p.cl.ProduceSync(ctx, out...)
	if err := results.FirstErr(); err != nil {
		return fmt.Errorf("kafka: publish %d records: %w", len(out), err)
	}
	return nil
}

// Reachable is what the readiness probe asks. A relay that cannot reach the bus
// is not broken, but it is not doing its job either, and that difference should
// be visible before the backlog is.
func (p *Publisher) Reachable(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return p.cl.Ping(ctx)
}
