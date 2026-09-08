-- +goose Up
-- The merchant code: six Crockford base32 characters that identify a tenant on
-- every document it issues.
--
-- This table is a lodger. Tenant & Business Profile will own it, but that
-- service does not exist yet and the code needs a uniqueness constraint today.
-- Auth mints the tenant ID at signup, so Auth is the only service that knows a
-- tenant exists at the moment one is created.
--
-- Nothing outside Auth reads this table. Invoicing asks through GetMerchantCode,
-- which is the same call it will make once the rows have moved, so the move is
-- a migration and a change of address rather than a change to every caller.
CREATE TABLE merchant_codes (
    tenant_id   UUID        PRIMARY KEY,
    code        TEXT        NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when a tenant leaves. The row stays: documents issued under this code
    -- remain valid and are still referenced by tax authorities and accountants,
    -- so reusing it would make two businesses indistinguishable on paper.
    released_at TIMESTAMPTZ
);

-- The constraint that does the real work. Assignment is a random draw retried
-- on violation, because checking for a free code and then inserting it is a
-- race between two signups.
CREATE UNIQUE INDEX merchant_codes_code ON merchant_codes (code);

-- +goose Down
DROP TABLE merchant_codes;
