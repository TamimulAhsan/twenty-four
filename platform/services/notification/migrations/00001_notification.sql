-- +goose Up

-- The tenant's sending policy. One row per tenant, created on first read with
-- the platform's defaults, because a business that has never opened the
-- settings screen still has to be able to send a receipt.
CREATE TABLE preferences (
    tenant_id         UUID PRIMARY KEY,

    -- Which channels this business sends on at all. A channel absent here
    -- suppresses every message on it including transactional ones: a business
    -- that has not set up SMS cannot send an SMS, and pretending otherwise
    -- would produce a delivery log full of sends that never happened.
    channels          TEXT[]      NOT NULL DEFAULT ARRAY['email'],

    -- HH:MM in the tenant's own time zone. Equal values mean no quiet hours
    -- rather than a zero-length window: a business wanting silence all day
    -- turns the channel off instead, which is a different intent and reads
    -- differently in the log.
    quiet_from        TEXT        NOT NULL DEFAULT '21:00',
    quiet_to          TEXT        NOT NULL DEFAULT '08:00',
    -- Copied here rather than read from Tenant on every send. A reminder going
    -- out at six in the morning because a profile lookup timed out is worse
    -- than one going out against an offset that is a day stale.
    time_zone         TEXT        NOT NULL DEFAULT 'UTC',

    booking_reminders BOOLEAN     NOT NULL DEFAULT TRUE,
    receipt_by_email  BOOLEAN     NOT NULL DEFAULT TRUE,
    -- The one category that is opt-in. Every other default is on.
    marketing         BOOLEAN     NOT NULL DEFAULT FALSE,

    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A tenant's own text for a message. The platform's templates are in code, not
-- in this table: seeding forty-three industries' worth of rows per tenant would
-- make every wording fix a data migration, and a tenant who never edits
-- anything would carry a private copy of text that is identical everywhere.
--
-- So a row here is always an override, and deleting one restores the built-in
-- rather than leaving the tenant unable to send.
CREATE TABLE templates (
    tenant_id  UUID        NOT NULL,
    key        TEXT        NOT NULL,
    channel    TEXT        NOT NULL,
    category   TEXT        NOT NULL,
    subject    TEXT        NOT NULL DEFAULT '',
    body       TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);

-- Every message this service accepted, including the ones it refused to send.
--
-- The rendered subject and body are stored rather than recomposed on read, for
-- the same reason an issued invoice is stored rather than recomputed: the
-- question later is what the customer actually received, and re-rendering
-- against a template that has since been edited answers a different question.
CREATE TABLE deliveries (
    id              UUID PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    template_key    TEXT        NOT NULL,
    channel         TEXT        NOT NULL,
    category        TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    recipient       TEXT        NOT NULL,
    subject         TEXT        NOT NULL DEFAULT '',
    body            TEXT        NOT NULL,

    reference_type  TEXT        NOT NULL DEFAULT '',
    reference_id    TEXT        NOT NULL DEFAULT '',

    -- Set while held for quiet hours, and cleared once sent. A worker claims
    -- rows whose time has come.
    deliver_after   TIMESTAMPTZ,
    attempts        INT         NOT NULL DEFAULT 0,
    failure_reason  TEXT        NOT NULL DEFAULT '',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,

    idempotency_key TEXT        NOT NULL DEFAULT ''
);

-- A retried send with the same key delivers once. Partial, so the many rows
-- sent without a key do not all collide on the empty string.
CREATE UNIQUE INDEX deliveries_idempotent ON deliveries (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';

-- The delivery log read beside the thing it concerns: this order's receipt,
-- this booking's reminder.
CREATE INDEX deliveries_reference ON deliveries (tenant_id, reference_type, reference_id);

CREATE INDEX deliveries_recent ON deliveries (tenant_id, created_at DESC, id DESC);

-- The sender's only query. Partial, so it stays the size of the queue rather
-- than the size of everything ever sent.
CREATE INDEX deliveries_due ON deliveries (deliver_after, created_at)
    WHERE status IN ('queued', 'held');

-- +goose Down
DROP TABLE deliveries;
DROP TABLE templates;
DROP TABLE preferences;
