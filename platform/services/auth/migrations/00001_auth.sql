-- +goose Up
-- Auth owns identity only. tenant_id is a foreign key in spirit to the Tenant
-- service's business profile, but is not enforced here: services do not share
-- tables, and Auth must be able to mint the ID at signup before Tenant exists.
CREATE TABLE users (
    id             UUID PRIMARY KEY,
    tenant_id      UUID        NOT NULL,
    email          TEXT        NOT NULL,
    display_name   TEXT        NOT NULL DEFAULT '',
    password_hash  TEXT        NOT NULL,
    status         TEXT        NOT NULL CHECK (status IN ('invited','active','deactivated','locked')),
    plane          TEXT        NOT NULL CHECK (plane IN ('tenant','admin')),
    email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    totp_secret    TEXT,
    failed_attempts INT        NOT NULL DEFAULT 0,
    locked_until   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at  TIMESTAMPTZ
);

-- Email is unique per plane, not globally: the same person may hold a merchant
-- account and a staff account without one blocking the other.
CREATE UNIQUE INDEX users_email_plane ON users (lower(email), plane);
CREATE INDEX users_tenant ON users (tenant_id);

-- Sessions live in Postgres rather than only in the token, so revocation is
-- immediate. A token alone cannot be withdrawn before it expires.
CREATE TABLE sessions (
    id         UUID PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL,
    plane      TEXT        NOT NULL,
    issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    user_agent TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX sessions_user   ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON sessions (expires_at) WHERE revoked_at IS NULL;

-- One table for every single-use token: verification, invitation, reset.
-- Only the hash is stored, so a database leak does not hand over live tokens.
CREATE TABLE one_time_tokens (
    token_hash TEXT        PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('verify_email','invite','password_reset')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ott_user ON one_time_tokens (user_id, purpose);

-- +goose Down
DROP TABLE one_time_tokens;
DROP TABLE sessions;
DROP TABLE users;
