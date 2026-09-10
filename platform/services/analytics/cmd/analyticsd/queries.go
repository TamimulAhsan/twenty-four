package main

// The SQL.
//
// Held here as constants rather than assembled from fragments, because a query
// that is built up in three places is a query nobody can read in one. The only
// thing interpolated anywhere is a column name chosen from a fixed set, never a
// value: values are bound by ClickHouse itself.
//
// Two settings apply to every query and are on every one of them:
//
//	final = 1          CDC delivers an update as a whole new row, so without
//	                   this a refunded order is counted twice, once as it was
//	                   and once as it became.
//	join_use_nulls = 1 A left join that matched nothing must yield null, not a
//	                   zero. An item whose cost was never recorded and an item
//	                   costing nothing are different facts, and the second one
//	                   is a margin figure a merchant would act on.
//
// Every query filters __deleted, because a delete arrives as a row saying so
// rather than as an absence. Postgres deletes rows here in ordinary work: a
// parked tab that is edited has its lines replaced.

// The sales in a period, excluding voided ones. A void is the record of a sale
// that did not happen; counting it and then removing it corrects twice.
const tradingCTE = `
WITH trading AS (
    SELECT id,
           placed_at,
           toDate(placed_at, {tz:String}) AS day,
           gross_minor, net_minor, tax_minor, discount_minor, refunded_minor,
           customer_id
    FROM orders
    WHERE tenant_id = {tenant:String}
      AND __deleted = 'false'
      AND status != 'voided'
      AND toDate(placed_at, {tz:String}) BETWEEN {from:Date} AND {to:Date}
)`

const settings = "\nSETTINGS final = 1, join_use_nulls = 1"

// Totals for a period.
//
// Cost is a left join to the catalog rather than a figure on the line, because
// a line records what was charged and never what it cost. uncosted is what
// makes the margin honest: one line without a recorded cost makes the period's
// margin unknown, not smaller.
const summarySQL = tradingCTE + `,
costed AS (
    SELECT l.net_minor AS line_net,
           l.quantity * i.cost_price_minor AS line_cost
    FROM order_lines AS l
    INNER JOIN trading AS o ON o.id = l.order_id
    LEFT JOIN catalog_items AS i
           ON i.tenant_id = l.tenant_id AND i.id = l.item_id
    WHERE l.tenant_id = {tenant:String} AND l.__deleted = 'false'
)
SELECT
    (SELECT sum(gross_minor) FROM trading)    AS gross_minor,
    (SELECT sum(net_minor) FROM trading)      AS net_minor,
    (SELECT sum(tax_minor) FROM trading)      AS tax_minor,
    (SELECT sum(discount_minor) FROM trading) AS discount_minor,
    (SELECT sum(refunded_minor) FROM trading) AS refunded_minor,
    (SELECT count() FROM trading)             AS orders,
    (SELECT uniqExactIf(customer_id, customer_id IS NOT NULL) FROM trading) AS customers,
    (SELECT count() FROM costed)              AS lines,
    (SELECT countIf(line_cost IS NULL) FROM costed) AS uncosted,
    (SELECT sum(line_cost) FROM costed)       AS cost_minor` + settings

