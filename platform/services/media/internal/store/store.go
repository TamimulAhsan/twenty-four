// Package store is the Media service's PostgreSQL persistence: the index over
// object storage, not the storage itself.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/media/migrations"
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

func (s *Store) Pool() *pg.Pool { return s.pool }

// Object is one file's record.
type Object struct {
	ID          uuid.UUID
	TenantID    uuid.UUID
	StorageKey  string
	Purpose     string
	Filename    string
	ContentType string
	SizeBytes   int64
	ConfirmedAt *time.Time
	SubjectType string
	SubjectID   string
	UploadedBy  *uuid.UUID
	CreatedAt   time.Time
}

// Ready reports whether the bytes are actually there. A row exists from the
// moment a URL is signed, which is before anything has been uploaded.
func (o Object) Ready() bool { return o.ConfirmedAt != nil }

const cols = `id, tenant_id, storage_key, purpose, filename, content_type,
	size_bytes, confirmed_at, subject_type, subject_id, uploaded_by, created_at`

func scan(row pgx.Row) (Object, error) {
	var o Object
	err := row.Scan(&o.ID, &o.TenantID, &o.StorageKey, &o.Purpose, &o.Filename,
		&o.ContentType, &o.SizeBytes, &o.ConfirmedAt, &o.SubjectType, &o.SubjectID,
		&o.UploadedBy, &o.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Object{}, ErrNotFound
	}
	return o, err
}

// Reserve records an object before its bytes exist.
//
// No event is written here. Announcing a file that may never be uploaded would
// make every consumer responsible for deciding whether to believe it, which is
// the sort of thing that produces a catalog item showing a photograph that is
// not there.
func (s *Store) Reserve(ctx context.Context, o Object) (Object, error) {
	if o.ID == uuid.Nil {
		o.ID = uuid.New()
	}
	return scan(s.pool.QueryRow(ctx, `
		INSERT INTO objects (id, tenant_id, storage_key, purpose, filename,
		                     content_type, size_bytes, subject_type, subject_id,
		                     uploaded_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING `+cols,
		o.ID, o.TenantID, o.StorageKey, o.Purpose, o.Filename, o.ContentType,
		o.SizeBytes, o.SubjectType, o.SubjectID, o.UploadedBy))
}

// Confirm marks an object ready and announces it, in one transaction.
//
// The size is passed in rather than trusted from the reservation, because the
// reservation carried what the caller said it would upload and this carries
// what the store actually holds.
func (s *Store) Confirm(ctx context.Context, tenantID, id uuid.UUID, size int64) (Object, error) {
	var out Object
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scan(tx.QueryRow(ctx, `
			UPDATE objects
			SET confirmed_at = coalesce(confirmed_at, now()), size_bytes = $3
			WHERE tenant_id = $1 AND id = $2
			RETURNING `+cols, tenantID, id, size))
		if err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "media.uploaded", Key: id.String(),
			Payload: map[string]any{
				"media_id": id, "purpose": out.Purpose, "filename": out.Filename,
				"content_type": out.ContentType, "size_bytes": out.SizeBytes,
				"subject_type": out.SubjectType, "subject_id": out.SubjectID,
			},
		})
		return err
	})
	return out, err
}

func (s *Store) Object(ctx context.Context, tenantID, id uuid.UUID) (Object, error) {
	return scan(s.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM objects WHERE tenant_id = $1 AND id = $2`, tenantID, id))
}

// Filter narrows a listing.
type Filter struct {
	Purpose        string
	SubjectType    string
	SubjectID      string
	IncludePending bool
	Limit          int
}

func (s *Store) List(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Object, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+cols+` FROM objects
		WHERE tenant_id = $1
		  AND ($2 = '' OR purpose = $2)
		  AND ($3 = '' OR subject_type = $3)
		  AND ($4 = '' OR subject_id = $4)
		  AND ($5 OR confirmed_at IS NOT NULL)
		ORDER BY created_at DESC, id DESC
		LIMIT $6`,
		tenantID, f.Purpose, f.SubjectType, f.SubjectID, f.IncludePending, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Object
	for rows.Next() {
		o, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Delete removes the record and announces it.
//
// The row goes first and the object afterwards, deliberately. The other order
// leaves a record pointing at nothing when the store is unreachable, which is a
// broken image on a storefront. This order can leave an object with no record,
// which is wasted disk that the sweeper finds, and wasted disk is the cheaper
// of the two failures.
func (s *Store) Delete(ctx context.Context, tenantID, id uuid.UUID) (Object, error) {
	var out Object
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scan(tx.QueryRow(ctx,
			`DELETE FROM objects WHERE tenant_id = $1 AND id = $2 RETURNING `+cols,
			tenantID, id))
		if err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: "media.deleted", Key: id.String(),
			Payload: map[string]any{
				"media_id": id, "purpose": out.Purpose,
				"subject_type": out.SubjectType, "subject_id": out.SubjectID,
			},
		})
		return err
	})
	return out, err
}

// Abandoned returns reservations old enough that nobody is going to finish
// them, so their rows and any stray bytes can go.
//
// A reservation is not a file. Keeping them forever would make the index a list
// of uploads that were started, which is a different and much less useful thing
// than a list of files that exist.
func (s *Store) Abandoned(ctx context.Context, olderThan time.Duration, limit int) ([]Object, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+cols+` FROM objects
		WHERE confirmed_at IS NULL AND created_at < $1
		ORDER BY created_at
		LIMIT $2`, time.Now().Add(-olderThan), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Object
	for rows.Next() {
		o, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Forget removes an abandoned reservation's row. No event: nothing ever knew
// the object existed, so nothing needs telling that it does not.
func (s *Store) Forget(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM objects WHERE id = $1 AND confirmed_at IS NULL`, id)
	return err
}
