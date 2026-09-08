// Package store is the Catalog service's PostgreSQL persistence.
//
// Every query in this file takes a tenant and every query uses it. That is not
// defensive habit: this service holds one merchant's prices next to another's,
// and a WHERE clause that forgets the tenant is a cross-tenant data leak with
// no other symptom. The tenant always arrives from tenantctx, never from a
// request body.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/catalog/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	ErrSKUTaken = errors.New("store: that SKU is already in use")
	// ErrNoCategory is distinct from ErrNotFound so a caller can say which of
	// the two things it named was the missing one.
	ErrNoCategory = errors.New("store: no such category")
	ErrNameTaken  = errors.New("store: a category with that name already exists")
)

type Store struct{ pool *pg.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pg.Open(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	return s.pool.Migrate(ctx, migrations.FS)
}

// Item is one thing a tenant sells. Money is minor units plus a currency code.
type Item struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	SKU            string
	Name           string
	Description    string
	Kind           string // "product" or "service"
	UnitPriceMinor int64
	Currency       string
	CostPriceMinor *int64 // nil means not recorded, which is not zero
	TaxBasisPoints int32
	TaxIncluded    bool
	CategoryID     *uuid.UUID
	Colour         *string
	TrackStock     bool
	DurationMin    int32
	Active         bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
	ArchivedAt     *time.Time
}

const itemCols = `id, tenant_id, sku, name, description, kind,
                  unit_price_minor, currency, cost_price_minor,
                  tax_basis_points, tax_included, category_id, colour,
                  track_stock, duration_minutes, active,
                  created_at, updated_at, archived_at`

func scanItem(row pgx.Row) (Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.TenantID, &it.SKU, &it.Name, &it.Description, &it.Kind,
		&it.UnitPriceMinor, &it.Currency, &it.CostPriceMinor,
		&it.TaxBasisPoints, &it.TaxIncluded, &it.CategoryID, &it.Colour,
		&it.TrackStock, &it.DurationMin, &it.Active,
		&it.CreatedAt, &it.UpdatedAt, &it.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	return it, err
}

