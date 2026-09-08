package outbox

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeExecer records what would have been written, so the enqueue path can be
// tested without a database.
type fakeExecer struct {
	sql  string
	args []any
	err  error
}

func (f *fakeExecer) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.sql, f.args = sql, args
	return pgconn.CommandTag{}, f.err
}

func TestEnqueueWritesTheRow(t *testing.T) {
	f := &fakeExecer{}
	tid, orderID := uuid.New(), uuid.New()

	id, err := Enqueue(context.Background(), f, Event{
		TenantID: tid,
		Topic:    "order.placed",
		Key:      orderID.String(),
		Payload:  map[string]any{"order_id": orderID.String(), "total_minor": 12500, "currency": "HUF"},
	})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("no event id returned")
	}
	if !strings.Contains(f.sql, "INSERT INTO outbox") {
		t.Fatalf("did not insert into the outbox: %q", f.sql)
	}
	if f.args[0] != id || f.args[1] != tid || f.args[2] != "order.placed" || f.args[3] != orderID.String() {
		t.Fatalf("wrong columns: %v", f.args[:4])
	}

	// The payload must be JSON the relay can hand to Kafka untouched.
	var back map[string]any
	if err := json.Unmarshal(f.args[4].([]byte), &back); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if back["currency"] != "HUF" {
		t.Fatalf("payload lost a field: %v", back)
	}
}

// Ordering only means anything relative to a key, so an event without one still
// gets a stable key rather than an empty string that scatters a tenant's events
// across every partition.
func TestEmptyKeyFallsBackToTheTenant(t *testing.T) {
	f := &fakeExecer{}
	tid := uuid.New()
	if _, err := Enqueue(context.Background(), f, Event{TenantID: tid, Topic: "stock.low"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if f.args[3] != tid.String() {
		t.Fatalf("key should default to the tenant, got %v", f.args[3])
	}
}

func TestEnqueueRefusesIncompleteEvents(t *testing.T) {
	for _, tc := range []struct {
		name string
		ev   Event
	}{
		{"no tenant", Event{Topic: "order.placed"}},
		{"no topic", Event{TenantID: uuid.New()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Enqueue(context.Background(), &fakeExecer{}, tc.ev); err == nil {
				t.Fatal("accepted an event that cannot be routed")
			}
		})
	}
}

// A payload that cannot be marshalled must fail the enqueue, and therefore the
// caller's transaction. Writing the state change without its event is exactly
// the divergence the outbox exists to prevent.
func TestUnmarshallablePayloadFailsTheWrite(t *testing.T) {
	_, err := Enqueue(context.Background(), &fakeExecer{}, Event{
		TenantID: uuid.New(), Topic: "order.placed", Payload: make(chan int),
	})
	if err == nil {
		t.Fatal("accepted a payload that cannot be serialised")
	}
}

func TestCallerSuppliedIDIsKept(t *testing.T) {
	f := &fakeExecer{}
	want := uuid.New()
	got, err := Enqueue(context.Background(), f, Event{
		ID: want, TenantID: uuid.New(), Topic: "invoice.issued",
	})
	if err != nil || got != want {
		t.Fatalf("event id was replaced: %v %v", got, err)
	}
}

func TestTruncateBoundsTheStoredError(t *testing.T) {
	if got := truncate(strings.Repeat("x", 900), 500); len(got) != 500 {
		t.Fatalf("want 500 chars, got %d", len(got))
	}
	if got := truncate("short", 500); got != "short" {
		t.Fatalf("truncated a short string: %q", got)
	}
}