// One row per day, including the days nobody traded. WITH FILL is what puts
// those days in: a line chart with a gap in it reads as data that is missing
// rather than a Sunday.
const seriesSQL = tradingCTE + `,
costed AS (
    SELECT o.day AS day,
           l.quantity * i.cost_price_minor AS line_cost
    FROM order_lines AS l
    INNER JOIN trading AS o ON o.id = l.order_id
    LEFT JOIN catalog_items AS i
           ON i.tenant_id = l.tenant_id AND i.id = l.item_id
    WHERE l.tenant_id = {tenant:String} AND l.__deleted = 'false'
),
sales AS (
    SELECT day,
           sum(gross_minor) AS gross_minor,
           sum(net_minor)   AS net_minor,
           sum(tax_minor)   AS tax_minor,
           count()          AS orders,
           uniqExactIf(customer_id, customer_id IS NOT NULL) AS customers
    FROM trading GROUP BY day
),
costs AS (
    SELECT day,
           sum(line_cost) AS cost_minor,
           countIf(line_cost IS NULL) AS uncosted,
           count() AS lines
    FROM costed GROUP BY day
)
SELECT s.day AS day, s.gross_minor, s.net_minor, s.tax_minor, s.orders, s.customers,
       c.cost_minor AS cost_minor, c.uncosted AS uncosted, c.lines AS lines
FROM sales AS s LEFT JOIN costs AS c ON c.day = s.day
ORDER BY day WITH FILL FROM {from:Date} TO {to:Date} + 1 STEP 1` + settings

// Revenue by how it was paid for, read from the tenders rather than from the
// order. A sale settled half in cash and half on a card is half of each: giving
// the whole sale to the first tender is how a drawer stops reconciling.
const methodSQL = tradingCTE + `
SELECT t.method             AS key,
       t.method             AS label,
       sum(t.amount_minor)  AS gross_minor,
       uniqExact(t.order_id) AS orders
FROM tenders AS t
INNER JOIN trading AS o ON o.id = t.order_id
WHERE t.tenant_id = {tenant:String} AND t.__deleted = 'false'
GROUP BY key, label
ORDER BY gross_minor DESC` + settings

// Revenue by category, through the item. Items in no category group together
// under an empty key, which is a real group and not a missing value; what that
// group is called on screen is not decided here.
const categorySQL = tradingCTE + `
SELECT ifNull(i.category_id, '') AS key,
       ifNull(c.name, '')        AS label,
       sum(l.gross_minor)        AS gross_minor,
       uniqExact(l.order_id)     AS orders
FROM order_lines AS l
INNER JOIN trading AS o ON o.id = l.order_id
LEFT JOIN catalog_items AS i
       ON i.tenant_id = l.tenant_id AND i.id = l.item_id
LEFT JOIN catalog_categories AS c
       ON c.tenant_id = l.tenant_id AND c.id = i.category_id
WHERE l.tenant_id = {tenant:String} AND l.__deleted = 'false'
GROUP BY key, label
ORDER BY gross_minor DESC` + settings

// Revenue by item. The label prefers the catalog's current name and falls back
// to the name the line was rung up under, so an item renamed last week appears
// once under what it is called now, and one deleted from the catalog still
// appears under what it was called then.
const itemSQL = tradingCTE + `
SELECT l.item_id                         AS key,
       anyLast(ifNull(i.name, l.name))   AS label,
       sum(l.gross_minor)                AS gross_minor,
       uniqExact(l.order_id)             AS orders
FROM order_lines AS l
INNER JOIN trading AS o ON o.id = l.order_id
LEFT JOIN catalog_items AS i
       ON i.tenant_id = l.tenant_id AND i.id = l.item_id
WHERE l.tenant_id = {tenant:String} AND l.__deleted = 'false'
GROUP BY key
ORDER BY gross_minor DESC` + settings

// Trade by weekday and hour, in the merchant's own zone. Mode 0 puts Monday at
// 1 and Sunday at 7, which is what the contract promises.
const heatmapSQL = tradingCTE + `
SELECT toDayOfWeek(placed_at, 0, {tz:String}) AS weekday,
       toHour(toTimeZone(placed_at, {tz:String})) AS hour,
       count()          AS orders,
       sum(gross_minor) AS gross_minor
FROM trading
GROUP BY weekday, hour` + settings

// The high-water mark: the newest change this tenant has in the projection.
// Not filtered by period, because it describes the projection rather than the
// answer, and not filtered by status, because a void is a change too.
const freshnessSQL = `
SELECT max(updated_at) AS through
FROM orders
WHERE tenant_id = {tenant:String} AND __deleted = 'false'` + settings
