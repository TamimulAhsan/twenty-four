-- +goose Up
-- What a business is.
--
-- The row exists from the moment Auth mints the tenant ID at signup. Auth still
-- holds the merchant code, and this service asks for it through an RPC rather
-- than reading it, so the day that column moves here nothing else changes.
CREATE TABLE tenants (
    id                 UUID PRIMARY KEY,
    business_name      TEXT        NOT NULL,

    -- One input decides everything trade-specific: capabilities, vocabulary,
    -- catalog template, document and tax categories.
    industry           TEXT        NOT NULL,
    -- Which vocabulary the trade speaks. Denormalised from the profile so a
    -- rename of a trade cannot silently re-word a live tenant's screens.
    term_family        TEXT        NOT NULL DEFAULT '',

    tier               TEXT        NOT NULL,
    locale             TEXT        NOT NULL DEFAULT 'hu-HU',
    -- One environment is one market, so one currency. It is stored per tenant
    -- anyway, because an amount without its currency is meaningless and every
    -- row that carries money should be able to say what it is in.
    currency           TEXT        NOT NULL CHECK (char_length(currency) = 3),
    timezone           TEXT        NOT NULL DEFAULT 'Europe/Budapest',
    prices_include_tax BOOLEAN     NOT NULL DEFAULT TRUE,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_tax_rates (
    tenant_id    UUID    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id           TEXT    NOT NULL,
    label        TEXT    NOT NULL,
    basis_points INT     NOT NULL CHECK (basis_points BETWEEN 0 AND 100000),
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,
    position     INT     NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE tenant_hours (
    tenant_id UUID    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- 0 is Sunday, matching what the dashboard renders.
    day       INT     NOT NULL CHECK (day BETWEEN 0 AND 6),
    opens_at  TEXT,
    closes_at TEXT,
    closed    BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (tenant_id, day)
);

-- The entitlement record. One row per module a tenant holds.
--
--   entitlement = tier module set  union  industry profile capabilities
--                                  union  manual overrides
--
-- The gateway checks the resulting set and neither knows nor cares which source
-- put an entry in it, which is exactly what stops a trade capability needing
-- its own enforcement path. `source` exists so a specialist can see why
-- something is held, and so re-resolving a tier does not wipe an override.
CREATE TABLE entitlements (
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    module_id  TEXT        NOT NULL,
    source     TEXT        NOT NULL CHECK (source IN ('tier','profile','override')),
    -- Granted but not yet usable, because provisioning needs a person: KYC
    -- approval, OAuth consent, hardware pairing. The merchant is told.
    pending    BOOLEAN     NOT NULL DEFAULT FALSE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, module_id)
);

CREATE INDEX entitlements_tenant ON entitlements (tenant_id);

-- Seats are a quota, not a module. The limit lives beside the module set and is
-- unrelated to the Staff and Rota module, which is shifts and availability.
CREATE TABLE entitlement_quotas (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Zero means unlimited, which is what Enterprise negotiates.
    seat_limit INT  NOT NULL DEFAULT 0
);

-- +goose Down
DROP TABLE entitlement_quotas;
DROP TABLE entitlements;
DROP TABLE tenant_hours;
DROP TABLE tenant_tax_rates;
DROP TABLE tenants;
