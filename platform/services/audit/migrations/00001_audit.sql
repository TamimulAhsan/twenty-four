-- +goose Up
-- The trail. Append only, by construction: there is no update and no delete in
-- the store, and the service exposes neither. A record that can be edited is a
-- record nobody has to believe.
CREATE TABLE entries (
    id           UUID PRIMARY KEY,
    tenant_id    UUID        NOT NULL,

    -- The event this was derived from, when it came from one. Also the
    -- deduplication key: delivery is at-least-once, and a trail that gains a
    -- duplicate line every time a consumer rebalances is a trail that makes
    -- one refund look like two.
    event_id     UUID,

    action       TEXT        NOT NULL,
    actor_kind   TEXT        NOT NULL,
    actor_id     TEXT        NOT NULL DEFAULT '',
    -- Stored rather than joined. The name a person had when they acted is what
    -- the record should show afterwards, even once they are renamed or gone,
    -- and the service that owns names is not this one.
    actor_label  TEXT        NOT NULL DEFAULT '',

    subject_type TEXT        NOT NULL DEFAULT '',
    subject_id   TEXT        NOT NULL DEFAULT '',

    summary      TEXT        NOT NULL,
    detail       JSONB,
    source       TEXT        NOT NULL DEFAULT '',

    -- When the thing happened, which is not when this row was written: an event
    -- sits in an outbox and then in a topic before it gets here.
    occurred_at  TIMESTAMPTZ NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    idempotency_key TEXT     NOT NULL DEFAULT ''
);

-- One line per event. Partial, because entries recorded directly have no event.
CREATE UNIQUE INDEX entries_one_per_event ON entries (tenant_id, event_id)
    WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX entries_idempotent ON entries (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';

-- The two ways the trail is read: newest first for a tenant, and everything
-- about one thing.
CREATE INDEX entries_recent ON entries (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX entries_subject ON entries (tenant_id, subject_type, subject_id, occurred_at);

-- +goose Down
DROP TABLE entries;
