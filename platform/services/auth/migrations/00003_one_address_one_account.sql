-- +goose Up
-- One address, one account.
--
-- Email used to be unique per plane, on the reasoning that the same person
-- might hold a merchant account and a staff account without one blocking the
-- other. That reasoning was reversed once both planes started behind a single
-- sign-in form: if an address can name two accounts, "where does this person
-- go after they type their password" has no answer, and the alternatives are a
-- "which one did you mean" step after the password or a silent preference for
-- one plane. Both are worse than telling a specialist who also runs a shop to
-- use a second address.
--
-- This index is what makes the resolution in Login honest rather than a
-- best guess.
DROP INDEX users_email_plane;
CREATE UNIQUE INDEX users_email ON users (lower(email));

-- The handoff code.
--
-- The sign-in form is served from the merchant origin, so it cannot set a
-- cookie for the admin host. Something has to cross, and it must not be the
-- token: a token in a URL is in browser history, in Referer, and in the access
-- log of every proxy on the path.
--
-- So a one-time code crosses instead, and the admin gateway swaps it for a
-- token server-side. It rides the existing one_time_tokens table because that
-- table already has the one property this needs: consuming it is a single
-- atomic statement, which is what stops a code working twice.
ALTER TABLE one_time_tokens DROP CONSTRAINT one_time_tokens_purpose_check;
ALTER TABLE one_time_tokens ADD CONSTRAINT one_time_tokens_purpose_check
    CHECK (purpose IN ('verify_email','invite','password_reset','plane_handoff'));

-- The session the code stands for. Redeeming issues a fresh token against this
-- session rather than storing one: a bearer token at rest is a bearer token
-- somebody can read out of a backup.
ALTER TABLE one_time_tokens ADD COLUMN session_id UUID REFERENCES sessions(id) ON DELETE CASCADE;

-- Where the code was issued. Redeeming from somewhere else means the code
-- travelled, and a code that travelled is a code that was intercepted.
ALTER TABLE one_time_tokens ADD COLUMN issued_ip TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE one_time_tokens DROP COLUMN issued_ip;
ALTER TABLE one_time_tokens DROP COLUMN session_id;
ALTER TABLE one_time_tokens DROP CONSTRAINT one_time_tokens_purpose_check;
ALTER TABLE one_time_tokens ADD CONSTRAINT one_time_tokens_purpose_check
    CHECK (purpose IN ('verify_email','invite','password_reset'));
DROP INDEX users_email;
CREATE UNIQUE INDEX users_email_plane ON users (lower(email), plane);
