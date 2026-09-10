-- +goose Up
-- What this consumer has already done.
--
-- Delivery is at-least-once, so a redelivered event is normal rather than
-- exceptional: a relay restart, a consumer rebalance, or a handler that failed
-- halfway through a batch all produce one. Without this table each of those
-- would be a duplicate journal entry, a second email, or a booking counted
-- twice.
--
-- Keyed on the consumer as well as the event, because two consumers in the same
-- database, a projection and a notifier say, must each get their own chance at
-- the same event.
CREATE TABLE handled_events (
    consumer   TEXT        NOT NULL,
    event_id   UUID        NOT NULL,
    tenant_id  UUID        NOT NULL,
    topic      TEXT        NOT NULL,
    handled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- Retention, when somebody decides on it, sweeps by age. Same open question as
-- the outbox has: dropping rows loses the proof, keeping them grows the table.
CREATE INDEX handled_events_age ON handled_events (handled_at);

-- +goose Down
DROP TABLE handled_events;
