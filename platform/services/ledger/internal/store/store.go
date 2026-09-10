// Package store is the Ledger service's PostgreSQL persistence.
//
// Two properties, and they are the reason to trust anything read out of it.
//
// Every entry balances, checked before it is written. An unbalanced entry
// cannot get in, so no report has to cope with one and nobody has to find out
// six months later which entry it was.
//
// Nothing is ever updated or deleted. There is no UPDATE and no DELETE in this
// file, and the service exposes neither. A correction is a new entry that
// reverses an old one, which is the rule an issued invoice follows, for the
// same reason: the original happened, and a receipt for it is in somebody's
// pocket.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/ledger/internal/chart"
	"github.com/twentyfour/platform/services/ledger/migrations"
)

var (
	ErrNotFound = errors.New("store: not found")
	// ErrUnbalanced is the invariant. It is a write-time error rather than a
	// report-time discovery on purpose.
	ErrUnbalanced = errors.New("store: the lines of an entry must sum to zero")
	// ErrNoSuchAccount is a line naming an account that is not in the chart.
	// Refused rather than created, because an account invented by a typo is an
	// account nobody will ever look at and a balance nobody will ever explain.
	ErrNoSuchAccount = errors.New("store: no such account")
	// ErrAlreadyReversed is a second reversal of the same entry, which would
	// put the books further out rather than back.
	ErrAlreadyReversed = errors.New("store: that entry has already been reversed")
	ErrEmpty           = errors.New("store: an entry with no lines records nothing")
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
	// Consumed events, because the books are derived from the bus. No outbox:
	// the ledger announces nothing. An event saying a journal entry was written
	// would be an event the trail records, and the books do not need an
	// audience.
	return bus.Migrate(ctx, s.pool)
}

func (s *Store) Pool() *pg.Pool { return s.pool }

// EnsureChart writes the platform's accounts for a tenant that has none.
//
// Called on the path that writes the first entry rather than at provisioning,
// so a tenant created before this service existed works without a backfill.
func (s *Store) EnsureChart(ctx context.Context, tenantID uuid.UUID) error {
	return s.pool.Tx(ctx, func(tx pgx.Tx) error {
		for _, a := range chart.Builtin() {
			if _, err := tx.Exec(ctx, `
				INSERT INTO accounts (tenant_id, code, name, kind, builtin)
				VALUES ($1,$2,$3,$4,TRUE)
				ON CONFLICT (tenant_id, code) DO NOTHING`,
				tenantID, a.Code, a.Name, string(a.Kind)); err != nil {
				return fmt.Errorf("store: seed chart: %w", err)
			}
		}
		return nil
	})
}

type Account struct {
	Code    string
	Name    string
	Kind    string
	Builtin bool
}

