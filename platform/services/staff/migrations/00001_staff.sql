-- +goose Up
-- The employment view of a person.
--
-- The login is Auth's, the role is RBAC's, and this row is what Staff adds:
-- the things that are true about someone as an employee rather than as an
-- account. user_id IS the Auth user ID, deliberately. One person, one
-- identifier, everywhere, which is what makes "one seat is one person across
-- both surfaces" a statement about a number rather than about a join.
CREATE TABLE members (
    tenant_id  UUID        NOT NULL,
    user_id    UUID        NOT NULL,

    -- Their colour on the till and, later, the rota. Assigned at invitation
    -- from a fixed palette so two people on the same shift are never the same
    -- colour by accident.
    colour     TEXT        NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

-- +goose Down
DROP TABLE members;
