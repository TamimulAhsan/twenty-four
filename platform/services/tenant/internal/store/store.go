// Package store is the Tenant service's PostgreSQL persistence.
//
// The profile and the entitlement are written in one transaction, together with
// the events that announce each module. The gateway caches entitlement in Redis
// and invalidates on module.enabled rather than on a TTL, so an entitlement
// written without its events is a merchant whose new module does not work until
// something happens to expire a cache.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/tenant/migrations"
)

var ErrNotFound = errors.New("store: not found")

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
	if err := s.pool.Migrate(ctx, migrations.FS); err != nil {
		return err
	}
	return outbox.Migrate(ctx, s.pool)
}

type TaxRate struct {
	ID          string
	Label       string
	BasisPoints int32
	IsDefault   bool
}

type Hours struct {
	Day    int32
	Opens  *string
	Closes *string
	Closed bool
}

type Profile struct {
	TenantID         uuid.UUID
	Name             string
	Industry         string
	TermFamily       string
	Tier             string
	Locale           string
	Currency         string
	Timezone         string
	PricesIncludeTax bool
	Address          string
	City             string
	TaxID            string
	Status           string
	StatusReason     string
	CreatedAt        time.Time
	TaxRates         []TaxRate
	Hours            []Hours
}

// Row is one line of the admin directory.
//
// Deliberately not Profile: the directory is read across every tenant at once,
// so it carries what a list needs and stops there. Opening hours and tax bands
// belong to one tenant's page, not to a page of two hundred.
type Row struct {
	TenantID  uuid.UUID
	Name      string
	Industry  string
	Tier      string
	Status    string
	City      string
	SeatLimit int32
	CreatedAt time.Time
}

// Filter narrows the directory. Empty slices mean no filter rather than none
// matching, which is the distinction a caller passing an empty list expects.
type Filter struct {
	Status []string
	Tier   []string
	Limit  int32
	// The tenant id the previous page ended on. Keyset rather than offset: an
	// offset shifts under you when a tenant is created mid-scroll.
	Cursor uuid.UUID
}

// Grant is one module a tenant holds, and why.
type Grant struct {
	ModuleID string
	// tier, profile or override. The gateway does not read this; a specialist
	// does, to see why something is held, and re-resolving a tier uses it to
	// avoid wiping an override.
	Source  string
	Pending bool
}

