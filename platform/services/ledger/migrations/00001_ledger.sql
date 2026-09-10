-- +goose Up

-- The chart of accounts.
--
-- Codes are semantic and never numbers. A numbered chart is a market
-- convention, and this codebase has no country logic in it: the deployed
-- Hungarian ledger and the deployed Bangladeshi one run the same schema, and
-- whichever numbering an accountant needs is applied when the books are
-- exported, not when they are written.
CREATE TABLE accounts (
    tenant_id  UUID        NOT NULL,
    code       TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    -- asset, liability, equity, revenue, expense. Which side increases the
    -- account follows from this and is not stored: two places to say "assets
    -- increase on the debit side" is one place for them to disagree.
    kind       TEXT        NOT NULL,
    -- True for the accounts the platform posts to on its own. A tenant may add
    -- accounts and may not remove these, because a posting rule refers to them
    -- by code.
    builtin    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, code),

    CONSTRAINT accounts_kind_known CHECK (
        kind IN ('asset','liability','equity','revenue','expense'))
);

-- One journal entry. Immutable once written: no update, no delete, and the
-- service exposes neither. A correction is a new entry that reverses this one,
-- which is the same rule an issued invoice follows and for the same reason.
CREATE TABLE entries (
    id             UUID PRIMARY KEY,
    tenant_id      UUID        NOT NULL,

    kind           TEXT        NOT NULL,
    reference_type TEXT        NOT NULL DEFAULT '',
    reference_id   TEXT        NOT NULL DEFAULT '',
    -- The event that produced it, when it came from the bus. Null for a manual
    -- entry, which is the distinction an auditor asks about first, and the
    -- deduplication key: at-least-once delivery would otherwise book a sale
    -- twice on a consumer rebalance.
    event_id       UUID,

    memo           TEXT        NOT NULL DEFAULT '',
    currency       TEXT        NOT NULL,

    reverses_id    UUID REFERENCES entries(id),
    posted_by      UUID,

    -- When it happened, which is not when it was written: an event sits in an
    -- outbox and then in a topic before it gets here, and a sale belongs to the
    -- day it was rung up.
    occurred_at    TIMESTAMPTZ NOT NULL,
    posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    idempotency_key TEXT       NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX entries_one_per_event ON entries (tenant_id, event_id)
    WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX entries_idempotent ON entries (tenant_id, idempotency_key)
    WHERE idempotency_key <> '';
-- An entry can be reversed once. A second reversal of the same entry would put
-- the books further out rather than back.
CREATE UNIQUE INDEX entries_one_reversal ON entries (reverses_id)
    WHERE reverses_id IS NOT NULL;

CREATE INDEX entries_recent ON entries (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX entries_reference ON entries (tenant_id, reference_type, reference_id);

-- The lines. One signed column, not two: positive is a debit, negative is a
-- credit, and an entry balances when its lines sum to zero.
--
-- That is the whole reason for the choice. With separate debit and credit
-- columns the invariant is a comparison between two totals that can be written
-- independently, and therefore written wrong; as one column it is a sum, which
-- the store checks before it commits and a reader can check by eye.
CREATE TABLE lines (
    id           BIGSERIAL PRIMARY KEY,
    entry_id     UUID        NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tenant_id    UUID        NOT NULL,
    account_code TEXT        NOT NULL,
    -- Integer minor units. There is one currency per deployment, so the code
    -- lives on the entry rather than being repeated on every line.
    amount_minor BIGINT      NOT NULL,
    memo         TEXT        NOT NULL DEFAULT '',

    CONSTRAINT lines_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX lines_entry ON lines (entry_id);
-- The account ledger and the trial balance both read this way.
CREATE INDEX lines_account ON lines (tenant_id, account_code);

-- +goose Down
DROP TABLE lines;
DROP TABLE entries;
DROP TABLE accounts;
