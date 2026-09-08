-- +goose Up
-- Payments is SWAPPED PER MARKET. This schema belongs to the development
-- provider; a Hungarian or Bangladeshi implementation deploys its own, shaped
-- by what its provider actually returns. What must not differ is the gRPC
-- contract in front of it.
CREATE TABLE payments (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID        NOT NULL,

    -- Supplied by the caller and stable across retries. This is what makes a
    -- till that loses its network mid-tender safe to retry: the same key
    -- always returns the same payment rather than charging twice.
    idempotency_key    TEXT        NOT NULL,

    -- Integer minor units plus an explicit ISO code. Never a float, and never
    -- an amount without its currency: the exponent differs, so the number
    -- alone is meaningless.
    amount_minor       BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency           TEXT        NOT NULL CHECK (char_length(currency) = 3),
    refunded_minor     BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),

    status             TEXT        NOT NULL CHECK (status IN
        ('pending','authorized','captured','failed','refunded','partially_refunded','cancelled')),
    method_key         TEXT        NOT NULL,

    -- What is being paid for, so the payment reconciles later.
    reference_type     TEXT        NOT NULL DEFAULT '',
    reference_id       TEXT        NOT NULL DEFAULT '',

    -- This market's provider reference. Opaque upstream: never parsed by a
    -- caller, only shown to support and used for reconciliation.
    provider_reference TEXT        NOT NULL DEFAULT '',
    failure_reason     TEXT        NOT NULL DEFAULT '',
    metadata           JSONB       NOT NULL DEFAULT '{}',

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    captured_at        TIMESTAMPTZ,

    -- A refund can never exceed what was taken. Stated as a constraint rather
    -- than a check in a handler, because money that can be refunded twice is
    -- the kind of bug that is discovered by an accountant.
    CHECK (refunded_minor <= amount_minor)
);

CREATE UNIQUE INDEX payments_idempotency ON payments (tenant_id, idempotency_key);
CREATE INDEX payments_reference ON payments (tenant_id, reference_type, reference_id)
    WHERE reference_id <> '';
CREATE INDEX payments_recent ON payments (tenant_id, created_at DESC);
-- The approval desk's only query.
CREATE INDEX payments_pending ON payments (created_at) WHERE status = 'pending';

-- Refunds are their own rows, not a running total, because "which refund was
-- that" is a question support gets asked and a total cannot answer.
CREATE TABLE refunds (
    id              UUID PRIMARY KEY,
    payment_id      UUID        NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    tenant_id       UUID        NOT NULL,
    amount_minor    BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency        TEXT        NOT NULL,
    reason          TEXT        NOT NULL DEFAULT '',
    idempotency_key TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refunds_idempotency
    ON refunds (tenant_id, idempotency_key) WHERE idempotency_key <> '';
CREATE INDEX refunds_payment ON refunds (payment_id, created_at);

-- +goose Down
DROP TABLE refunds;
DROP TABLE payments;
