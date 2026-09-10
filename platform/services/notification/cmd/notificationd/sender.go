package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/services/notification/internal/store"
)

// Transport is what actually carries a message off the platform.
//
// One method, and it is allowed to fail. That is the whole seam the market
// swap needs: Hungary and Bangladesh will not share an SMS aggregator, and
// neither of them will be reached from this file.
//
// It deliberately does not return a provider reference or a delivery receipt.
// Adding either now would be guessing at the shape of a provider nobody has
// chosen, and a field invented early is a field every implementation has to
// pretend to fill.
type Transport interface {
	Send(ctx context.Context, d store.Delivery) error
}

// recordingTransport is the development transport: it records and does not
// send.
//
// A transport that always succeeded instantly would be worse than useless. It
// would let callers grow a dependence on delivery being immediate and certain,
// and the first real provider, with its rate limits, its bounces and its
// queues, would break every one of them. This one does the honest minimum:
// marks the message sent, and puts it somewhere a person can read it.
type recordingTransport struct{}

func (recordingTransport) Send(_ context.Context, d store.Delivery) error {
	if d.Channel == "email" && !strings.Contains(d.Recipient, "@") {
		// The one failure it does simulate, because it is the failure every
		// real provider has and the one a caller most often causes.
		return fmt.Errorf("%q is not an address anything can be sent to", d.Recipient)
	}
	slog.Info("message recorded but not sent: there is no real transport in this deployment",
		"delivery", d.ID, "template", d.TemplateKey, "channel", d.Channel,
		"to", d.Recipient, "subject", d.Subject)
	return nil
}

// sender drains the queue.
//
// It is a poller rather than a queue library on purpose. River is in the stack
// for durable work with retries and schedules, and this is a table with a
// claim on it, which Postgres already does well. Adding a job runtime to send
// email would be a second scheduler in a service whose whole queue is one
// index.
type sender struct {
	st          *store.Store
	transport   Transport
	batch       int
	maxAttempts int32
	interval    time.Duration
}

func (s *sender) run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.pass(ctx)
		}
	}
}

func (s *sender) pass(ctx context.Context) {
	due, err := s.st.ClaimDue(ctx, s.batch)
	if err != nil {
		slog.Error("claim messages", "err", err)
		return
	}
	for _, d := range due {
		if err := s.transport.Send(ctx, d); err != nil {
			if markErr := s.st.MarkFailed(ctx, d, err.Error(), s.maxAttempts); markErr != nil {
				slog.Error("record failure", "delivery", d.ID, "err", markErr)
			}
			continue
		}
		if err := s.st.MarkSent(ctx, d); err != nil {
			// The message went out and the record of it did not. Logged loudly
			// because the next pass will send it again: that is the direction
			// to fail in when the alternative is a receipt nobody ever gets,
			// but it is still a duplicate somebody may notice.
			slog.Error("message sent but not recorded", "delivery", d.ID, "err", err)
		}
	}
}

// Page tokens. Keyset over (created_at, id), the same shape Catalog uses, so a
// log that grows while it is being read does not show a row twice.
func encodeToken(created time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(created.UTC().Format(time.RFC3339Nano) + "|" + id.String()))
}

func decodeToken(tok string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, fmt.Errorf("malformed token")
	}
	created, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	id, err := uuid.Parse(parts[1])
	return created, id, err
}
