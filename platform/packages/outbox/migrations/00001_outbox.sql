-- +goose Up
-- The transactional outbox. Every service that emits an event owns one of
-- these, in its own database, written in the same transaction as the state
-- change that caused the event.
--
-- available_at is not in the original sketch and earns its place: without it a
-- row that can never be published is retried on every poll, forever, at the
-- head of the queue. With it a failing row backs off and the rows behind it
-- keep moving.
CREATE TABLE outbox (
    id            UUID PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    topic         TEXT        NOT NULL,
    key           TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    attempts      INT         NOT NULL DEFAULT 0,
    last_error    TEXT
);

-- The relay's only query. Partial, so the index stays the size of the backlog
-- rather than the size of the history.
CREATE INDEX outbox_pending ON outbox (available_at, created_at, id)
    WHERE published_at IS NULL;

-- Retention sweeps, when they are turned on, scan by publication time.
CREATE INDEX outbox_published ON outbox (published_at)
    WHERE published_at IS NOT NULL;

-- +goose Down
DROP TABLE outbox;
