package store

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
)

// Against a real PostgreSQL, because what is being tested is the SQL: whether
// the level and the move and the event commit together, whether a repeated
// idempotency key applies once, whether the CHECK refuses an over-release.
//
//	INVENTORY_TEST_DSN=postgres://... go test ./internal/store/
func testStore(t *testing.T) (*Store, uuid.UUID) {
	t.Helper()
	dsn := os.Getenv("INVENTORY_TEST_DSN")
	if dsn == "" {
		t.Skip("set INVENTORY_TEST_DSN to run the store tests against PostgreSQL")
	}
	ctx := context.Background()
	st, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(st.Close)
	return st, uuid.New()
}

func pending(t *testing.T, st *Store, tenant uuid.UUID) []string {
	t.Helper()
	rows, err := st.pool.Query(context.Background(),
		`SELECT topic FROM outbox WHERE tenant_id = $1 ORDER BY created_at, id`, tenant)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var topic string
		if err := rows.Scan(&topic); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, topic)
	}
	return out
}

func TestAdjustmentMovesTheLevelAndEmitsAnEvent(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()

	l, repeat, err := st.Apply(ctx, Move{
		TenantID: tenant, ItemID: item, Delta: 12, Kind: "adjustment", Reason: "delivery",
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if repeat {
		t.Fatal("a first application reported itself as a repeat")
	}
	if l.OnHand != 12 || l.Reserved != 0 {
		t.Fatalf("level wrong: %+v", l)
	}
	if got := pending(t, st, tenant); len(got) != 1 || got[0] != "stock.adjusted" {
		t.Fatalf("events: %v", got)
	}
}

// The property the outbox exists for: the level, the move and the event are one
// commit. A level that moved without its event is a warning nobody receives.
func TestTheEventCommitsWithTheMove(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()

	for i := 0; i < 3; i++ {
		if _, _, err := st.Apply(ctx, Move{
			TenantID: tenant, ItemID: item, Delta: 1, Kind: "adjustment", Reason: "count",
		}); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}
	var moves int
	if err := st.pool.QueryRow(ctx,
		`SELECT count(*) FROM stock_moves WHERE tenant_id = $1`, tenant).Scan(&moves); err != nil {
		t.Fatalf("count moves: %v", err)
	}
	if events := pending(t, st, tenant); len(events) != moves {
		t.Fatalf("%d moves produced %d events", moves, len(events))
	}
}

// A till that loses its network mid-adjustment and sends again must not count
// the delivery twice.
func TestRetryWithTheSameKeyAppliesOnce(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()
	m := Move{
		TenantID: tenant, ItemID: item, Delta: 5, Kind: "adjustment",
		Reason: "delivery", IdempotencyKey: "delivery-4471",
	}

	first, repeat, err := st.Apply(ctx, m)
	if err != nil || repeat {
		t.Fatalf("first: %v repeat=%v", err, repeat)
	}
	second, repeat, err := st.Apply(ctx, m)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if !repeat {
		t.Fatal("a repeated key was not reported as a repeat")
	}
	if second.OnHand != first.OnHand {
		t.Fatalf("applied twice: %d then %d", first.OnHand, second.OnHand)
	}
	if got := pending(t, st, tenant); len(got) != 1 {
		t.Fatalf("a retry produced %d events", len(got))
	}

	// A different key is a different delivery and must apply.
	m.IdempotencyKey = "delivery-4472"
	third, _, err := st.Apply(ctx, m)
	if err != nil {
		t.Fatalf("third: %v", err)
	}
	if third.OnHand != first.OnHand+5 {
		t.Fatalf("a distinct key did not apply: %d", third.OnHand)
	}
}

func TestReserveConsumeAndRelease(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()

	if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 10, Kind: "adjustment"}); err != nil {
		t.Fatalf("stock in: %v", err)
	}

	// Reserving holds stock without taking it off the shelf.
	l, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 3, Kind: "reserve",
		ReferenceType: "order", ReferenceID: "o-1"})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if l.OnHand != 10 || l.Reserved != 3 {
		t.Fatalf("reserve changed the shelf: %+v", l)
	}

	// Consuming a reservation takes it off both.
	l, _, err = st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 2, Kind: "consume",
		ReferenceType: "order", ReferenceID: "o-1"})
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if l.OnHand != 8 || l.Reserved != 1 {
		t.Fatalf("consume wrong: %+v", l)
	}

	// Releasing the rest gives it back.
	l, _, err = st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 1, Kind: "release",
		ReferenceType: "order", ReferenceID: "o-1"})
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if l.OnHand != 8 || l.Reserved != 0 {
		t.Fatalf("release wrong: %+v", l)
	}

	// A walk-in sale was never held: only the shelf falls.
	l, _, err = st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 2, Kind: "consume_unreserved",
		ReferenceType: "order", ReferenceID: "o-2"})
	if err != nil {
		t.Fatalf("walk-in: %v", err)
	}
	if l.OnHand != 6 || l.Reserved != 0 {
		t.Fatalf("walk-in touched reserved: %+v", l)
	}
}

