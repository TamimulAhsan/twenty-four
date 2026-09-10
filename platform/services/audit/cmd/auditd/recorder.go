package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/services/audit/internal/phrasing"
	"github.com/twentyfour/platform/services/audit/internal/store"
)

// recorder turns events into trail entries.
//
// It writes directly rather than through bus.Once, and that is a deliberate
// exception to the rule the package states. The entries table already has a
// unique index on the event ID, so the insert itself is the deduplication:
// going through the handled-events table as well would mean two rows written
// to say one thing happened once.
type recorder struct{ st *store.Store }

func (r *recorder) handle(ctx context.Context, m bus.Message) error {
	if m.TenantID == uuid.Nil {
		// Every event belongs to exactly one tenant, and the outbox refuses one
		// that does not. An event arriving here without a tenant came from
		// somewhere that is not the relay, and the trail is not the place to
		// guess whose business it concerns.
		slog.Warn("event with no tenant, not recorded", "topic", m.Topic, "event", m.EventID)
		return bus.ErrSkip
	}
	described := phrasing.Describe(m.Topic, m.Payload)
	if !described.Known {
		// Recorded anyway, and said out loud. The gap is worth fixing and the
		// line is worth keeping meanwhile.
		slog.Info("no sentence written for this event yet", "topic", m.Topic)
	}

	eventID := m.EventID
	entry := store.Entry{
		TenantID: m.TenantID, EventID: &eventID,
		Action: described.Action,
		// Every event is a decision the platform took on its own. A person may
		// have started it, but the event does not say which person, and
		// attributing it to whoever happened to be signed in would be worse
		// than saying so.
		ActorKind:   "system",
		ActorLabel:  m.Source,
		SubjectType: described.SubjectType, SubjectID: described.SubjectID,
		Summary: described.Summary, Detail: m.Payload,
		Source: m.Source, OccurredAt: m.At,
	}
	if _, err := r.st.Append(ctx, entry); err != nil {
		return fmt.Errorf("record %s: %w", m.Topic, err)
	}
	return nil
}

// Page tokens. Keyset over (occurred_at, id), so a trail that grows while it is
// being read does not repeat a line.
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
