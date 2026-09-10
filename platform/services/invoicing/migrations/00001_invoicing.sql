-- +goose Up

-- The gapless counter.
--
-- A per-tenant, per-year row taken under a lock inside the transaction that
-- issues the document. Deliberately not a Postgres sequence: a sequence hands
-- out a number before the transaction commits, and a rolled-back transaction
-- leaves a hole. Hungarian rules treat a hole in invoice numbering as something
-- to explain to an auditor, so gaplessness is the constraint and the row lock
-- is the price of it.
--
-- The cost is real and worth stating: two sales issuing at the same moment
-- serialise here. That is the correct trade for a document that has legal
-- weight, and it is why nothing else in the platform allocates numbers this way.
CREATE TABLE number_counters (
    tenant_id UUID NOT NULL,
    year      INT  NOT NULL,
    next      BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, year)
);

-- An issued document. Immutable: no UPDATE of its content anywhere in the
-- store, and the service exposes no edit. The only mutable columns are the
-- pointer to a correction and the reporting status, neither of which is part of
-- what was issued.
CREATE TABLE documents (
    id            UUID PRIMARY KEY,
    tenant_id     UUID        NOT NULL,

    -- year-merchantcode-sequence, e.g. 2026-7QK3M9-110. One format in every
    -- market, which is a deliberate deviation from the architecture's "free to
    -- differ per market", recorded in backend-plan.md. It lives in this pod, so
    -- a market that rejects it changes one deployment.
    number        TEXT        NOT NULL,
    year          INT         NOT NULL,
    sequence      BIGINT      NOT NULL,
    kind          TEXT        NOT NULL,

    order_id      TEXT        NOT NULL DEFAULT '',
    customer_name TEXT        NOT NULL DEFAULT '',
    -- Free text. An address is not a structure this platform has an opinion
    -- about, and imposing one would be imposing a country's.
    customer_address TEXT     NOT NULL DEFAULT '',
    -- Whatever this market calls the number a business is registered under.
    -- Not named for one, because no country logic includes field names.
    customer_tax_id  TEXT     NOT NULL DEFAULT '',

    -- Integer minor units, and the currency of this deployment.
    net_minor     BIGINT      NOT NULL,
    tax_minor     BIGINT      NOT NULL,
    gross_minor   BIGINT      NOT NULL,
    currency      TEXT        NOT NULL,

    -- The artifact, stored rather than recomputed. A historic document has to
    -- re-render exactly as issued, and recomputing it from current prices and
    -- current tax rates answers a different question convincingly enough that
    -- nobody notices it is the wrong one.
    artifact      BYTEA       NOT NULL,
    artifact_type TEXT        NOT NULL DEFAULT 'text/plain; charset=utf-8',

    reporting_status    TEXT  NOT NULL DEFAULT 'not_required',
    reporting_reference TEXT  NOT NULL DEFAULT '',

    -- A credit note points at what it corrects; the original gains a pointer
    -- back. Both are set in one transaction.
    corrects_id     UUID REFERENCES documents(id),
    corrected_by_id UUID REFERENCES documents(id),

    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at        TIMESTAMPTZ,

    idempotency_key TEXT      NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX documents_number ON documents (tenant_id, number);
CREATE UNIQUE INDEX documents_idempotent ON documents (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';
-- A document can be corrected once. A second credit note against the same
-- invoice would credit the customer twice.
CREATE UNIQUE INDEX documents_one_correction ON documents (corrects_id)
    WHERE corrects_id IS NOT NULL;

CREATE INDEX documents_recent ON documents (tenant_id, issued_at DESC, id DESC);
CREATE INDEX documents_order ON documents (tenant_id, order_id) WHERE order_id <> '';

-- The lines, stored because a document is a record of what was sold at the
-- price it was sold at, and the catalog moves on.
CREATE TABLE document_lines (
    id               BIGSERIAL PRIMARY KEY,
    document_id      UUID    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    description      TEXT    NOT NULL,
    quantity         INT     NOT NULL,
    unit_price_minor BIGINT  NOT NULL,
    net_minor        BIGINT  NOT NULL,
    tax_minor        BIGINT  NOT NULL,
    gross_minor      BIGINT  NOT NULL,
    tax_basis_points INT     NOT NULL DEFAULT 0
);

CREATE INDEX document_lines_document ON document_lines (document_id);

-- What the tenant is on, and what we charge them for it.
--
-- One row per tenant. The tier and the module set live in Tenant; this is only
-- the money side, because a subscription that also decided what was switched on
-- would be a second entitlement record.
CREATE TABLE subscriptions (
    tenant_id            UUID PRIMARY KEY,
    tier                 TEXT        NOT NULL,
    status               TEXT        NOT NULL DEFAULT 'active',
    period               TEXT        NOT NULL DEFAULT 'monthly',
    amount_minor         BIGINT      NOT NULL DEFAULT 0,
    currency             TEXT        NOT NULL,

    current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    renews_at            TIMESTAMPTZ NOT NULL,
    -- Cancelled at the end of the paid period rather than immediately, which is
    -- what a merchant expects of something they have already paid for.
    cancels_at           TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The billing cycle's query, across tenants.
CREATE INDEX subscriptions_due ON subscriptions (renews_at) WHERE status <> 'cancelled';

-- +goose Down
DROP TABLE subscriptions;
DROP TABLE document_lines;
DROP TABLE documents;
DROP TABLE number_counters;