// Reserved going negative would make stock available that is already promised.
func TestCannotReleaseMoreThanIsReserved(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()

	if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 2, Kind: "reserve"}); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 5, Kind: "release"}); !errors.Is(err, ErrOverRelease) {
		t.Fatalf("over-release was allowed: %v", err)
	}
	l, err := st.Level(ctx, tenant, item)
	if err != nil {
		t.Fatalf("level: %v", err)
	}
	if l.Reserved != 2 {
		t.Fatalf("a refused release still changed the level: %+v", l)
	}
}

// A shop that sells its last two coffees while the count says one has a
// counting problem. Refusing the sale does not fix it, so the number tells the
// truth about what happened.
func TestOnHandMayGoNegative(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()
	l, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 2,
		Kind: "consume_unreserved", ReferenceType: "order", ReferenceID: "o-9"})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if l.OnHand != -2 {
		t.Fatalf("on hand was clamped: %d", l.OnHand)
	}
}

// A warning that arrives forty times is a warning nobody reads.
func TestStockLowFiresOnTheCrossingOnly(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()
	three := int32(3)

	if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 10, Kind: "adjustment"}); err != nil {
		t.Fatalf("stock in: %v", err)
	}
	if _, err := st.SetThreshold(ctx, tenant, item, &three); err != nil {
		t.Fatalf("threshold: %v", err)
	}

	countLow := func() int {
		n := 0
		for _, topic := range pending(t, st, tenant) {
			if topic == "stock.low" {
				n++
			}
		}
		return n
	}

	// Down to 3: crosses, warns once.
	for i := 0; i < 7; i++ {
		if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 1,
			Kind: "consume_unreserved"}); err != nil {
			t.Fatalf("consume: %v", err)
		}
	}
	if got := countLow(); got != 1 {
		t.Fatalf("crossing produced %d warnings, want 1", got)
	}

	// Further movements below the line must not warn again.
	for i := 0; i < 3; i++ {
		if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 1,
			Kind: "consume_unreserved"}); err != nil {
			t.Fatalf("consume: %v", err)
		}
	}
	if got := countLow(); got != 1 {
		t.Fatalf("stayed-low produced %d warnings, want 1", got)
	}

	// Restocking above the line re-arms it, and the next crossing warns again.
	if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 20, Kind: "adjustment"}); err != nil {
		t.Fatalf("restock: %v", err)
	}
	if got := countLow(); got != 1 {
		t.Fatalf("restocking warned: %d", got)
	}
	for i := 0; i < 18; i++ {
		if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 1,
			Kind: "consume_unreserved"}); err != nil {
			t.Fatalf("consume: %v", err)
		}
	}
	if got := countLow(); got != 2 {
		t.Fatalf("second crossing produced %d warnings total, want 2", got)
	}
}

// An item with no threshold never warns. That is different from a threshold of
// zero, which warns when it runs out.
func TestNoThresholdNeverWarns(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	item := uuid.New()
	for i := 0; i < 5; i++ {
		if _, _, err := st.Apply(ctx, Move{TenantID: tenant, ItemID: item, Delta: 1,
			Kind: "consume_unreserved"}); err != nil {
			t.Fatalf("consume: %v", err)
		}
	}
	for _, topic := range pending(t, st, tenant) {
		if topic == "stock.low" {
			t.Fatal("warned without a threshold")
		}
	}
}

func TestTenantsCannotSeeEachOther(t *testing.T) {
	st, alice := testStore(t)
	bob := uuid.New()
	ctx := context.Background()
	item := uuid.New()

	if _, _, err := st.Apply(ctx, Move{TenantID: alice, ItemID: item, Delta: 7, Kind: "adjustment"}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if _, err := st.Level(ctx, bob, item); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another tenant read the level: %v", err)
	}
	got, err := st.ListLevels(ctx, bob, false)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("another tenant listed %d levels", len(got))
	}
	// Idempotency keys are per tenant: two businesses using "delivery-1" on the
	// same day must both apply.
	m := Move{TenantID: alice, ItemID: item, Delta: 1, Kind: "adjustment", IdempotencyKey: "k"}
	if _, _, err := st.Apply(ctx, m); err != nil {
		t.Fatalf("alice: %v", err)
	}
	m.TenantID = bob
	if _, repeat, err := st.Apply(ctx, m); err != nil || repeat {
		t.Fatalf("bob was blocked by alice's key: %v repeat=%v", err, repeat)
	}
}
