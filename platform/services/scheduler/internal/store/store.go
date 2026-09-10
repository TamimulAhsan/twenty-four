// Package store is the Scheduler service's PostgreSQL persistence.
//
// The shape to understand: firing something and recording that it fired happen
// in one transaction, and the event goes into the outbox in the same one. That
// is what makes "at most one event per due time" true rather than hopeful. The
// alternative, publishing and then marking, double-fires on any crash between
// the two, and a doubled nightly reconciliation is a doubled set of journal
// entries.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/scheduler/migrations"
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

// Schedule is a standing instruction.
type Schedule struct {
	TenantID     uuid.UUID
	Key          string
	Topic        string
	EverySeconds int64
	Hour         *int32
	TimeZone     string
	Payload      json.RawMessage
	Paused       bool
	NextRunAt    time.Time
	LastRunAt    *time.Time
	LastError    string
}

const scheduleCols = `tenant_id, key, topic, every_seconds, hour, time_zone,
	payload, paused, next_run_at, last_run_at, last_error`

func scanSchedule(row pgx.Row) (Schedule, error) {
	var s Schedule
	err := row.Scan(&s.TenantID, &s.Key, &s.Topic, &s.EverySeconds, &s.Hour,
		&s.TimeZone, &s.Payload, &s.Paused, &s.NextRunAt, &s.LastRunAt, &s.LastError)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, ErrNotFound
	}
	return s, err
}

// NextRun works out when a schedule fires next.
//
// For anything shorter than a day it is simply the interval from now. For a
// daily schedule with an hour, it is that hour in the tenant's own zone, which
// is the only way "the nightly reconciliation" means the same thing in Budapest
// and in Dhaka.
func NextRun(from time.Time, everySeconds int64, hour *int32, zone string) time.Time {
	interval := time.Duration(everySeconds) * time.Second
	if hour == nil || interval < 24*time.Hour {
		return from.Add(interval)
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		// An unknown zone must not stop the schedule running. UTC may be the
		// wrong hour, which is visible; not running at all is not.
		loc = time.UTC
	}
	local := from.In(loc)
	next := time.Date(local.Year(), local.Month(), local.Day(), int(*hour), 0, 0, 0, loc)
	for !next.After(local) {
		next = next.AddDate(0, 0, int(interval/(24*time.Hour)))
	}
	return next.UTC()
}

// PutSchedule registers or replaces one.
//
// Replacing keeps the existing next run time when the timing has not changed,
// so a service restarting does not push its nightly job forward by a day every
// time it is deployed. That is the bug this ON CONFLICT clause exists to avoid:
// a job that never runs because the pod restarts more often than the interval.
func (s *Store) PutSchedule(ctx context.Context, in Schedule) (Schedule, error) {
	next := NextRun(time.Now(), in.EverySeconds, in.Hour, in.TimeZone)
	return scanSchedule(s.pool.QueryRow(ctx, `
		INSERT INTO schedules (tenant_id, key, topic, every_seconds, hour, time_zone,
		                       payload, paused, next_run_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (tenant_id, key) DO UPDATE SET
			topic = EXCLUDED.topic,
			every_seconds = EXCLUDED.every_seconds,
			hour = EXCLUDED.hour,
			time_zone = EXCLUDED.time_zone,
			payload = EXCLUDED.payload,
			paused = EXCLUDED.paused,
			next_run_at = CASE
				WHEN schedules.every_seconds IS DISTINCT FROM EXCLUDED.every_seconds
				  OR schedules.hour IS DISTINCT FROM EXCLUDED.hour
				  OR schedules.time_zone IS DISTINCT FROM EXCLUDED.time_zone
				THEN EXCLUDED.next_run_at
				ELSE schedules.next_run_at
			END,
			updated_at = now()
		RETURNING `+scheduleCols,
		in.TenantID, in.Key, in.Topic, in.EverySeconds, in.Hour, in.TimeZone,
		in.Payload, in.Paused, next))
}