// CreateItem inserts the item, refusing a category the tenant does not own.
//
// The guard is part of the INSERT rather than a check before it. Categories are
// keyed by ID alone, so the foreign key alone would happily accept another
// tenant's category: the item would then carry a reference to something its
// owner can never see. Doing it in one statement also closes the window where
// a category is archived between the check and the write.
func (s *Store) CreateItem(ctx context.Context, it Item) (Item, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO items (id, tenant_id, sku, name, description, kind,
		                   unit_price_minor, currency, cost_price_minor,
		                   tax_basis_points, tax_included, category_id, colour,
		                   track_stock, duration_minutes, active)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
		WHERE $12::uuid IS NULL
		   OR EXISTS (SELECT 1 FROM categories
		              WHERE id = $12 AND tenant_id = $2 AND archived_at IS NULL)
		RETURNING `+itemCols,
		it.ID, it.TenantID, it.SKU, it.Name, it.Description, it.Kind,
		it.UnitPriceMinor, it.Currency, it.CostPriceMinor,
		it.TaxBasisPoints, it.TaxIncluded, it.CategoryID, it.Colour,
		it.TrackStock, it.DurationMin, it.Active)
	out, err := scanItem(row)
	if err != nil && pg.IsUniqueViolation(err) {
		return Item{}, ErrSKUTaken
	}
	// No row means the guard rejected the category, since nothing else in this
	// statement can match nothing.
	if errors.Is(err, ErrNotFound) {
		return Item{}, ErrNoCategory
	}
	return out, err
}

func (s *Store) Item(ctx context.Context, tenantID, id uuid.UUID) (Item, error) {
	return scanItem(s.pool.QueryRow(ctx,
		`SELECT `+itemCols+` FROM items WHERE tenant_id = $1 AND id = $2`, tenantID, id))
}

// ItemsByID loads several at once, which is what pricing a cart needs. Items
// the tenant does not own simply do not come back, and the caller reports the
// gap rather than this function guessing what to do about it.
func (s *Store) ItemsByID(ctx context.Context, tenantID uuid.UUID, ids []uuid.UUID) (map[uuid.UUID]Item, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+itemCols+` FROM items WHERE tenant_id = $1 AND id = ANY($2)`, tenantID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[uuid.UUID]Item, len(ids))
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out[it.ID] = it
	}
	return out, rows.Err()
}

// ItemFilter is what the till and the dashboard list send.
type ItemFilter struct {
	CategoryID      *uuid.UUID
	Kind            string
	Search          string
	IncludeArchived bool
	IncludeInactive bool
	Limit           int
	// Keyset pagination on (name, id): stable while items are being added,
	// which OFFSET is not. A till scrolling its list must not see an item twice
	// because someone created one behind it.
	AfterName string
	AfterID   uuid.UUID
}

func (s *Store) ListItems(ctx context.Context, tenantID uuid.UUID, f ItemFilter) ([]Item, error) {
	var sb strings.Builder
	args := []any{tenantID}
	sb.WriteString(`SELECT ` + itemCols + ` FROM items WHERE tenant_id = $1`)

	add := func(clause string, val any) {
		args = append(args, val)
		fmt.Fprintf(&sb, clause, len(args))
	}
	if !f.IncludeArchived {
		sb.WriteString(` AND archived_at IS NULL`)
	}
	if !f.IncludeInactive {
		sb.WriteString(` AND active`)
	}
	if f.CategoryID != nil {
		add(` AND category_id = $%d`, *f.CategoryID)
	}
	if f.Kind != "" {
		add(` AND kind = $%d`, f.Kind)
	}
	if f.Search != "" {
		// Substring on name or SKU, one argument used twice. Postgres FTS is
		// the answer when this stops being enough; it is not yet, and an index
		// nobody needs is a cost paid on every write.
		args = append(args, f.Search)
		n := len(args)
		fmt.Fprintf(&sb, ` AND (name ILIKE '%%' || $%d || '%%' OR sku ILIKE '%%' || $%d || '%%')`, n, n)
	}
	if f.AfterName != "" || f.AfterID != uuid.Nil {
		args = append(args, f.AfterName, f.AfterID)
		fmt.Fprintf(&sb, ` AND (name, id) > ($%d, $%d)`, len(args)-1, len(args))
	}
	sb.WriteString(` ORDER BY name, id`)
	if f.Limit > 0 {
		args = append(args, f.Limit)
		fmt.Fprintf(&sb, ` LIMIT $%d`, len(args))
	}

	rows, err := s.pool.Query(ctx, sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ItemPatch is a partial edit. A nil field is left alone, which is what makes
// a PATCH of one field not blank the rest.
type ItemPatch struct {
	SKU            *string
	Name           *string
	Description    *string
	Kind           *string
	UnitPriceMinor *int64
	Currency       *string
	CostPriceMinor **int64 // outer nil leaves it; inner nil clears it
	TaxBasisPoints *int32
	TaxIncluded    *bool
	CategoryID     **uuid.UUID
	Colour         **string
	TrackStock     *bool
	DurationMin    *int32
	Active         *bool
}

func (s *Store) UpdateItem(ctx context.Context, tenantID, id uuid.UUID, p ItemPatch) (Item, error) {
	var sets []string
	args := []any{tenantID, id}
	set := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if p.SKU != nil {
		set("sku", *p.SKU)
	}
	if p.Name != nil {
		set("name", *p.Name)
	}
	if p.Description != nil {
		set("description", *p.Description)
	}
	if p.Kind != nil {
		set("kind", *p.Kind)
	}
	if p.UnitPriceMinor != nil {
		set("unit_price_minor", *p.UnitPriceMinor)
	}
	if p.Currency != nil {
		set("currency", *p.Currency)
	}
	if p.CostPriceMinor != nil {
		set("cost_price_minor", *p.CostPriceMinor)
	}
	if p.TaxBasisPoints != nil {
		set("tax_basis_points", *p.TaxBasisPoints)
	}
	if p.TaxIncluded != nil {
		set("tax_included", *p.TaxIncluded)
	}
	if p.CategoryID != nil {
		set("category_id", *p.CategoryID)
	}
	if p.Colour != nil {
		set("colour", *p.Colour)
	}
	if p.TrackStock != nil {
		set("track_stock", *p.TrackStock)
	}
	if p.DurationMin != nil {
		set("duration_minutes", *p.DurationMin)
	}
	if p.Active != nil {
		set("active", *p.Active)
	}
	if len(sets) == 0 {
		return s.Item(ctx, tenantID, id)
	}
	sets = append(sets, "updated_at = now()")

	// An archived item is not editable. Bringing one back is a deliberate act
	// that does not exist yet, and letting an edit do it by accident would be
	// worse than refusing.
	q := `UPDATE items SET ` + strings.Join(sets, ", ") +
		` WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`
	// Same guard as CreateItem, for the same reason: the foreign key would
	// accept another tenant's category.
	if p.CategoryID != nil && *p.CategoryID != nil {
		args = append(args, *p.CategoryID)
		q += fmt.Sprintf(` AND EXISTS (SELECT 1 FROM categories
			WHERE id = $%d AND tenant_id = $1 AND archived_at IS NULL)`, len(args))
	}
	q += ` RETURNING ` + itemCols

	out, err := scanItem(s.pool.QueryRow(ctx, q, args...))
	if err != nil && pg.IsUniqueViolation(err) {
		return Item{}, ErrSKUTaken
	}
	// Nothing matched. Which of the two things named was missing matters to
	// the caller, so ask, on the error path only.
	if errors.Is(err, ErrNotFound) && p.CategoryID != nil && *p.CategoryID != nil {
		if _, e := s.Item(ctx, tenantID, id); e == nil {
			return Item{}, ErrNoCategory
		}
	}
	return out, err
}

// ArchiveItem is idempotent: archiving an archived item returns it unchanged
// rather than failing, because a retried request is not an error.
func (s *Store) ArchiveItem(ctx context.Context, tenantID, id uuid.UUID) (Item, error) {
	return scanItem(s.pool.QueryRow(ctx, `
		UPDATE items
		SET archived_at = coalesce(archived_at, now()), active = FALSE, updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING `+itemCols, tenantID, id))
}

type Category struct {
	ID        uuid.UUID
	TenantID  uuid.UUID
	Name      string
	Position  int32
	ItemCount int32
}

func (s *Store) ListCategories(ctx context.Context, tenantID uuid.UUID, includeArchived bool) ([]Category, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.tenant_id, c.name, c.position,
		       count(i.id) FILTER (WHERE i.archived_at IS NULL)
		FROM categories c
		LEFT JOIN items i ON i.category_id = c.id
		WHERE c.tenant_id = $1 AND ($2 OR c.archived_at IS NULL)
		GROUP BY c.id
		ORDER BY c.position, c.name`, tenantID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Category
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.TenantID, &c.Name, &c.Position, &c.ItemCount); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CreateCategory(ctx context.Context, c Category) (Category, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO categories (id, tenant_id, name, position)
		VALUES ($1,$2,$3,$4) RETURNING id, tenant_id, name, position`,
		c.ID, c.TenantID, c.Name, c.Position).Scan(&c.ID, &c.TenantID, &c.Name, &c.Position)
	if err != nil && pg.IsUniqueViolation(err) {
		return Category{}, ErrNameTaken
	}
	return c, err
}

func (s *Store) UpdateCategory(ctx context.Context, tenantID, id uuid.UUID, name *string, position *int32) (Category, error) {
	var c Category
	err := s.pool.QueryRow(ctx, `
		UPDATE categories SET
			name     = coalesce($3, name),
			position = coalesce($4, position)
		WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL
		RETURNING id, tenant_id, name, position`, tenantID, id, name, position).
		Scan(&c.ID, &c.TenantID, &c.Name, &c.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return Category{}, ErrNotFound
	}
	if err != nil && pg.IsUniqueViolation(err) {
		return Category{}, ErrNameTaken
	}
	return c, err
}

// ArchiveCategory hides the category and leaves its items uncategorised.
//
// Both statements share a transaction: a category that vanished while its
// items still pointed at it would leave the till rendering a tab that is not
// there. It reports how many items it moved, because that is a surprise a
// merchant deserves to be told about.
func (s *Store) ArchiveCategory(ctx context.Context, tenantID, id uuid.UUID) (int32, error) {
	var moved int32
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE categories SET archived_at = coalesce(archived_at, now())
			 WHERE tenant_id = $1 AND id = $2`, tenantID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		tag, err = tx.Exec(ctx,
			`UPDATE items SET category_id = NULL, updated_at = now()
			 WHERE tenant_id = $1 AND category_id = $2`, tenantID, id)
		if err != nil {
			return err
		}
		moved = int32(tag.RowsAffected())
		return nil
	})
	return moved, err
}
