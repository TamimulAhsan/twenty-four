// Package pg is the PostgreSQL plumbing every service repeats: open a pool,
// run migrations from an embedded filesystem, and run work inside a
// transaction that cannot be left open by accident.
//
// It is named pg rather than pgx so that a file using it can also import
// github.com/jackc/pgx/v5 without renaming one of them, which handlers taking a
// pgx.Tx all need to do.
package pg

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// Pool wraps pgxpool so services share one set of defaults rather than each
// picking their own.
type Pool struct{ *pgxpool.Pool }

// Open connects and waits for the database to answer.
//
// The wait is not optional in Kubernetes: a service pod and its Postgres pod
// start at the same time, and a service that exits because the database was not
// up yet enters CrashLoopBackOff and takes minutes to recover from a condition
// that cleared in seconds.
func Open(ctx context.Context, dsn string) (*Pool, error) {
	if dsn == "" {
		return nil, errors.New("pg: empty DSN")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("pg: parse DSN: %w", err)
	}
	// Small pools on purpose. Every service holds its own, and one Postgres
	// serves all of them on a single VPS.
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pg: connect: %w", err)
	}

	deadline := time.Now().Add(90 * time.Second)
	for {
		err = pool.Ping(ctx)
		if err == nil {
			return &Pool{pool}, nil
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			pool.Close()
			return nil, fmt.Errorf("pg: database never became reachable: %w", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

// Migrate applies the service's own migrations.
func (p *Pool) Migrate(ctx context.Context, fsys fs.FS) error {
	return p.migrate(ctx, fsys, "")
}

// MigrateNamed applies migrations under a separate version table, so two sets
// of migrations can live in one database and move independently. The shared
// outbox schema uses this: it is versioned by the packages module, not by the
// service that happens to host it.
func (p *Pool) MigrateNamed(ctx context.Context, fsys fs.FS, versionTable string) error {
	return p.migrate(ctx, fsys, versionTable)
}

func (p *Pool) migrate(ctx context.Context, fsys fs.FS, versionTable string) error {
	db := stdlib.OpenDB(*p.Config().ConnConfig)
	defer db.Close()

	var opts []goose.ProviderOption
	if versionTable != "" {
		opts = append(opts, goose.WithTableName(versionTable))
	}
	prov, err := goose.NewProvider(goose.DialectPostgres, db, fsys, opts...)
	if err != nil {
		return fmt.Errorf("pg: migrations: %w", err)
	}
	if _, err := prov.Up(ctx); err != nil {
		return fmt.Errorf("pg: migrate: %w", err)
	}
	return nil
}

// Tx runs fn inside a transaction, committing if it returns nil and rolling
// back otherwise. The rollback is deferred as well, so a panic in a handler
// cannot leave a transaction open holding locks.
func (p *Pool) Tx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return fmt.Errorf("pg: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("pg: commit: %w", err)
	}
	return nil
}

// sqlState reports the SQLSTATE of a PostgreSQL error, or "".
func sqlState(err error) string {
	var e interface{ SQLState() string }
	if errors.As(err, &e) {
		return e.SQLState()
	}
	return ""
}

// IsUniqueViolation is how a caller distinguishes "someone else took it" from
// a real failure. Retrying on it is the correct answer for a randomly assigned
// identifier; checking first and then inserting is a race.
func IsUniqueViolation(err error) bool { return sqlState(err) == "23505" }

// IsForeignKeyViolation means the row this one points at is not there.
func IsForeignKeyViolation(err error) bool { return sqlState(err) == "23503" }

// NoRows is re-exported so a service can test for it without importing pgx
// purely for the sentinel.
func NoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) || errors.Is(err, sql.ErrNoRows) }
