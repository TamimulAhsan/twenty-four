-- +goose Up
-- One provisioning run per tenant.
--
-- The 24-hour promise is measured here: live within a day, or the first month
-- is free. That makes the SLA a row with a deadline on it rather than a report
-- somebody runs, which is the difference between a guarantee and a slogan.
CREATE TABLE runs (
    tenant_id     UUID PRIMARY KEY,
    owner_user_id UUID,
    business_name TEXT        NOT NULL,
    industry      TEXT        NOT NULL,
    tier          TEXT        NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at        TIMESTAMPTZ NOT NULL,
    -- Set when every platform-owned step has finished. Steps owned by a
    -- specialist or by the merchant do not hold this open: the platform's part
    -- of the promise is what the platform can be held to.
    completed_at  TIMESTAMPTZ
);

CREATE INDEX runs_open ON runs (due_at) WHERE completed_at IS NULL;

-- The steps. These are both the saga's state and the merchant's checklist, on
-- purpose: two lists of the same work disagree the first time one is wrong, and
-- the one the merchant is reading is the one nobody notices is stale.
CREATE TABLE steps (
    tenant_id    UUID        NOT NULL REFERENCES runs(tenant_id) ON DELETE CASCADE,
    step_id      TEXT        NOT NULL,
    title        TEXT        NOT NULL,
    description  TEXT        NOT NULL DEFAULT '',
    -- Which of the 0 / 4 / 12 / 24 hour stages this belongs to.
    hour         INT         NOT NULL CHECK (hour IN (0,4,12,24)),
    status       TEXT        NOT NULL CHECK (status IN
        ('pending','in_progress','done','failed','awaiting_specialist')),
    -- Who it is waiting on. Orthogonal to status: a merchant-owned step is
    -- pending or done like any other, and the difference is that nobody else is
    -- going to finish it. Without this the checklist cannot answer the only
    -- question the merchant has, which is which of these are theirs.
    owner        TEXT        NOT NULL CHECK (owner IN ('platform','specialist','merchant')),
    position     INT         NOT NULL DEFAULT 0,
    attempts     INT         NOT NULL DEFAULT 0,
    -- Shown to a specialist, never to a merchant: it is the reason a machine
    -- gave, not a sentence anyone wants on their first morning.
    last_error   TEXT        NOT NULL DEFAULT '',
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX steps_key ON steps (tenant_id, step_id);
CREATE INDEX steps_run ON steps (tenant_id, position);

-- +goose Down
DROP TABLE steps;
DROP TABLE runs;
