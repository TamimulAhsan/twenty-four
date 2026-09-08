-- +goose Up
-- The current position, one row per stocked item.
--
-- It is derived from stock_moves and kept up to date in the same transaction as
-- the move that changed it. Two representations of the same fact is usually a
-- mistake; here it is the difference between a till that answers "how many are
-- left" in a millisecond and one that sums a year of movements to find out.
CREATE TABLE stock_levels (
    tenant_id           UUID        NOT NULL,
    item_id             UUID        NOT NULL,

    -- What is physically there. May go negative: a shop that sells its last
    -- two coffees while the count says one has a counting problem, and
    -- refusing the sale does not fix it. Trading continues; the number tells
    -- the truth about what happened.
    on_hand             INT         NOT NULL DEFAULT 0,

    -- Held against open orders and bookings. Still on hand, not available.
    reserved            INT         NOT NULL DEFAULT 0 CHECK (reserved >= 0),

    -- NULL is no threshold, which is not a threshold of zero: an item with no
    -- threshold never warns, one set to zero warns when it runs out.
    low_stock_threshold INT,

    -- Whether stock.low has already been announced. Without it the relay would
    -- publish a warning on every movement while an item sits below its
    -- threshold, and a warning that arrives forty times is a warning nobody
    -- reads. Cleared when the level climbs back above.
    low_announced       BOOLEAN     NOT NULL DEFAULT FALSE,

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, item_id)
);

CREATE INDEX stock_levels_low ON stock_levels (tenant_id)
    WHERE low_stock_threshold IS NOT NULL;

-- Every change, with its reason. This is the audit trail, and it is what makes
-- "why is this number 3" a question with an answer.
CREATE TABLE stock_moves (
    id              UUID        PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    item_id         UUID        NOT NULL,

    -- Signed, in units. What it means depends on kind.
    delta           INT         NOT NULL,
    -- consume_unreserved is a walk-in sale that was never held: the shelf
    -- falls but no reservation is given back. Keeping it a separate kind
    -- rather than a flag means the movement history reads as what happened.
    kind            TEXT        NOT NULL
        CHECK (kind IN ('adjustment','reserve','release','consume','consume_unreserved')),
    reason          TEXT        NOT NULL DEFAULT '',

    -- What caused it: an order, a booking, a stock count.
    reference_type  TEXT        NOT NULL DEFAULT '',
    reference_id    TEXT        NOT NULL DEFAULT '',
    actor_id        UUID,
    idempotency_key TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A retried request applies once. A till that loses its network mid-adjustment
-- and sends again must not count the delivery twice. Partial, so the many moves
-- with no key do not collide with each other.
CREATE UNIQUE INDEX stock_moves_idempotency
    ON stock_moves (tenant_id, idempotency_key) WHERE idempotency_key <> '';

CREATE INDEX stock_moves_item ON stock_moves (tenant_id, item_id, created_at DESC);
CREATE INDEX stock_moves_reference ON stock_moves (tenant_id, reference_type, reference_id)
    WHERE reference_id <> '';

-- +goose Down
DROP TABLE stock_moves;
DROP TABLE stock_levels;
