-- +goose Up

-- A standing instruction: something that fires repeatedly.
--
-- Keyed by the service that owns the work rather than by a generated id, so a
-- service can declare its schedules on every start and get the same row back
-- instead of a new one each time. Restarting a pod five times must not produce
-- five nightly reconciliations.
CREATE TABLE schedules (
    tenant_id     UUID        NOT NULL,
    key           TEXT        NOT NULL,

    topic         TEXT        NOT NULL,
    every_seconds BIGINT      NOT NULL,
    -- Which hour it fires, in the tenant's own zone. Only meaningful for a
    -- daily schedule or longer: a nightly job that runs at whatever time the
    -- pod happened to start is a nightly job nobody can reason about.
    hour          INT,
    time_zone     TEXT        NOT NULL DEFAULT 'UTC',

    payload       JSONB,
    paused        BOOLEAN     NOT NULL DEFAULT FALSE,

    next_run_at   TIMESTAMPTZ NOT NULL,
    last_run_at   TIMESTAMPTZ,
    last_error    TEXT        NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key),

    CONSTRAINT schedules_interval_positive CHECK (every_seconds > 0),
    CONSTRAINT schedules_hour_in_range CHECK (hour IS NULL OR (hour >= 0 AND hour <= 23))
);

-- The runner's query, across every tenant. Partial, so a paused schedule costs
-- nothing to skip.
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE NOT paused;

-- A single instruction: something that fires once.
CREATE TABLE reminders (
    id           UUID PRIMARY KEY,
    tenant_id    UUID        NOT NULL,

    topic        TEXT        NOT NULL,
    due_at       TIMESTAMPTZ NOT NULL,
    -- pending, fired or cancelled. Cancelled rather than deleted, so "why did
    -- nobody get reminded" has an answer that is not an absent row.
    state        TEXT        NOT NULL DEFAULT 'pending',

    subject_type TEXT        NOT NULL DEFAULT '',
    subject_id   TEXT        NOT NULL DEFAULT '',
    payload      JSONB,

    fired_at     TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    idempotency_key TEXT     NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX reminders_idempotent ON reminders (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';

-- Cancelling everything still pending about one thing, which is what a
-- cancelled booking needs and what stops the caller having to keep reminder ids.
CREATE INDEX reminders_subject ON reminders (tenant_id, subject_type, subject_id)
    WHERE state = 'pending';

-- The runner's query. Partial, so it stays the size of what is still coming
-- rather than the size of everything ever scheduled.
CREATE INDEX reminders_due ON reminders (due_at) WHERE state = 'pending';

-- +goose Down
DROP TABLE reminders;
DROP TABLE schedules;
