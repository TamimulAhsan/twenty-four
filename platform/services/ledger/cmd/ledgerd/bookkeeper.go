package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/services/ledger/internal/posting"
	"github.com/twentyfour/platform/services/ledger/internal/store"
)

// bookkeeper writes the books from what the operational services announced.
//
// It writes directly rather than through bus.Once, which is the same deliberate
// exception the audit trail makes and for the same reason: the entries table
// already has a unique index on the event id, so the insert is the
// deduplication. Claiming the event in a second table would mean two rows to
// say one sale was booked once.
type bookkeeper struct {
	st       *store.Store
	currency string
}

func (b *bookkeeper) handle(ctx context.Context, m bus.Message) error {
	if m.TenantID == uuid.Nil {
		slog.Warn("event with no tenant, not booked", "topic", m.Topic, "event", m.EventID)
		return bus.ErrSkip
	}
	entry, err := posting.Describe(m.Topic, m.Payload)
	if errors.Is(err, posting.ErrNotBookkeepable) {
		// Most of what crosses the bus is operational. Skipping is the normal
		// answer, not a failure.
		return bus.ErrSkip
	}
	if err != nil {
		return err
	}
	if !entry.Balanced() {
		// A posting rule that produces an unbalanced entry is a bug in the
		// rule, and the honest thing is to refuse rather than write books that
		// do not add up and discover it at year end.
		return fmt.Errorf("posting rule for %s produced an unbalanced entry", m.Topic)
	}
	// One currency per deployment. An event in another one belongs to another
	// market's books, and this is the boundary where that becomes visible.
	if entry.Currency != "" && entry.Currency != b.currency {
		slog.Error("an event arrived in the wrong currency for these books",
			"topic", m.Topic, "event", m.EventID,
			"currency", entry.Currency, "books", b.currency)
		return bus.ErrSkip
	}

	if err := b.st.EnsureChart(ctx, m.TenantID); err != nil {
		return err
	}
	eventID := m.EventID
	e := store.Entry{
		TenantID: m.TenantID, Kind: entry.Kind,
		ReferenceType: entry.ReferenceType, ReferenceID: entry.ReferenceID,
		EventID: &eventID, Memo: entry.Memo, Currency: b.currency,
		// When it happened, not when it was read. A sale belongs to the day it
		// was rung up, and an event sits in an outbox and then in a topic
		// before it gets here.
		OccurredAt: m.At,
	}
	for _, l := range entry.Lines {
		e.Lines = append(e.Lines, store.Line{
			AccountCode: l.Account, Minor: l.Minor, Memo: l.Memo,
		})
	}
	out, repeat, err := b.st.Post(ctx, e)
	if err != nil {
		return fmt.Errorf("book %s: %w", m.Topic, err)
	}
	if !repeat {
		slog.Info("booked", "topic", m.Topic, "entry", out.ID,
			"kind", out.Kind, "reference", out.ReferenceID)
	}
	return nil
}

// Page tokens. Keyset over (occurred_at, id), so a journal that grows while it
// is being read does not repeat a line.
func encodeToken(at time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id.String()))
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
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	id, err := uuid.Parse(parts[1])
	return at, id, err
}
