-- +goose Up
-- Roles: system roles have tenant_id NULL and are shared by every tenant.
CREATE TABLE roles (
    id          UUID PRIMARY KEY,
    tenant_id   UUID,
    key         TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    plane       TEXT        NOT NULL CHECK (plane IN ('tenant','admin')),
    is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A tenant may define "manager" only if no system role already owns that key.
CREATE UNIQUE INDEX roles_system_key   ON roles (key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX roles_tenant_key   ON roles (tenant_id, key) WHERE tenant_id IS NOT NULL;

CREATE TABLE role_permissions (
    role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
);

-- Which subject holds which role, in which tenant.
CREATE TABLE role_bindings (
    id         UUID PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    subject_id UUID        NOT NULL,
    role_key   TEXT        NOT NULL,
    actor_id   UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subject_id, role_key)
);

CREATE INDEX role_bindings_subject ON role_bindings (tenant_id, subject_id);

-- +goose Down
DROP TABLE role_bindings;
DROP TABLE role_permissions;
DROP TABLE roles;