func (s *Store) Schedule(ctx context.Context, tenantID uuid.UUID, key string) (Schedule, error) {
	return scanSchedule(s.pool.QueryRow(ctx,
		`SELECT `+scheduleCols+` FROM schedules WHERE tenant_id = $1 AND key = $2`,
		tenantID, key))
}

func (s *Store) ListSchedules(ctx context.Context, tenantID uuid.UUID) ([]Schedule, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+scheduleCols+` FROM schedules WHERE tenant_id = $1 ORDER BY key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Schedule
	for rows.Next() {
		sc, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSchedule(ctx context.Context, tenantID uuid.UUID, key string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM schedules WHERE tenant_id = $1 AND key = $2`, tenantID, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// FireDueSchedules publishes for every schedule whose time has come, and moves
// each one on, in one transaction per schedule.
//
// The claim and the event are atomic. The other order, publish then mark,
// double-fires on any crash between them, and a doubled nightly reconciliation
// is a doubled set of journal entries.
//
// It returns how many fired.
func (s *Store) FireDueSchedules(ctx context.Context, limit int) (int, error) {
	fired := 0
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+scheduleCols+` FROM schedules
			WHERE NOT paused AND next_run_at <= now()
			ORDER BY next_run_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, limit)
		if err != nil {
			return err
		}
		var due []Schedule
		for rows.Next() {
			sc, err := scanSchedule(rows)
			if err != nil {
				rows.Close()
				return err
			}
			due = append(due, sc)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, sc := range due {
			// The next run is computed from now rather than from the run that
			// was missed. A service down for a day would otherwise come back
			// and fire a day's worth of six-hour cycles in a burst, which for
			// the budget cycle means four reallocations in a second.
			next := NextRun(time.Now(), sc.EverySeconds, sc.Hour, sc.TimeZone)
			if _, err := tx.Exec(ctx, `
				UPDATE schedules
				SET last_run_at = now(), next_run_at = $3, last_error = ''
				WHERE tenant_id = $1 AND key = $2`, sc.TenantID, sc.Key, next); err != nil {
				return err
			}
			if _, err := outbox.Enqueue(ctx, tx, outbox.Event{
				TenantID: sc.TenantID, Topic: sc.Topic, Key: sc.Key,
				Payload: map[string]any{
					"schedule_key": sc.Key, "due_at": sc.NextRunAt,
					"payload": rawOrNil(sc.Payload),
				},
			}); err != nil {
				return err
			}
			fired++
		}
		return nil
	})
	return fired, err
}

// RunNow fires a schedule without moving its next run time.
//
// Leaving the schedule alone is the point: a specialist making a nightly job
// happen now must not thereby move tonight's run, or every manual nudge would
// quietly reschedule the thing it was nudging.
func (s *Store) RunNow(ctx context.Context, tenantID uuid.UUID, key string) (Schedule, error) {
	var out Schedule
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = scanSchedule(tx.QueryRow(ctx,
			`SELECT `+scheduleCols+` FROM schedules WHERE tenant_id = $1 AND key = $2 FOR UPDATE`,
			tenantID, key))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE schedules SET last_run_at = now() WHERE tenant_id = $1 AND key = $2`,
			tenantID, key); err != nil {
			return err
		}
		_, err = outbox.Enqueue(ctx, tx, outbox.Event{
			TenantID: tenantID, Topic: out.Topic, Key: key,
			Payload: map[string]any{
				"schedule_key": key, "due_at": time.Now(),
				"manual": true, "payload": rawOrNil(out.Payload),
			},
		})
		return err
	})
	return out, err
}

// Reminder is a single instruction.
type Reminder struct {
	ID             uuid.UUID
	TenantID       uuid.UUID
	Topic          string
	DueAt          time.Time
	State          string
	SubjectType    string
	SubjectID      string
	Payload        json.RawMessage
	FiredAt        *time.Time
	CreatedAt      time.Time
	IdempotencyKey string
}

