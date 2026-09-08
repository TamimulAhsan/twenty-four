-- +goose Up
-- Categories exist so a till can group its buttons. They are a merchant's own
-- vocabulary, seeded from the industry template at provisioning and edited
-- freely afterwards.
CREATE TABLE categories (
    id          UUID PRIMARY KEY,
    tenant_id   UUID        NOT NULL,
    name        TEXT        NOT NULL,
    position    INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);

-- Two live categories with the same name is a merchant staring at two
-- identical tabs wondering which one has the coffee in it.
CREATE UNIQUE INDEX categories_tenant_name
    ON categories (tenant_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX categories_tenant ON categories (tenant_id, position, name);

CREATE TABLE items (
    id               UUID PRIMARY KEY,
    tenant_id        UUID        NOT NULL,
    sku              TEXT        NOT NULL,
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    kind             TEXT        NOT NULL CHECK (kind IN ('product','service')),

    -- Money is integer minor units plus an explicit ISO code, never a float.
    -- The exponent differs by currency, so the amount alone means nothing.
    unit_price_minor BIGINT      NOT NULL CHECK (unit_price_minor >= 0),
    currency         TEXT        NOT NULL CHECK (char_length(currency) = 3),

    -- Nullable on purpose. NULL is "not recorded", which is not zero: an item
    -- with no recorded cost has no margin, not a margin of 100%.
    cost_price_minor BIGINT      CHECK (cost_price_minor IS NULL OR cost_price_minor >= 0),

    -- Basis points, so 27% is 2700. Integers avoid the float problem in the
    -- multiplier as well as in the amount.
    tax_basis_points INT         NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 100000),
    tax_included     BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Archiving a category must not take its items off the till with it, so
    -- this is SET NULL rather than CASCADE.
    category_id      UUID        REFERENCES categories(id) ON DELETE SET NULL,
    colour           TEXT,
    track_stock      BOOLEAN     NOT NULL DEFAULT FALSE,
    duration_minutes INT         NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),

    -- active is the merchant's switch: stocked, but not currently sold.
    -- archived_at is permanent: gone from the till, still resolvable from
    -- every order that ever referenced it. Deleting would break those orders.
    active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at      TIMESTAMPTZ
);

-- A SKU is what a merchant types into a barcode field, so it has to be unique
-- among the items that are actually sellable. Archived rows keep theirs, which
-- is why the index is partial: reusing a retired SKU is legitimate.
CREATE UNIQUE INDEX items_tenant_sku
    ON items (tenant_id, upper(sku)) WHERE archived_at IS NULL;

-- Every read is tenant-scoped and nearly every one excludes archived rows.
CREATE INDEX items_tenant_live ON items (tenant_id, name) WHERE archived_at IS NULL;
CREATE INDEX items_category    ON items (category_id) WHERE archived_at IS NULL;

-- +goose Down
DROP TABLE items;
DROP TABLE categories;