func (s *Store) ListAccounts(ctx context.Context, tenantID uuid.UUID) ([]Account, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT code, name, kind, builtin FROM accounts
		WHERE tenant_id = $1 ORDER BY kind, code`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.Code, &a.Name, &a.Kind, &a.Builtin); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Line is one signed debit.
type Line struct {
	AccountCode string
	Minor       int64
	Memo        string
}

type Entry struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	Kind           string
	ReferenceType  string
	ReferenceID    string
	EventID        *uuid.UUID
	Memo           string
	Currency       string
	ReversesID     *uuid.UUID
	ReversedByID   *uuid.UUID
	PostedBy       *uuid.UUID
	OccurredAt     time.Time
	PostedAt       time.Time
	IdempotencyKey string
	Lines          []Line
}

// Balanced is the invariant: the signed debits sum to zero.
func (e Entry) Balanced() bool {
	var total int64
	for _, l := range e.Lines {
		total += l.Minor
	}
	return total == 0
}

const entryCols = `e.id, e.tenant_id, e.kind, e.reference_type, e.reference_id,
	e.event_id, e.memo, e.currency, e.reverses_id,
	(SELECT r.id FROM entries r WHERE r.reverses_id = e.id),
	e.posted_by, e.occurred_at, e.posted_at, e.idempotency_key`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(&e.ID, &e.TenantID, &e.Kind, &e.ReferenceType, &e.ReferenceID,
		&e.EventID, &e.Memo, &e.Currency, &e.ReversesID, &e.ReversedByID,
		&e.PostedBy, &e.OccurredAt, &e.PostedAt, &e.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	return e, err
}

// Post writes an entry and its lines, refusing anything that does not balance.
//
// The check is here rather than in a handler because this is the only door.
// A validation in one caller is a validation the next caller forgets.
func (s *Store) Post(ctx context.Context, e Entry) (Entry, bool, error) {
	if len(e.Lines) == 0 {
		return Entry{}, false, ErrEmpty
	}
	if !e.Balanced() {
		return Entry{}, false, ErrUnbalanced
	}
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	if e.OccurredAt.IsZero() {
		e.OccurredAt = time.Now()
	}

	var out Entry
	repeat := false
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scanEntry(tx.QueryRow(ctx, `
			WITH e AS (
				INSERT INTO entries (id, tenant_id, kind, reference_type, reference_id,
				                     event_id, memo, currency, reverses_id, posted_by,
				                     occurred_at, idempotency_key)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
				ON CONFLICT DO NOTHING
				RETURNING *
			)
			SELECT `+entryCols+` FROM e`,
			e.ID, e.TenantID, e.Kind, e.ReferenceType, e.ReferenceID, e.EventID,
			e.Memo, e.Currency, e.ReversesID, e.PostedBy, e.OccurredAt, e.IdempotencyKey))
		if errors.Is(err, ErrNotFound) {
			// Already posted, under an event id or an idempotency key. Return
			// what is there: a redelivered sale must not be booked twice.
			repeat = true
			out, err = findExisting(ctx, tx, e)
			if err != nil {
				return err
			}
			return loadLines(ctx, tx, &out)
		}
		if err != nil {
			return err
		}

		for _, l := range e.Lines {
			var known bool
			if err := tx.QueryRow(ctx,
				`SELECT true FROM accounts WHERE tenant_id = $1 AND code = $2`,
				e.TenantID, l.AccountCode).Scan(&known); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("%w: %s", ErrNoSuchAccount, l.AccountCode)
				}
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO lines (entry_id, tenant_id, account_code, amount_minor, memo)
				VALUES ($1,$2,$3,$4,$5)`,
				out.ID, e.TenantID, l.AccountCode, l.Minor, l.Memo); err != nil {
				return err
			}
		}
		out.Lines = e.Lines
		return nil
	})
	return out, repeat, err
}

