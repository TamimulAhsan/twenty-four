// Package store is the Provisioning service's PostgreSQL persistence.
//
// It holds the saga: which steps exist for a tenant, which have run, which
// failed and why. That state is the reason this is a service rather than a
// function, because it has to survive a crash halfway and be resumable
// afterwards.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/provisioning/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	ErrNotYours = errors.New("store: that step is not the platform's to run")
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
	if err := s.pool.Migrate(ctx, migrations.FS); err != nil {
		return err
	}
	return outbox.Migrate(ctx, s.pool)
}

type Step struct {
	ID          string
	Title       string
	Description string
	Hour        int32
	Status      string
	Owner       string
	Position    int32
	Attempts    int32
	LastError   string
	CompletedAt *time.Time
}

type Run struct {
	TenantID     uuid.UUID
	OwnerUserID  *uuid.UUID
	BusinessName string
	Industry     string
	Tier         string
	StartedAt    time.Time
	DueAt        time.Time
	CompletedAt  *time.Time
	Steps        []Step
}

// Begin creates the run and its steps, or returns the one already there.
//
// Idempotent per tenant, and that is the whole point: a retried signup finds
// the run it already started rather than starting a second, because half of it
// may already have happened and running the first three steps again would
// re-seed a catalog the merchant has begun editing.
func (s *Store) Begin(ctx context.Context, r Run, sla time.Duration) (Run, bool, error) {
	var existed bool
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var inserted bool
		err := tx.QueryRow(ctx, `
			INSERT INTO runs (tenant_id, owner_user_id, business_name, industry, tier, due_at)
			VALUES ($1,$2,$3,$4,$5, now() + $6::interval)
			ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
			RETURNING (xmax = 0)`,
			r.TenantID, r.OwnerUserID, r.BusinessName, r.Industry, r.Tier, sla.String()).
			Scan(&inserted)
		if err != nil {
			return err
		}
		existed = !inserted
		if existed {
			return nil
		}
		for i, step := range r.Steps {
			// A merchant-owned or specialist-owned step starts in the state
			// that says so, rather than as pending work the platform will get
			// to. Nobody else is going to do it.
			status := "pending"
			if step.Owner == "specialist" {
				status = "awaiting_specialist"
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO steps (tenant_id, step_id, title, description, hour, status, owner, position)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				r.TenantID, step.ID, step.Title, step.Description,
				step.Hour, status, step.Owner, i); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Run{}, false, err
	}
	out, err := s.Run(ctx, r.TenantID)
	return out, existed, err
}

func (s *Store) Run(ctx context.Context, tenantID uuid.UUID) (Run, error) {
	var r Run
	err := s.pool.QueryRow(ctx, `
		SELECT tenant_id, owner_user_id, business_name, industry, tier,
		       started_at, due_at, completed_at
		FROM runs WHERE tenant_id = $1`, tenantID).
		Scan(&r.TenantID, &r.OwnerUserID, &r.BusinessName, &r.Industry, &r.Tier,
			&r.StartedAt, &r.DueAt, &r.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT step_id, title, description, hour, status, owner, position,
		       attempts, last_error, completed_at
		FROM steps WHERE tenant_id = $1 ORDER BY position`, tenantID)
	if err != nil {
		return Run{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var st Step
		if err := rows.Scan(&st.ID, &st.Title, &st.Description, &st.Hour, &st.Status,
			&st.Owner, &st.Position, &st.Attempts, &st.LastError, &st.CompletedAt); err != nil {
			return Run{}, err
		}
		r.Steps = append(r.Steps, st)
	}
	return r, rows.Err()
}

// Claim marks a step in progress and returns whether this call got it.
//
// The status check is in the WHERE clause, so two provisioning runs racing on
// the same tenant cannot both run the same step: one updates a row and the
// other updates nothing.
func (s *Store) Claim(ctx context.Context, tenantID uuid.UUID, stepID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE steps SET status = 'in_progress', attempts = attempts + 1, last_error = ''
		WHERE tenant_id = $1 AND step_id = $2 AND status IN ('pending','failed')`,
		tenantID, stepID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *Store) Finish(ctx context.Context, tenantID uuid.UUID, stepID string, err error) error {
	if err != nil {
		_, e := s.pool.Exec(ctx, `
			UPDATE steps SET status = 'failed', last_error = $3
			WHERE tenant_id = $1 AND step_id = $2`, tenantID, stepID, truncate(err.Error(), 500))
		return e
	}
	_, e := s.pool.Exec(ctx, `
		UPDATE steps SET status = 'done', completed_at = now(), last_error = ''
		WHERE tenant_id = $1 AND step_id = $2`, tenantID, stepID)
	return e
}

// CompleteByOwner is a specialist or a merchant marking their own step done.
// The owner is checked in the statement, so nothing can quietly tick off a step
// that belongs to somebody else.
func (s *Store) CompleteByOwner(ctx context.Context, tenantID uuid.UUID, stepID string, owners ...string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE steps SET status = 'done', completed_at = now(), last_error = ''
		WHERE tenant_id = $1 AND step_id = $2 AND owner = ANY($3) AND status <> 'done'`,
		tenantID, stepID, owners)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotYours
	}
	return nil
}

// SettleRun marks the run complete once every platform step is done, and
// announces it.
//
// Only platform steps hold it open. A merchant who has not yet rung a sale
// through has not made us late: the promise is that the platform's part is
// ready within the day, and holding the run open on somebody else's homework
// would make the SLA unmeasurable.
func (s *Store) SettleRun(ctx context.Context, tenantID uuid.UUID, payload map[string]any) (bool, error) {
	var settled bool
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var outstanding int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM steps
			WHERE tenant_id = $1 AND owner = 'platform' AND status <> 'done'`,
			tenantID).Scan(&outstanding); err != nil {
			return err
		}
		if outstanding > 0 {
			return nil
		}
		tag, err := tx.Exec(ctx, `
			UPDATE runs SET completed_at = now()
			WHERE tenant_id = $1 AND completed_at IS NULL`, tenantID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		settled = true
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "tenant.provisioned",
			Key: tenantID.String(), Payload: payload,
		})
		return err
	})
	return settled, err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
