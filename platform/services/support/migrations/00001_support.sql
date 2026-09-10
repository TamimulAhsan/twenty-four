-- +goose Up

-- A specialist looking, and for how long.
--
-- The row is the grant rather than a log written after the fact: it stops being
-- readable when the expiry passes, without anybody having to remember to end
-- it, and stopping it is a change to this row rather than a hope that a console
-- tab was closed.
CREATE TABLE access_requests (
    id              UUID PRIMARY KEY,
    tenant_id       UUID        NOT NULL,

    -- The specialist's own id on the admin plane. Never a shared account:
    -- "somebody at TwentyFour" is not an answer to who looked at my books.
    specialist_id   UUID        NOT NULL,
    specialist_name TEXT        NOT NULL DEFAULT '',

    -- Required, and it is most of what is left. Nobody approves this in
    -- advance, so the reason is what makes it reviewable afterwards.
    reason          TEXT        NOT NULL,
    scope           TEXT        NOT NULL DEFAULT 'read_only',
    state           TEXT        NOT NULL DEFAULT 'pending',

    decided_by      UUID,
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT        NOT NULL DEFAULT '',

    -- Set at approval. This is what makes a forgotten session a session that
    -- expires rather than one that runs until somebody notices.
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT access_requests_reason_present CHECK (btrim(reason) <> ''),
    -- A live grant without an expiry would be permanent access, which is the
    -- one thing this table exists to prevent. Enforced here rather than only in
    -- the service, because the constraint is the point.
    CONSTRAINT access_requests_approved_expires
        CHECK (state <> 'approved' OR expires_at IS NOT NULL)
);

CREATE INDEX access_requests_pending ON access_requests (tenant_id, created_at DESC);

-- A live look. One row per time a specialist actually opened the console, so
-- an approval used three times over an afternoon reads as three visits rather
-- than one.
CREATE TABLE sessions (
    id              UUID PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    request_id      UUID        NOT NULL REFERENCES access_requests(id),
    specialist_id   UUID        NOT NULL,
    scope           TEXT        NOT NULL,

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Copied from the grant rather than joined at check time. A session must
    -- not outlive its grant, and reading the answer from one row is what makes
    -- the check on every impersonated request cheap enough to always do.
    expires_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ
);

CREATE INDEX sessions_tenant ON sessions (tenant_id, started_at DESC);
CREATE INDEX sessions_live ON sessions (expires_at) WHERE ended_at IS NULL;

-- +goose Down
DROP TABLE sessions;
DROP TABLE access_requests;
