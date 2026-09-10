-- +goose Up
-- What is in object storage, and what it is for.
--
-- The bytes are not here and never pass through this service. This table is the
-- index: the store holds objects under opaque keys, and without these rows
-- nothing could say which of them is a business's logo and which is a supplier
-- invoice from two years ago.
CREATE TABLE objects (
    id           UUID PRIMARY KEY,
    tenant_id    UUID        NOT NULL,

    -- The full key in the bucket. Derived, never supplied: it carries the
    -- tenant prefix, and a caller that could choose it could choose another
    -- tenant's.
    storage_key  TEXT        NOT NULL UNIQUE,

    purpose      TEXT        NOT NULL,
    -- The name the person gave it. Kept for display and for the download
    -- filename, and deliberately not part of the key: two people uploading
    -- "logo.png" must not collide, and a filename is not a safe path component.
    filename     TEXT        NOT NULL,
    content_type TEXT        NOT NULL,
    size_bytes   BIGINT      NOT NULL,

    -- A row exists from the moment a URL is signed, before any bytes arrive.
    -- Until it is confirmed it is a reservation rather than a file, which is
    -- why listing hides it: a reservation nobody completed shown as a file is
    -- how a merchant concludes an upload worked when it did not.
    confirmed_at TIMESTAMPTZ,

    subject_type TEXT        NOT NULL DEFAULT '',
    subject_id   TEXT        NOT NULL DEFAULT '',

    uploaded_by  UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two ways this is read: everything for a purpose, and everything attached
-- to one thing.
CREATE INDEX objects_purpose ON objects (tenant_id, purpose, created_at DESC);
CREATE INDEX objects_subject ON objects (tenant_id, subject_type, subject_id);

-- The sweeper's query. Partial, so it stays the size of the abandoned
-- reservations rather than the size of everything ever uploaded.
CREATE INDEX objects_pending ON objects (created_at) WHERE confirmed_at IS NULL;

-- +goose Down
DROP TABLE objects;
