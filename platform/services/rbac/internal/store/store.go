// Package store is the RBAC service's PostgreSQL persistence. It owns its own
// schema and no other service reads these tables — anything that needs a
// permission decision asks the service.
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/twentyfour/platform/services/rbac/internal/policy"
	"github.com/twentyfour/platform/services/rbac/migrations"
)

var ErrNotFound = errors.New("store: not found")

type Store struct{ pool *pgxpool.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Migrate applies the embedded schema. Services migrate themselves on start so
// a deploy never needs a separate step.
func (s *Store) Migrate(ctx context.Context, dsn string) error {
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDB(*s.pool.Config().ConnConfig)
	defer db.Close()
	return goose.UpContext(ctx, db, ".")
}

// SeedSystemRoles writes the shipped roles, and is safe to run on every start.
// System roles are code, not data: editing them in the database would drift
// from what the tests assert.
func (s *Store) SeedSystemRoles(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, r := range policy.SystemRoles {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			INSERT INTO roles (id, tenant_id, key, name, description, plane, is_system)
			VALUES ($1, NULL, $2, $3, $4, $5, TRUE)
			ON CONFLICT (key) WHERE tenant_id IS NULL
			DO UPDATE SET name = EXCLUDED.name,
			              description = EXCLUDED.description,
			              plane = EXCLUDED.plane
			RETURNING id`,
			uuid.New(), r.Key, r.Name, r.Description, string(r.Plane)).Scan(&id)
		if err != nil {
			return fmt.Errorf("seed role %q: %w", r.Key, err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, id); err != nil {
			return err
		}
		for _, p := range r.Permissions {
			if _, err := tx.Exec(ctx,
				`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
				id, string(p)); err != nil {
				return fmt.Errorf("seed permission %q on %q: %w", p, r.Key, err)
			}
		}
	}
	return tx.Commit(ctx)
}

// RolesForSubject returns every role bound to a subject in a tenant, including
// the system roles, with their permissions loaded.
func (s *Store) RolesForSubject(ctx context.Context, tenantID, subjectID uuid.UUID) ([]policy.Role, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.key, r.name, r.description, r.plane, r.is_system,
		       COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}')
		FROM role_bindings b
		JOIN roles r
		  ON r.key = b.role_key
		 AND (r.tenant_id IS NULL OR r.tenant_id = b.tenant_id)
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		WHERE b.tenant_id = $1 AND b.subject_id = $2
		GROUP BY r.key, r.name, r.description, r.plane, r.is_system`,
		tenantID, subjectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRoles(rows)
}

func (s *Store) ListRoles(ctx context.Context, tenantID uuid.UUID, plane string, includeSystem bool) ([]policy.Role, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.key, r.name, r.description, r.plane, r.is_system,
		       COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}')
		FROM roles r
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		WHERE (r.tenant_id = $1 OR ($2 AND r.tenant_id IS NULL))
		  AND ($3 = '' OR r.plane = $3)
		GROUP BY r.key, r.name, r.description, r.plane, r.is_system
		ORDER BY r.is_system DESC, r.key`,
		tenantID, includeSystem, plane)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRoles(rows)
}

func scanRoles(rows pgx.Rows) ([]policy.Role, error) {
	var out []policy.Role
	for rows.Next() {
		var r policy.Role
		var plane string
		var perms []string
		if err := rows.Scan(&r.Key, &r.Name, &r.Description, &plane, &r.System, &perms); err != nil {
			return nil, err
		}
		r.Plane = policy.Plane(plane)
		for _, p := range perms {
			r.Permissions = append(r.Permissions, policy.Permission(p))
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type Binding struct {
	ID        uuid.UUID
	TenantID  uuid.UUID
	SubjectID uuid.UUID
	RoleKey   string
}

// AssignRole is idempotent: re-assigning an existing role returns the existing
// binding rather than failing, so a retried signup cannot break.
func (s *Store) AssignRole(ctx context.Context, tenantID, subjectID uuid.UUID, roleKey string, actorID *uuid.UUID) (Binding, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM roles
			WHERE key = $1 AND (tenant_id IS NULL OR tenant_id = $2))`,
		roleKey, tenantID).Scan(&exists); err != nil {
		return Binding{}, err
	}
	if !exists {
		return Binding{}, fmt.Errorf("%w: role %q", ErrNotFound, roleKey)
	}

	b := Binding{ID: uuid.New(), TenantID: tenantID, SubjectID: subjectID, RoleKey: roleKey}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO role_bindings (id, tenant_id, subject_id, role_key, actor_id)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (tenant_id, subject_id, role_key) DO UPDATE SET role_key = EXCLUDED.role_key
		RETURNING id`,
		b.ID, tenantID, subjectID, roleKey, actorID).Scan(&b.ID)
	return b, err
}

func (s *Store) RevokeRole(ctx context.Context, tenantID, subjectID uuid.UUID, roleKey string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM role_bindings WHERE tenant_id = $1 AND subject_id = $2 AND role_key = $3`,
		tenantID, subjectID, roleKey)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
