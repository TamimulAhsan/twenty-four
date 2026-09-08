-- +goose Up
-- A sale. Trade-neutral by design: no dish, no cover, no treatment. A candy
-- shop, a boutique and a salon all write rows into this table.
CREATE TABLE orders (
    id              UUID PRIMARY KEY,
    tenant_id       UUID        NOT NULL,

    -- Human-facing, per tenant per day: 20260906-0001. Not a fiscal document
    -- number, which is Invoicing's job and has rules this does not.
    number          TEXT        NOT NULL,

    status          TEXT        NOT NULL CHECK (status IN
        ('open','paid','refunded','partly_refunded','voided')),

    -- For a parked sale this is when it was parked, which is what "waiting 40
    -- minutes" is measured against. Settling moves it to the moment it became
    -- a sale, so the receipt and the day's takings agree which day it is in.
    placed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- NULL for a walk-in, which is most sales in most trades.
    customer_id     UUID,
    customer_name   TEXT        NOT NULL DEFAULT '',
    discount_code   TEXT        NOT NULL DEFAULT '',
    discount_minor  BIGINT      NOT NULL DEFAULT 0,

    currency        TEXT        NOT NULL CHECK (char_length(currency) = 3),
    gross_minor     BIGINT      NOT NULL DEFAULT 0,
    net_minor       BIGINT      NOT NULL DEFAULT 0,
    tax_minor       BIGINT      NOT NULL DEFAULT 0,

    -- What actually went back, carried rather than derived. A partial refund
    -- cannot be recovered from the status, and takings that guess at it are
    -- wrong on every day somebody returned one thing out of four.
    refunded_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),

    staff_id        UUID,
    note            TEXT        NOT NULL DEFAULT '',

    -- The table a parked sale is running on. NULL in every trade with no floor.
    table_id        UUID,

    void_reason     TEXT        NOT NULL DEFAULT '',

    -- A retried checkout must find the sale it already made rather than make a
    -- second one. Enforced by the index below, not by a check in a handler.
    idempotency_key TEXT        NOT NULL DEFAULT '',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (refunded_minor <= gross_minor)
);

CREATE UNIQUE INDEX orders_idempotency
    ON orders (tenant_id, idempotency_key) WHERE idempotency_key <> '';
CREATE UNIQUE INDEX orders_number ON orders (tenant_id, number);
CREATE INDEX orders_day ON orders (tenant_id, placed_at DESC);
CREATE INDEX orders_parked ON orders (tenant_id, placed_at) WHERE status = 'open';
CREATE INDEX orders_table ON orders (table_id) WHERE table_id IS NOT NULL;

-- Every figure here is copied from Catalog when the line is rung up and never
-- re-read. A sale must not change because somebody edited a price afterwards.
CREATE TABLE order_lines (
    id               UUID PRIMARY KEY,
    order_id         UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    tenant_id        UUID        NOT NULL,
    item_id          UUID        NOT NULL,
    name             TEXT        NOT NULL,
    quantity         INT         NOT NULL CHECK (quantity > 0),
    unit_price_minor BIGINT      NOT NULL,
    tax_basis_points INT         NOT NULL,
    tax_included     BOOLEAN     NOT NULL,
    discount_minor   BIGINT      NOT NULL DEFAULT 0,
    gross_minor      BIGINT      NOT NULL,
    net_minor        BIGINT      NOT NULL,
    tax_minor        BIGINT      NOT NULL,
    position         INT         NOT NULL DEFAULT 0,
    -- A line goes back once. The second attempt is refused rather than paid
    -- out twice, and this is what refuses it.
    refunded_at      TIMESTAMPTZ
);

CREATE INDEX order_lines_order ON order_lines (order_id, position);

-- One sale, one or several payments.
CREATE TABLE tenders (
    id             UUID PRIMARY KEY,
    order_id       UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    tenant_id      UUID        NOT NULL,
    method         TEXT        NOT NULL,
    amount_minor   BIGINT      NOT NULL CHECK (amount_minor > 0),

    -- Cash only. Change exists in a drawer, not in a payment provider, which
    -- is why these are nullable rather than zero for a card.
    tendered_minor BIGINT,
    change_minor   BIGINT,

    -- The Payments record behind this tender. POS never holds card data or a
    -- provider's own state; it holds this pointer.
    payment_id     UUID,
    reference      TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tenders_order ON tenders (order_id);
CREATE INDEX tenders_day ON tenders (tenant_id, created_at);

-- Order numbers are allocated under a row lock rather than from a sequence.
-- A sequence leaves holes when a transaction rolls back; a till that skips from
-- 41 to 43 is a till somebody will ask about.
CREATE TABLE order_counters (
    tenant_id UUID NOT NULL,
    day       DATE NOT NULL,
    next      INT  NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, day)
);

-- Counting the drawer. There is no denomination breakdown on purpose: which
-- notes and coins exist is the one part of this that differs per market, and a
-- note table in shared code is country logic wearing a hat.
CREATE TABLE day_closes (
    tenant_id           UUID        NOT NULL,
    day                 DATE        NOT NULL,
    opening_float_minor BIGINT      NOT NULL DEFAULT 0,
    counted_minor       BIGINT      NOT NULL,
    currency            TEXT        NOT NULL,
    counted_by          UUID,
    counted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    note                TEXT        NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, day)
);

-- The floor. A trade capability, not a sold module: a venue where people sit
-- down gets these from its industry profile and a shop never sees them.
CREATE TABLE dining_tables (
    id         UUID PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    label      TEXT        NOT NULL,
    seats      INT         NOT NULL DEFAULT 2 CHECK (seats > 0),
    area       TEXT        NOT NULL DEFAULT '',
    status     TEXT        NOT NULL DEFAULT 'free'
        CHECK (status IN ('free','seated','ordered','bill_requested')),
    party_size INT,
    seated_at  TIMESTAMPTZ,
    staff_id   UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX dining_tables_label ON dining_tables (tenant_id, lower(label));
CREATE INDEX dining_tables_tenant ON dining_tables (tenant_id, area, label);

-- +goose Down
DROP TABLE dining_tables;
DROP TABLE day_closes;
DROP TABLE order_counters;
DROP TABLE tenders;
DROP TABLE order_lines;
DROP TABLE orders;
