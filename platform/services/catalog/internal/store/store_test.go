package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
)

// These run against a real PostgreSQL, because what is being tested is the SQL:
// whether a WHERE clause scopes to the tenant, whether a partial index lets a
// retired SKU be reused, whether archiving a category leaves its items behind.
// A fake store would answer all of those the way the fake was written.
//
//	CATALOG_TEST_DSN=postgres://... go test ./internal/store/
//
// Skipped without a DSN so the ordinary test run needs no database.
func testStore(t *testing.T) (*Store, uuid.UUID) {
	t.Helper()
	dsn := os.Getenv("CATALOG_TEST_DSN")
	if dsn == "" {
		t.Skip("set CATALOG_TEST_DSN to run the store tests against PostgreSQL")
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
	// Every test gets its own tenant, so tests share a database without
	// sharing rows and can run against a live development database safely.
	return st, uuid.New()
}

func item(tenant uuid.UUID, sku, name string, minor int64) Item {
	return Item{
		ID: uuid.New(), TenantID: tenant, SKU: sku, Name: name, Kind: "product",
		UnitPriceMinor: minor, Currency: "HUF", TaxBasisPoints: 2700,
		TaxIncluded: true, Active: true,
	}
}

// The single most important test in the service. One tenant's catalogue must be
// invisible to another, and a missed WHERE clause has no other symptom.
func TestTenantsCannotSeeEachOther(t *testing.T) {
	st, alice := testStore(t)
	bob := uuid.New()
	ctx := context.Background()

	mine, err := st.CreateItem(ctx, item(alice, "ESP-1", "Espresso", 650))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := st.Item(ctx, bob, mine.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another tenant read the item: %v", err)
	}
	got, err := st.ListItems(ctx, bob, ItemFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("another tenant listed %d items", len(got))
	}
	byID, err := st.ItemsByID(ctx, bob, []uuid.UUID{mine.ID})
	if err != nil {
		t.Fatalf("by id: %v", err)
	}
	if len(byID) != 0 {
		t.Fatal("another tenant priced the item")
	}
	if _, err := st.UpdateItem(ctx, bob, mine.ID, ItemPatch{Name: ptr("Stolen")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another tenant edited the item: %v", err)
	}
	if _, err := st.ArchiveItem(ctx, bob, mine.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another tenant archived the item: %v", err)
	}
}

func TestSKUIsUniquePerTenantAndReusableAfterArchive(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()

	first, err := st.CreateItem(ctx, item(tenant, "SKU-1", "Flat white", 900))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := st.CreateItem(ctx, item(tenant, "SKU-1", "Duplicate", 900)); !errors.Is(err, ErrSKUTaken) {
		t.Fatalf("accepted a duplicate SKU: %v", err)
	}
	// Case matters to nobody typing a barcode.
	if _, err := st.CreateItem(ctx, item(tenant, "sku-1", "Lowercase", 900)); !errors.Is(err, ErrSKUTaken) {
		t.Fatalf("accepted a duplicate SKU in another case: %v", err)
	}
	// Another tenant may hold the same SKU. They are different businesses.
	if _, err := st.CreateItem(ctx, item(uuid.New(), "SKU-1", "Theirs", 100)); err != nil {
		t.Fatalf("another tenant was refused the same SKU: %v", err)
	}

	// Retiring an item frees its SKU. Reusing a retired code is legitimate.
	if _, err := st.ArchiveItem(ctx, tenant, first.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if _, err := st.CreateItem(ctx, item(tenant, "SKU-1", "Replacement", 950)); err != nil {
		t.Fatalf("could not reuse a retired SKU: %v", err)
	}
}

func TestArchivedItemsStayResolvable(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()

	it, _ := st.CreateItem(ctx, item(tenant, "OLD-1", "Withdrawn", 400))
	if _, err := st.ArchiveItem(ctx, tenant, it.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}

	// Gone from the till.
	live, _ := st.ListItems(ctx, tenant, ItemFilter{})
	if len(live) != 0 {
		t.Fatalf("archived item still listed: %d", len(live))
	}
	// Still resolvable, because a refund of it has to be able to price it.
	got, err := st.Item(ctx, tenant, it.ID)
	if err != nil {
		t.Fatalf("archived item no longer resolvable: %v", err)
	}
	if got.ArchivedAt == nil {
		t.Fatal("archived_at was not set")
	}
	byID, _ := st.ItemsByID(ctx, tenant, []uuid.UUID{it.ID})
	if len(byID) != 1 {
		t.Fatal("archived item cannot be priced")
	}
	// Archiving twice is a retry, not an error.
	if _, err := st.ArchiveItem(ctx, tenant, it.ID); err != nil {
		t.Fatalf("second archive failed: %v", err)
	}
	// And it is not editable any more.
	if _, err := st.UpdateItem(ctx, tenant, it.ID, ItemPatch{Name: ptr("Revived")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("edited an archived item: %v", err)
	}
}

// A PATCH of one field must not blank the others.
func TestPartialUpdateLeavesTheRestAlone(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()

	before := item(tenant, "P-1", "Pastry", 550)
	before.Description = "Baked this morning"
	cost := int64(200)
	before.CostPriceMinor = &cost
	created, err := st.CreateItem(ctx, before)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	after, err := st.UpdateItem(ctx, tenant, created.ID, ItemPatch{Name: ptr("Croissant")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if after.Name != "Croissant" {
		t.Fatalf("name did not change: %q", after.Name)
	}
	if after.Description != before.Description {
		t.Fatalf("description was blanked: %q", after.Description)
	}
	if after.CostPriceMinor == nil || *after.CostPriceMinor != cost {
		t.Fatalf("cost was lost: %v", after.CostPriceMinor)
	}
	if after.UnitPriceMinor != before.UnitPriceMinor {
		t.Fatalf("price changed: %d", after.UnitPriceMinor)
	}

	// Clearing a cost is different from leaving it alone, and both have to work.
	var none *int64
	cleared, err := st.UpdateItem(ctx, tenant, created.ID, ItemPatch{CostPriceMinor: &none})
	if err != nil {
		t.Fatalf("clear cost: %v", err)
	}
	if cleared.CostPriceMinor != nil {
		t.Fatalf("cost was not cleared: %v", *cleared.CostPriceMinor)
	}
}

// Archiving a shelf must not take the stock on it off the till.
func TestArchivingACategoryUncategorisesItsItems(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()

	cat, err := st.CreateCategory(ctx, Category{ID: uuid.New(), TenantID: tenant, Name: "Drinks"})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	for i := 0; i < 3; i++ {
		it := item(tenant, fmt.Sprintf("D-%d", i), fmt.Sprintf("Drink %d", i), 500)
		it.CategoryID = &cat.ID
		if _, err := st.CreateItem(ctx, it); err != nil {
			t.Fatalf("create item: %v", err)
		}
	}

	cats, _ := st.ListCategories(ctx, tenant, false)
	if len(cats) != 1 || cats[0].ItemCount != 3 {
		t.Fatalf("category count wrong: %+v", cats)
	}

	moved, err := st.ArchiveCategory(ctx, tenant, cat.ID)
	if err != nil {
		t.Fatalf("archive category: %v", err)
	}
	if moved != 3 {
		t.Fatalf("uncategorised %d items, want 3", moved)
	}
	items, _ := st.ListItems(ctx, tenant, ItemFilter{})
	if len(items) != 3 {
		t.Fatalf("items disappeared with their category: %d", len(items))
	}
	for _, it := range items {
		if it.CategoryID != nil {
			t.Fatalf("%s still points at an archived category", it.Name)
		}
	}
}

func TestDuplicateCategoryNameIsRefused(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()
	if _, err := st.CreateCategory(ctx, Category{ID: uuid.New(), TenantID: tenant, Name: "Food"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := st.CreateCategory(ctx, Category{ID: uuid.New(), TenantID: tenant, Name: "food"}); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("accepted a duplicate category name: %v", err)
	}
}

func TestFiltersAndKeysetPaging(t *testing.T) {
	st, tenant := testStore(t)
	ctx := context.Background()

	names := []string{"Americano", "Bagel", "Cortado", "Danish", "Espresso"}
	for i, n := range names {
		it := item(tenant, fmt.Sprintf("F-%d", i), n, int64(500+i))
		if i%2 == 1 {
			it.Kind = "service"
		}
		if _, err := st.CreateItem(ctx, it); err != nil {
			t.Fatalf("create %s: %v", n, err)
		}
	}

	products, _ := st.ListItems(ctx, tenant, ItemFilter{Kind: "product"})
	if len(products) != 3 {
		t.Fatalf("kind filter returned %d", len(products))
	}
	// Search hits name or SKU, case-insensitively.
	found, _ := st.ListItems(ctx, tenant, ItemFilter{Search: "espr"})
	if len(found) != 1 || found[0].Name != "Espresso" {
		t.Fatalf("search returned %+v", found)
	}
	bySKU, _ := st.ListItems(ctx, tenant, ItemFilter{Search: "f-3"})
	if len(bySKU) != 1 || bySKU[0].Name != "Danish" {
		t.Fatalf("SKU search returned %+v", bySKU)
	}

	// Paging walks the whole list once, in order, with nothing repeated. That
	// is the property OFFSET does not give while rows are being inserted.
	seen := map[string]bool{}
	f := ItemFilter{Limit: 2}
	for range names {
		page, err := st.ListItems(ctx, tenant, f)
		if err != nil {
			t.Fatalf("page: %v", err)
		}
		if len(page) == 0 {
			break
		}
		for _, it := range page {
			if seen[it.Name] {
				t.Fatalf("%s came back twice", it.Name)
			}
			seen[it.Name] = true
		}
		last := page[len(page)-1]
		f.AfterName, f.AfterID = last.Name, last.ID
	}
	if len(seen) != len(names) {
		t.Fatalf("paging saw %d of %d items", len(seen), len(names))
	}

	// An inactive item is stocked but not sold, so it is out of the till's
	// list unless asked for.
	all, _ := st.ListItems(ctx, tenant, ItemFilter{})
	off, _ := st.UpdateItem(ctx, tenant, all[0].ID, ItemPatch{Active: ptr(false)})
	if off.Active {
		t.Fatal("active was not cleared")
	}
	live, _ := st.ListItems(ctx, tenant, ItemFilter{})
	if len(live) != len(names)-1 {
		t.Fatalf("inactive item still listed: %d", len(live))
	}
	withInactive, _ := st.ListItems(ctx, tenant, ItemFilter{IncludeInactive: true})
	if len(withInactive) != len(names) {
		t.Fatalf("include_inactive returned %d", len(withInactive))
	}
}

// The foreign key alone would accept this: categories are keyed by ID, so
// nothing about the constraint knows whose category it is. The guard in the
// INSERT is what refuses it, and without that an item would carry a reference
// to something its owner can never see.
func TestCannotAttachAnotherTenantsCategory(t *testing.T) {
	st, alice := testStore(t)
	bob := uuid.New()
	ctx := context.Background()

	theirs, err := st.CreateCategory(ctx, Category{ID: uuid.New(), TenantID: bob, Name: "Theirs"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	it := item(alice, "X-1", "Mine", 100)
	it.CategoryID = &theirs.ID
	if _, err := st.CreateItem(ctx, it); !errors.Is(err, ErrNoCategory) {
		t.Fatalf("attached another tenant's category: %v", err)
	}

	// The same on the edit path, where the guard has to be added to a
	// dynamically built UPDATE rather than a fixed INSERT.
	mine, err := st.CreateItem(ctx, item(alice, "X-2", "Mine too", 100))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	theirCat := &theirs.ID
	if _, err := st.UpdateItem(ctx, alice, mine.ID, ItemPatch{CategoryID: &theirCat}); !errors.Is(err, ErrNoCategory) {
		t.Fatalf("edited an item onto another tenant's category: %v", err)
	}

	cats, _ := st.ListCategories(ctx, alice, false)
	if len(cats) != 0 {
		t.Fatalf("another tenant's category was listed: %+v", cats)
	}
}

func ptr[T any](v T) *T { return &v }
