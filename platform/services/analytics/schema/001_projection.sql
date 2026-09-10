-- The projection of the operational stores, as the CDC connectors deliver it.
--
-- Written here rather than in a Job because analytics is the only process that
-- reads these tables, and a schema owned by nobody is a schema nobody notices
-- has drifted from the connector feeding it.
--
-- Every table is ReplacingMergeTree keyed on the source primary key and
-- versioned by the WAL position, because CDC is at-least-once and an update is
-- delivered as a whole new row: without a version, a refund that rewrote an
-- order would sit alongside the row it replaced and be counted twice. __lsn
-- rises monotonically per source, which is exactly what a version needs to be.
--
-- The three __ columns are not nullable, and that is the point: Debezium sets
-- all three on every record, snapshot rows included, so a null arriving here
-- means the connector was reconfigured out from under this schema. Failing the
-- insert says so; a nullable column would swallow it and quietly stop
-- de-duplicating. __deleted is a string because that is what the SMT emits.
--
-- Deletes arrive as a row with __deleted set rather than as an absence, so
-- every query filters on it. Postgres deletes rows here in ordinary work: a
-- parked tab that is edited has its lines replaced, and lines that lingered
-- would double the revenue of every tab anybody corrected.

CREATE TABLE IF NOT EXISTS orders
(
    id              String,
    tenant_id       String,
    number          String,
    status          String,
    placed_at       DateTime64(6, 'UTC'),
    customer_id     Nullable(String),
    customer_name   String,
    discount_code   String,
    discount_minor  Int64,
    currency        String,
    gross_minor     Int64,
    net_minor       Int64,
    tax_minor       Int64,
    refunded_minor  Int64,
    staff_id        Nullable(String),
    note            String,
    table_id        Nullable(String),
    void_reason     String,
    idempotency_key String,
    created_at      DateTime64(6, 'UTC'),
    updated_at      DateTime64(6, 'UTC'),
    __deleted       String,
    __op            String,
    __lsn           Int64
)
ENGINE = ReplacingMergeTree(__lsn)
PARTITION BY toYYYYMM(placed_at)
ORDER BY (tenant_id, id);

CREATE TABLE IF NOT EXISTS order_lines
(
    id               String,
    order_id         String,
    tenant_id        String,
    item_id          String,
    name             String,
    quantity         Int32,
    unit_price_minor Int64,
    tax_basis_points Int32,
    tax_included     Bool,
    discount_minor   Int64,
    gross_minor      Int64,
    net_minor        Int64,
    tax_minor        Int64,
    `position`       Int32,
    refunded_at      Nullable(DateTime64(6, 'UTC')),
    __deleted        String,
    __op             String,
    __lsn            Int64
)
ENGINE = ReplacingMergeTree(__lsn)
ORDER BY (tenant_id, order_id, id);

CREATE TABLE IF NOT EXISTS tenders
(
    id             String,
    order_id       String,
    tenant_id      String,
    method         String,
    amount_minor   Int64,
    tendered_minor Nullable(Int64),
    change_minor   Nullable(Int64),
    payment_id     Nullable(String),
    reference      String,
    created_at     DateTime64(6, 'UTC'),
    __deleted      String,
    __op           String,
    __lsn          Int64
)
ENGINE = ReplacingMergeTree(__lsn)
ORDER BY (tenant_id, order_id, id);

-- Catalog is here for one reason: an order line records what was charged and
-- never what it cost, so margin can only be answered by joining to the item.
-- The join is on item_id and nothing else, and it is a left join everywhere:
-- an item archived after the sale still has to resolve, and one whose cost was
-- never recorded has no margin rather than a margin of a hundred percent.
CREATE TABLE IF NOT EXISTS catalog_items
(
    id               String,
    tenant_id        String,
    sku              String,
    name             String,
    description      String,
    kind             String,
    unit_price_minor Int64,
    currency         String,
    cost_price_minor Nullable(Int64),
    tax_basis_points Int32,
    tax_included     Bool,
    category_id      Nullable(String),
    colour           Nullable(String),
    track_stock      Bool,
    duration_minutes Int32,
    active           Bool,
    created_at       DateTime64(6, 'UTC'),
    updated_at       DateTime64(6, 'UTC'),
    archived_at      Nullable(DateTime64(6, 'UTC')),
    __deleted        String,
    __op             String,
    __lsn            Int64
)
ENGINE = ReplacingMergeTree(__lsn)
ORDER BY (tenant_id, id);

CREATE TABLE IF NOT EXISTS catalog_categories
(
    id          String,
    tenant_id   String,
    name        String,
    `position`  Int32,
    created_at  DateTime64(6, 'UTC'),
    archived_at Nullable(DateTime64(6, 'UTC')),
    __deleted   String,
    __op        String,
    __lsn       Int64
)
ENGINE = ReplacingMergeTree(__lsn)
ORDER BY (tenant_id, id);