// Apply writes the profile and the resolved entitlement in one transaction.
//
// Idempotent per tenant: running it again updates rather than duplicating,
// because provisioning retries and a half-provisioned tenant must be able to
// finish rather than start over.
//
// Overrides survive. Re-resolving a tier replaces what the tier put there and
// leaves what a specialist put there, which is the difference `source` exists
// to record.
func (s *Store) Apply(ctx context.Context, p Profile, grants []Grant, seatLimit int32) (Profile, []Grant, error) {
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenants (id, business_name, industry, term_family, tier,
			                     locale, currency, timezone, prices_include_tax)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (id) DO UPDATE SET
				business_name = EXCLUDED.business_name,
				industry = EXCLUDED.industry,
				term_family = EXCLUDED.term_family,
				tier = EXCLUDED.tier,
				updated_at = now()`,
			p.TenantID, p.Name, p.Industry, p.TermFamily, p.Tier,
			p.Locale, p.Currency, p.Timezone, p.PricesIncludeTax); err != nil {
			return err
		}

		// Tax rates and hours are replaced wholesale rather than merged: they
		// come from the industry template, and a merchant who has edited them
		// is served by UpdateProfile, not by provisioning running again.
		for i, r := range p.TaxRates {
			if _, err := tx.Exec(ctx, `
				INSERT INTO tenant_tax_rates (tenant_id, id, label, basis_points, is_default, position)
				VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (tenant_id, id) DO NOTHING`,
				p.TenantID, r.ID, r.Label, r.BasisPoints, r.IsDefault, i); err != nil {
				return err
			}
		}
		for _, h := range p.Hours {
			if _, err := tx.Exec(ctx, `
				INSERT INTO tenant_hours (tenant_id, day, opens_at, closes_at, closed)
				VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (tenant_id, day) DO NOTHING`,
				p.TenantID, h.Day, h.Opens, h.Closes, h.Closed); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO entitlement_quotas (tenant_id, seat_limit) VALUES ($1,$2)
			ON CONFLICT (tenant_id) DO UPDATE SET seat_limit = EXCLUDED.seat_limit`,
			p.TenantID, seatLimit); err != nil {
			return err
		}

		// What the tier and profile no longer grant is withdrawn; what a
		// specialist granted is not.
		keep := make([]string, 0, len(grants))
		for _, g := range grants {
			keep = append(keep, g.ModuleID)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM entitlements
			WHERE tenant_id = $1 AND source <> 'override' AND NOT (module_id = ANY($2))`,
			p.TenantID, keep); err != nil {
			return err
		}

		for _, g := range grants {
			var inserted bool
			if err := tx.QueryRow(ctx, `
				INSERT INTO entitlements (tenant_id, module_id, source, pending)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (tenant_id, module_id) DO UPDATE SET pending = EXCLUDED.pending
				RETURNING (xmax = 0)`,
				p.TenantID, g.ModuleID, g.Source, g.Pending).Scan(&inserted); err != nil {
				return err
			}
			if !inserted {
				continue
			}
			// One event per module, not one per tenant. The gateway's policy
			// cache is invalidated by module.enabled, and a single "the
			// entitlement changed" event would tell it nothing about what.
			if _, err := outbox.Enqueue(ctx, tx, outbox.Event{
				TenantID: p.TenantID, Topic: "module.enabled",
				Key: p.TenantID.String(),
				Payload: map[string]any{
					"tenant_id": p.TenantID, "module_id": g.ModuleID,
					"source": g.Source, "pending": g.Pending, "tier": p.Tier,
				},
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Profile{}, nil, err
	}
	out, err := s.Profile(ctx, p.TenantID)
	if err != nil {
		return Profile{}, nil, err
	}
	held, _, err := s.Entitlement(ctx, p.TenantID)
	return out, held, err
}

func (s *Store) Profile(ctx context.Context, tenantID uuid.UUID) (Profile, error) {
	var p Profile
	err := s.pool.QueryRow(ctx, `
		SELECT id, business_name, industry, term_family, tier, locale, currency,
		       timezone, prices_include_tax, address, city, tax_id, status,
		       status_reason, created_at
		FROM tenants WHERE id = $1`, tenantID).
		Scan(&p.TenantID, &p.Name, &p.Industry, &p.TermFamily, &p.Tier,
			&p.Locale, &p.Currency, &p.Timezone, &p.PricesIncludeTax,
			&p.Address, &p.City, &p.TaxID, &p.Status, &p.StatusReason, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, ErrNotFound
	}
	if err != nil {
		return Profile{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, label, basis_points, is_default FROM tenant_tax_rates
		WHERE tenant_id = $1 ORDER BY position, id`, tenantID)
	if err != nil {
		return Profile{}, err
	}
	for rows.Next() {
		var r TaxRate
		if err := rows.Scan(&r.ID, &r.Label, &r.BasisPoints, &r.IsDefault); err != nil {
			rows.Close()
			return Profile{}, err
		}
		p.TaxRates = append(p.TaxRates, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Profile{}, err
	}

	hrows, err := s.pool.Query(ctx, `
		SELECT day, opens_at, closes_at, closed FROM tenant_hours
		WHERE tenant_id = $1 ORDER BY day`, tenantID)
	if err != nil {
		return Profile{}, err
	}
	defer hrows.Close()
	for hrows.Next() {
		var h Hours
		if err := hrows.Scan(&h.Day, &h.Opens, &h.Closes, &h.Closed); err != nil {
			return Profile{}, err
		}
		p.Hours = append(p.Hours, h)
	}
	return p, hrows.Err()
}

// List returns a page of the directory, and the size of the whole environment.
//
// The total is unfiltered on purpose: the console says "8 of 13 tenants", and
// a total that moved with the filter would make that sentence say nothing.
func (s *Store) List(ctx context.Context, f Filter) ([]Row, int32, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}

	// Ordered by creation then id. Created_at alone is not unique enough to
	// page on: two tenants provisioned in the same transaction would straddle
	// a page boundary and one of them would never be returned.
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.business_name, t.industry, t.tier, t.status, t.city,
		       COALESCE(q.seat_limit, 0), t.created_at
		FROM tenants t
		LEFT JOIN entitlement_quotas q ON q.tenant_id = t.id
		-- COALESCE, because an absent filter arrives as a NULL array rather
		-- than an empty one, and cardinality(NULL) is NULL: without this the
		-- whole predicate evaluates to NULL and an unfiltered directory
		-- returns nothing at all while still counting everything.
		WHERE (COALESCE(cardinality($1::text[]), 0) = 0 OR t.status = ANY($1))
		  AND (COALESCE(cardinality($2::text[]), 0) = 0 OR t.tier   = ANY($2))
		  AND ($3::uuid IS NULL OR t.id > $3)
		ORDER BY t.created_at, t.id
		LIMIT $4`,
		f.Status, f.Tier, nullUUID(f.Cursor), limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	// Empty rather than nil, so an empty page serialises as [] and not null.
	// A list that is sometimes null is a list every client has to guard.
	out := []Row{}
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.TenantID, &r.Name, &r.Industry, &r.Tier, &r.Status,
			&r.City, &r.SeatLimit, &r.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	var total int32
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM tenants`).Scan(&total); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func nullUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}

