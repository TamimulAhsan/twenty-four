-- +goose Up

-- What can be booked.
--
-- Not "staff" and not "rooms". A salon books a person, a hotel books a room, a
-- clinic books both and a restaurant books a table; they are the same shape,
-- and naming the table after one trade is how a service stops working for the
-- other forty. The industry profile decides what a merchant sees these called.
CREATE TABLE resources (
    id         UUID PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    name       TEXT        NOT NULL,
    -- The Staff service's user id when this resource is a person, so a rota
    -- and a calendar can agree about who is working. Null for a room.
    staff_id   UUID,
    -- How many bookings it holds at once. One for a chair, six for a table, a
    -- dozen for a class.
    capacity   INT         NOT NULL DEFAULT 1,
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT resources_capacity_positive CHECK (capacity > 0)
);

CREATE INDEX resources_tenant ON resources (tenant_id) WHERE active;

-- When a resource is open. One row per weekday it works, so a person working
-- Tuesday to Saturday has five.
CREATE TABLE opening_windows (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID    NOT NULL,
    resource_id UUID    NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    -- ISO weekday, 1 is Monday. Matching the analytics heatmap rather than
    -- Go's Sunday-is-zero: one of them had to be chosen and this is the
    -- standard.
    weekday     INT     NOT NULL,
    -- HH:MM in the tenant's own zone. Stored as text because they are wall
    -- clock times, not instants: 09:00 stays 09:00 across a daylight saving
    -- change, which is what a business means by "we open at nine".
    opens       TEXT    NOT NULL,
    closes      TEXT    NOT NULL,

    CONSTRAINT opening_weekday_iso CHECK (weekday BETWEEN 1 AND 7)
);

CREATE INDEX opening_resource ON opening_windows (resource_id);

CREATE TABLE bookings (
    id             UUID PRIMARY KEY,
    tenant_id      UUID        NOT NULL,
    -- Short, human, and said out loud on the telephone.
    reference      TEXT        NOT NULL,

    item_id        UUID        NOT NULL,
    -- Copied at booking. The catalog moves on and a booking made for a
    -- forty-minute cut is still a forty-minute cut when the item is renamed.
    item_name      TEXT        NOT NULL DEFAULT '',
    resource_id    UUID        NOT NULL REFERENCES resources(id),

    customer_name  TEXT        NOT NULL DEFAULT '',
    customer_phone TEXT        NOT NULL DEFAULT '',
    customer_email TEXT        NOT NULL DEFAULT '',

    starts_at      TIMESTAMPTZ NOT NULL,
    ends_at        TIMESTAMPTZ NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'confirmed',

    -- Unset is not zero. No deposit asked for is a different thing from a
    -- deposit of nothing, and a no-show policy turns on which it was.
    deposit_minor  BIGINT,
    deposit_currency TEXT      NOT NULL DEFAULT '',
    payment_id     TEXT        NOT NULL DEFAULT '',

    note           TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at   TIMESTAMPTZ,
    cancellation_reason TEXT   NOT NULL DEFAULT '',

    idempotency_key TEXT       NOT NULL DEFAULT '',

    CONSTRAINT bookings_ends_after_starts CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX bookings_reference ON bookings (tenant_id, reference);
CREATE UNIQUE INDEX bookings_idempotent ON bookings (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';

-- The calendar's query: a window of time, optionally for one resource.
CREATE INDEX bookings_window ON bookings (tenant_id, starts_at, ends_at);
CREATE INDEX bookings_resource ON bookings (resource_id, starts_at)
    WHERE status IN ('confirmed', 'arrived');

-- +goose Down
DROP TABLE bookings;
DROP TABLE opening_windows;
DROP TABLE resources;