func findExisting(ctx context.Context, tx pgx.Tx, e Entry) (Entry, error) {
	if e.EventID != nil {
		return scanEntry(tx.QueryRow(ctx,
			`SELECT `+entryCols+` FROM entries e WHERE e.tenant_id = $1 AND e.event_id = $2`,
			e.TenantID, e.EventID))
	}
	if e.IdempotencyKey != "" {
		return scanEntry(tx.QueryRow(ctx,
			`SELECT `+entryCols+` FROM entries e WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
			e.TenantID, e.IdempotencyKey))
	}
	// A primary key collision on a generated UUID. Not a case that happens, and
	// not one to answer with a wrong row.
	return Entry{}, ErrNotFound
}

// Reverse writes the correcting entry: the same lines with the sign flipped.
//
// Never an edit, never a delete. The original entry stays exactly as it was and
// gains a pointer to the correction, so the books show both what was recorded
// and what was done about it.
func (s *Store) Reverse(ctx context.Context, tenantID, id, actor uuid.UUID, memo string) (Entry, error) {
	var out Entry
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		original, err := scanEntry(tx.QueryRow(ctx,
			`SELECT `+entryCols+` FROM entries e
			 WHERE e.tenant_id = $1 AND e.id = $2 FOR UPDATE`, tenantID, id))
		if err != nil {
			return err
		}
		if original.ReversedByID != nil {
			return ErrAlreadyReversed
		}
		if err := loadLines(ctx, tx, &original); err != nil {
			return err
		}

		reversalID := uuid.New()
		if memo == "" {
			memo = "Reversal of " + original.Memo
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO entries (id, tenant_id, kind, reference_type, reference_id,
			                     memo, currency, reverses_id, posted_by, occurred_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
			reversalID, tenantID, "reversal", original.ReferenceType,
			original.ReferenceID, memo, original.Currency, id, actor); err != nil {
			return err
		}
		for _, l := range original.Lines {
			if _, err := tx.Exec(ctx, `
				INSERT INTO lines (entry_id, tenant_id, account_code, amount_minor, memo)
				VALUES ($1,$2,$3,$4,$5)`,
				reversalID, tenantID, l.AccountCode, -l.Minor, l.Memo); err != nil {
				return err
			}
		}
		out, err = scanEntry(tx.QueryRow(ctx,
			`SELECT `+entryCols+` FROM entries e WHERE e.id = $1`, reversalID))
		if err != nil {
			return err
		}
		return loadLines(ctx, tx, &out)
	})
	return out, err
}

func loadLines(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, e *Entry) error {
	rows, err := q.Query(ctx,
		`SELECT account_code, amount_minor, memo FROM lines WHERE entry_id = $1 ORDER BY id`,
		e.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	e.Lines = nil
	for rows.Next() {
		var l Line
		if err := rows.Scan(&l.AccountCode, &l.Minor, &l.Memo); err != nil {
			return err
		}
		e.Lines = append(e.Lines, l)
	}
	return rows.Err()
}

func (s *Store) Entry(ctx context.Context, tenantID, id uuid.UUID) (Entry, error) {
	e, err := scanEntry(s.pool.QueryRow(ctx,
		`SELECT `+entryCols+` FROM entries e WHERE e.tenant_id = $1 AND e.id = $2`,
		tenantID, id))
	if err != nil {
		return Entry{}, err
	}
	return e, loadLines(ctx, s.pool, &e)
}

// Filter narrows a listing.
type Filter struct {
	Kind          string
	ReferenceType string
	ReferenceID   string
	From          *time.Time
	To            *time.Time
	Limit         int
	BeforeAt      *time.Time
	BeforeID      *uuid.UUID
}

func (s *Store) ListEntries(ctx context.Context, tenantID uuid.UUID, f Filter) ([]Entry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+entryCols+` FROM entries e
		WHERE e.tenant_id = $1
		  AND ($2 = '' OR e.kind = $2)
		  AND ($3 = '' OR e.reference_type = $3)
		  AND ($4 = '' OR e.reference_id = $4)
		  AND ($5::timestamptz IS NULL OR e.occurred_at >= $5)
		  AND ($6::timestamptz IS NULL OR e.occurred_at < $6)
		  AND ($7::timestamptz IS NULL OR (e.occurred_at, e.id) < ($7, $8))
		ORDER BY e.occurred_at DESC, e.id DESC
		LIMIT $9`,
		tenantID, f.Kind, f.ReferenceType, f.ReferenceID, f.From, f.To,
		f.BeforeAt, f.BeforeID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := loadLines(ctx, s.pool, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Balance is one account's position.
type Balance struct {
	Account Account
	// The signed debit total. Positive is a net debit.
	DebitMinor int64
}

// TrialBalance sums every account over a period.
func (s *Store) TrialBalance(ctx context.Context, tenantID uuid.UUID, from, to *time.Time) ([]Balance, string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.code, a.name, a.kind, a.builtin,
		       coalesce(sum(l.amount_minor), 0)::bigint
		FROM accounts a
		LEFT JOIN lines l ON l.tenant_id = a.tenant_id AND l.account_code = a.code
		LEFT JOIN entries e ON e.id = l.entry_id
		  AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
		  AND ($3::timestamptz IS NULL OR e.occurred_at < $3)
		WHERE a.tenant_id = $1
		  AND (l.id IS NULL OR e.id IS NOT NULL)
		GROUP BY a.code, a.name, a.kind, a.builtin
		ORDER BY a.kind, a.code`, tenantID, from, to)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []Balance
	for rows.Next() {
		var b Balance
		if err := rows.Scan(&b.Account.Code, &b.Account.Name, &b.Account.Kind,
			&b.Account.Builtin, &b.DebitMinor); err != nil {
			return nil, "", err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// One currency per deployment, so the currency of the books is whatever the
	// entries are in. Read rather than configured, because a mismatch between a
	// flag and the data is the sort of thing that shows up as a report labelled
	// in the wrong currency.
	var currency string
	if err := s.pool.QueryRow(ctx,
		`SELECT currency FROM entries WHERE tenant_id = $1 ORDER BY posted_at DESC LIMIT 1`,
		tenantID).Scan(&currency); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, "", err
	}
	return out, currency, nil
}

// PostedLine is one line of an account ledger, with the balance after it.
type PostedLine struct {
	EntryID       uuid.UUID
	Kind          string
	Memo          string
	ReferenceType string
	ReferenceID   string
	Minor         int64
	RunningMinor  int64
	OccurredAt    time.Time
}

// AccountLedger returns one account's lines in order, with a running balance
// and the balance it opened the period with.
//
// The opening balance is computed rather than assumed to be zero, so a page of
// a ledger is readable on its own instead of only from the beginning of time.
func (s *Store) AccountLedger(ctx context.Context, tenantID uuid.UUID, code string,
	from, to *time.Time, limit int) (Account, int64, []PostedLine, error) {
	var a Account
	err := s.pool.QueryRow(ctx,
		`SELECT code, name, kind, builtin FROM accounts WHERE tenant_id = $1 AND code = $2`,
		tenantID, code).Scan(&a.Code, &a.Name, &a.Kind, &a.Builtin)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, 0, nil, ErrNotFound
	}
	if err != nil {
		return Account{}, 0, nil, err
	}

	var opening int64
	if from != nil {
		if err := s.pool.QueryRow(ctx, `
			SELECT coalesce(sum(l.amount_minor), 0)::bigint
			FROM lines l JOIN entries e ON e.id = l.entry_id
			WHERE l.tenant_id = $1 AND l.account_code = $2 AND e.occurred_at < $3`,
			tenantID, code, from).Scan(&opening); err != nil {
			return Account{}, 0, nil, err
		}
	}

	rows, err := s.pool.Query(ctx, `
		SELECT e.id, e.kind, coalesce(nullif(l.memo, ''), e.memo), e.reference_type,
		       e.reference_id, l.amount_minor, e.occurred_at
		FROM lines l JOIN entries e ON e.id = l.entry_id
		WHERE l.tenant_id = $1 AND l.account_code = $2
		  AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
		  AND ($4::timestamptz IS NULL OR e.occurred_at < $4)
		ORDER BY e.occurred_at, l.id
		LIMIT $5`, tenantID, code, from, to, limit)
	if err != nil {
		return Account{}, 0, nil, err
	}
	defer rows.Close()

	running := opening
	var out []PostedLine
	for rows.Next() {
		var l PostedLine
		if err := rows.Scan(&l.EntryID, &l.Kind, &l.Memo, &l.ReferenceType,
			&l.ReferenceID, &l.Minor, &l.OccurredAt); err != nil {
			return Account{}, 0, nil, err
		}
		running += l.Minor
		l.RunningMinor = running
		out = append(out, l)
	}
	return a, opening, out, rows.Err()
}