// SetStatus suspends or reinstates a tenant.
//
// The reason is stored alongside, not only emitted as an event: the console
// renders it on the tenant's page, and reading a sentence back out of an event
// stream to draw one line would be an odd way to keep it.
func (s *Store) SetStatus(ctx context.Context, tenantID uuid.UUID, status, reason string) (Profile, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE tenants SET status = $2, status_reason = $3, status_changed_at = now()
		WHERE id = $1`, tenantID, status, reason)
	if err != nil {
		return Profile{}, err
	}
	if tag.RowsAffected() == 0 {
		return Profile{}, ErrNotFound
	}
	return s.Profile(ctx, tenantID)
}

// Entitlement returns what the tenant holds, and its seat quota.
func (s *Store) Entitlement(ctx context.Context, tenantID uuid.UUID) ([]Grant, int32, error) {
	var seats int32
	err := s.pool.QueryRow(ctx,
		`SELECT seat_limit FROM entitlement_quotas WHERE tenant_id = $1`, tenantID).Scan(&seats)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT module_id, source, pending FROM entitlements
		WHERE tenant_id = $1 ORDER BY module_id`, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.ModuleID, &g.Source, &g.Pending); err != nil {
			return nil, 0, err
		}
		out = append(out, g)
	}
	return out, seats, rows.Err()
}

// SetPending records that a module finished provisioning, or that it is still
// queued. Announced, because the gateway's cache is invalidated by the event.
func (s *Store) SetPending(ctx context.Context, tenantID uuid.UUID, moduleID string, pending bool) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE entitlements SET pending = $3
			WHERE tenant_id = $1 AND module_id = $2 AND pending <> $3`,
			tenantID, moduleID, pending)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "module.enabled", Key: tenantID.String(),
			Payload: map[string]any{
				"tenant_id": tenantID, "module_id": moduleID, "pending": pending,
			},
		})
		return err
	})
}

type ProfilePatch struct {
	Name             *string
	Locale           *string
	Timezone         *string
	PricesIncludeTax *bool
	TaxRates         []TaxRate
	Hours            []Hours
}

// UpdateProfile is the merchant editing their own business. Industry and tier
// are not here on purpose: changing either re-resolves the entitlement, which
// is provisioning's job and not a form field.
func (s *Store) UpdateProfile(ctx context.Context, tenantID uuid.UUID, p ProfilePatch) (Profile, error) {
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE tenants SET
				business_name = coalesce($2, business_name),
				locale = coalesce($3, locale),
				timezone = coalesce($4, timezone),
				prices_include_tax = coalesce($5, prices_include_tax),
				updated_at = now()
			WHERE id = $1`, tenantID, p.Name, p.Locale, p.Timezone, p.PricesIncludeTax); err != nil {
			return err
		}
		if p.TaxRates != nil {
			if _, err := tx.Exec(ctx, `DELETE FROM tenant_tax_rates WHERE tenant_id = $1`, tenantID); err != nil {
				return err
			}
			for i, r := range p.TaxRates {
				if _, err := tx.Exec(ctx, `
					INSERT INTO tenant_tax_rates (tenant_id, id, label, basis_points, is_default, position)
					VALUES ($1,$2,$3,$4,$5,$6)`,
					tenantID, r.ID, r.Label, r.BasisPoints, r.IsDefault, i); err != nil {
					return err
				}
			}
		}
		if p.Hours != nil {
			if _, err := tx.Exec(ctx, `DELETE FROM tenant_hours WHERE tenant_id = $1`, tenantID); err != nil {
				return err
			}
			for _, h := range p.Hours {
				if _, err := tx.Exec(ctx, `
					INSERT INTO tenant_hours (tenant_id, day, opens_at, closes_at, closed)
					VALUES ($1,$2,$3,$4,$5)`, tenantID, h.Day, h.Opens, h.Closes, h.Closed); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return Profile{}, err
	}
	return s.Profile(ctx, tenantID)
}

// DefaultHours is what a business gets before it has said otherwise. Deliberate
// rather than empty: a profile with no hours renders a storefront that is
// closed forever, and nobody notices until a customer does.
func DefaultHours() []Hours {
	open, closes := "09:00", "18:00"
	out := make([]Hours, 0, 7)
	for day := int32(0); day < 7; day++ {
		out = append(out, Hours{Day: day, Opens: &open, Closes: &closes, Closed: day == 0})
	}
	return out
}