const reminderCols = `id, tenant_id, topic, due_at, state, subject_type,
	subject_id, payload, fired_at, created_at, idempotency_key`

func scanReminder(row pgx.Row) (Reminder, error) {
	var r Reminder
	err := row.Scan(&r.ID, &r.TenantID, &r.Topic, &r.DueAt, &r.State,
		&r.SubjectType, &r.SubjectID, &r.Payload, &r.FiredAt, &r.CreatedAt,
		&r.IdempotencyKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return Reminder{}, ErrNotFound
	}
	return r, err
}

func (s *Store) PutReminder(ctx context.Context, r Reminder) (Reminder, bool, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	out, err := scanReminder(s.pool.QueryRow(ctx, `
		INSERT INTO reminders (id, tenant_id, topic, due_at, subject_type,
		                       subject_id, payload, idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key <> ''
		DO NOTHING
		RETURNING `+reminderCols,
		r.ID, r.TenantID, r.Topic, r.DueAt, r.SubjectType, r.SubjectID,
		r.Payload, r.IdempotencyKey))
	if err == nil {
		return out, false, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Reminder{}, false, err
	}
	out, err = scanReminder(s.pool.QueryRow(ctx,
		`SELECT `+reminderCols+` FROM reminders WHERE tenant_id = $1 AND idempotency_key = $2`,
		r.TenantID, r.IdempotencyKey))
	return out, true, err
}

// CancelReminder cancels one, or everything still pending about one subject.
//
// Cancelled rather than deleted, so a booking that was moved and then asked
// about has a trail rather than an absence.
func (s *Store) CancelReminder(ctx context.Context, tenantID uuid.UUID, id *uuid.UUID, subjectType, subjectID string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE reminders SET state = 'cancelled'
		WHERE tenant_id = $1 AND state = 'pending'
		  AND ($2::uuid IS NULL OR id = $2)
		  AND ($3 = '' OR (subject_type = $3 AND subject_id = $4))`,
		tenantID, id, subjectType, subjectID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (s *Store) ListReminders(ctx context.Context, tenantID uuid.UUID, state, subjectType, subjectID string, limit int) ([]Reminder, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+reminderCols+` FROM reminders
		WHERE tenant_id = $1
		  AND ($2 = '' OR state = $2)
		  AND ($3 = '' OR subject_type = $3)
		  AND ($4 = '' OR subject_id = $4)
		ORDER BY due_at DESC, id DESC
		LIMIT $5`, tenantID, state, subjectType, subjectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Reminder
	for rows.Next() {
		r, err := scanReminder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FireDueReminders publishes and marks, in one transaction, for the same reason
// schedules do.
func (s *Store) FireDueReminders(ctx context.Context, limit int) (int, error) {
	fired := 0
	err := s.pool.Tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+reminderCols+` FROM reminders
			WHERE state = 'pending' AND due_at <= now()
			ORDER BY due_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, limit)
		if err != nil {
			return err
		}
		var due []Reminder
		for rows.Next() {
			r, err := scanReminder(rows)
			if err != nil {
				rows.Close()
				return err
			}
			due = append(due, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, r := range due {
			if _, err := tx.Exec(ctx,
				`UPDATE reminders SET state = 'fired', fired_at = now() WHERE id = $1`,
				r.ID); err != nil {
				return err
			}
			if _, err := outbox.Enqueue(ctx, tx, outbox.Event{
				TenantID: r.TenantID, Topic: r.Topic, Key: r.SubjectID,
				Payload: map[string]any{
					"reminder_id": r.ID, "due_at": r.DueAt,
					"subject_type": r.SubjectType, "subject_id": r.SubjectID,
					"payload": rawOrNil(r.Payload),
				},
			}); err != nil {
				return err
			}
			fired++
		}
		return nil
	})
	return fired, err
}

// rawOrNil keeps an absent payload absent rather than turning it into the
// four characters "null", which a consumer then has to know to disbelieve.
func rawOrNil(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}
