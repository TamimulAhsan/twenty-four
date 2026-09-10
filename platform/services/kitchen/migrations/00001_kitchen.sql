-- +goose Up

-- Where work goes: a grill, a fryer, a bar, a pass.
CREATE TABLE stations (
    id         UUID PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    name       TEXT        NOT NULL,
    -- The pass sees every ticket rather than only the lines routed to it,
    -- because that is the job: knowing when a table's whole order is ready.
    is_pass    BOOLEAN     NOT NULL DEFAULT FALSE,
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stations_tenant ON stations (tenant_id) WHERE active;

-- Which station makes which catalog item.
--
-- A separate table rather than a column on the item, because the routing is the
-- kitchen's opinion and the item is the catalog's. A restaurant that moves
-- desserts from the pastry section to the bar has not changed its menu.
CREATE TABLE item_routes (
    tenant_id  UUID NOT NULL,
    item_id    UUID NOT NULL,
    station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, item_id)
);

-- One sale, as the kitchen sees it.
CREATE TABLE tickets (
    id           UUID PRIMARY KEY,
    tenant_id    UUID        NOT NULL,
    order_id     UUID        NOT NULL,
    -- What the till calls the sale, so a cook and a server say the same number.
    order_number TEXT        NOT NULL DEFAULT '',
    table_label  TEXT        NOT NULL DEFAULT '',
    state        TEXT        NOT NULL DEFAULT 'waiting',
    note         TEXT        NOT NULL DEFAULT '',

    -- When the order was placed, not when this row was written. The screen
    -- sorts and colours by how long a table has been waiting, and that clock
    -- starts at the till, not at whenever the event was consumed.
    placed_at    TIMESTAMPTZ NOT NULL,
    passed_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One ticket per order. The order event is the key, so a redelivery does not
-- print a second ticket and cook the meal twice.
CREATE UNIQUE INDEX tickets_order ON tickets (tenant_id, order_id);
-- The screen's query: what is on now, oldest first.
CREATE INDEX tickets_live ON tickets (tenant_id, placed_at)
    WHERE state IN ('waiting', 'cooking', 'ready');

CREATE TABLE ticket_lines (
    id          UUID PRIMARY KEY,
    tenant_id   UUID        NOT NULL,
    ticket_id   UUID        NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

    item_id     UUID        NOT NULL,
    -- Copied at the time. A ticket printed for a margherita is still a
    -- margherita when somebody renames the item.
    name        TEXT        NOT NULL,
    quantity    INT         NOT NULL,
    note        TEXT        NOT NULL DEFAULT '',

    station_id  UUID REFERENCES stations(id),
    state       TEXT        NOT NULL DEFAULT 'waiting',
    -- Who is cooking it. This is the entire reason claiming exists: two cooks
    -- must not both start the same dish.
    claimed_by  UUID,
    claimed_at  TIMESTAMPTZ,
    done_at     TIMESTAMPTZ,
    void_reason TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX ticket_lines_ticket ON ticket_lines (ticket_id);
CREATE INDEX ticket_lines_station ON ticket_lines (tenant_id, station_id)
    WHERE state IN ('waiting', 'claimed');

-- +goose Down
DROP TABLE ticket_lines;
DROP TABLE tickets;
DROP TABLE item_routes;
DROP TABLE stations;
