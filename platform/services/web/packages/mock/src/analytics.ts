/**
 * The reporting answers, computed from the mock's own orders.
 *
 * The real service reads a ClickHouse projection fed by change capture. This
 * cannot, so it aggregates the same orders the rest of the mock serves. The
 * point is not to reproduce how the figures are produced but what the wire
 * shape is, so the dashboard can be built and looked at without a cluster.
 *
 * Two things it does reproduce exactly, because they are contract rather than
 * implementation: cost and margin are absent, not zero, when any line has no
 * recorded cost; and every answer carries how fresh it is.
 */
import type { CatalogItem, Order } from '@twentyfour/api'
import type { TenantStore } from './store'

interface Period {
  from: string
  to: string
  tz: string
}

const money = (minor: number, currency: string) => ({ minor: String(minor), currency })

/** The day a sale belongs to, in the merchant's zone rather than in UTC. */
function localDay(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

function localParts(iso: string, tz: string): { weekday: number; hour: number } {
  const at = new Date(iso)
  let hour = at.getHours()
  let weekday = at.getDay()
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(at)
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    hour = Number(parts.find((part) => part.type === 'hour')?.value ?? hour)
    const name = parts.find((part) => part.type === 'weekday')?.value ?? ''
    const index = names.indexOf(name)
    if (index >= 0) weekday = index
  } catch {
    // The fallback is the browser's own zone, which is what it was before a
    // zone travelled with the request at all.
  }
  // ISO: Monday is 1 and Sunday is 7, the way the contract states it.
  return { weekday: weekday === 0 ? 7 : weekday, hour }
}

/** Sales in the window, voided ones excluded: a void is the record of a sale
 *  that did not happen. */
function trading(store: TenantStore, period: Period): Order[] {
  return store
    .listOrders({})
    .filter((order) => order.status !== 'voided')
    .filter((order) => {
      const day = localDay(order.placedAt, period.tz)
      return day >= period.from && day <= period.to
    })
}

function items(store: TenantStore): Map<string, CatalogItem> {
  return new Map(store.listItems({ includeInactive: true }).map((item) => [item.id, item]))
}

interface Costed {
  cost: number | null
  lines: number
}

function costOf(store: TenantStore, orders: readonly Order[]): Costed {
  const catalog = items(store)
  let cost = 0
  let lines = 0
  let known = true
  for (const order of orders) {
    for (const line of order.lines) {
      lines += 1
      const unit = catalog.get(line.itemId)?.costPrice?.minor
      if (unit === undefined || unit === null) known = false
      else cost += unit * line.quantity
    }
  }
  return { cost: known ? cost : null, lines }
}

function totals(store: TenantStore, orders: readonly Order[], currency: string) {
  const sum = (pick: (order: Order) => number) => orders.reduce((n, o) => n + pick(o), 0)
  const gross = sum((o) => o.gross.minor)
  const net = sum((o) => o.net.minor)
  const { cost, lines } = costOf(store, orders)
  return {
    gross: money(gross, currency),
    net: money(net, currency),
    tax: money(sum((o) => o.tax.minor), currency),
    discount: money(sum((o) => o.discount?.minor ?? 0), currency),
    refunded: money(sum((o) => o.refunded?.minor ?? 0), currency),
    cost: cost === null ? null : money(cost, currency),
    margin: cost === null ? null : money(net - cost, currency),
    orders: orders.length,
    customers: new Set(orders.map((o) => o.customerId).filter(Boolean)).size,
    averageBasket: money(orders.length === 0 ? 0 : Math.round(gross / orders.length), currency),
    averageLinesPerOrderMilli:
      orders.length === 0 ? 0 : Math.round((lines * 1000) / orders.length),
  }
}

function freshness(orders: readonly Order[]) {
  if (orders.length === 0) return null
  const newest = orders.reduce((a, b) => (a.placedAt > b.placedAt ? a : b))
  return { through: newest.placedAt }
}

function currencyOf(store: TenantStore): string {
  return store.listOrders({})[0]?.gross.currency ?? 'HUF'
}

function shift(period: Period): Period {
  const from = Date.parse(`${period.from}T00:00:00Z`)
  const to = Date.parse(`${period.to}T00:00:00Z`)
  const days = Math.round((to - from) / 86_400_000) + 1
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return { from: iso(from - days * 86_400_000), to: iso(from - 86_400_000), tz: period.tz }
}

export function summary(store: TenantStore, period: Period) {
  const currency = currencyOf(store)
  const before = shift(period)
  const all = store.listOrders({})
  return {
    current: totals(store, trading(store, period), currency),
    previous: totals(store, trading(store, before), currency),
    previousPeriod: { from: before.from, to: before.to },
    freshness: freshness(all),
  }
}

export function series(store: TenantStore, period: Period) {
  const currency = currencyOf(store)
  const orders = trading(store, period)
  const byDay = new Map<string, Order[]>()
  for (const order of orders) {
    const day = localDay(order.placedAt, period.tz)
    byDay.set(day, [...(byDay.get(day) ?? []), order])
  }

  const points = []
  for (let at = Date.parse(`${period.from}T00:00:00Z`); at <= Date.parse(`${period.to}T00:00:00Z`); at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10)
    const group = byDay.get(date) ?? []
    const { cost } = costOf(store, group)
    const net = group.reduce((n, o) => n + o.net.minor, 0)
    points.push({
      date,
      gross: money(group.reduce((n, o) => n + o.gross.minor, 0), currency),
      net: money(net, currency),
      tax: money(group.reduce((n, o) => n + o.tax.minor, 0), currency),
      margin: cost === null ? null : money(net - cost, currency),
      orders: group.length,
      customers: new Set(group.map((o) => o.customerId).filter(Boolean)).size,
    })
  }
  return { points, freshness: freshness(store.listOrders({})) }
}

export function breakdown(store: TenantStore, period: Period, by: string, limit: number) {
  const currency = currencyOf(store)
  const orders = trading(store, period)
  const catalog = items(store)
  const categories = new Map(store.categories.map((category) => [category.id, category.name] as const))

  const groups = new Map<string, { label: string; gross: number; orders: Set<string> }>()
  const add = (key: string, label: string, gross: number, orderId: string) => {
    const entry = groups.get(key) ?? { label, gross: 0, orders: new Set<string>() }
    entry.gross += gross
    entry.orders.add(orderId)
    groups.set(key, entry)
  }

  for (const order of orders) {
    if (by === 'method') {
      // Split across the tenders, so a sale settled half in cash and half on a
      // card counts in both for what each actually took.
      for (const tender of order.tenders) add(tender.method, tender.method, tender.amount.minor, order.id)
      continue
    }
    for (const line of order.lines) {
      if (by === 'item') {
        add(line.itemId, catalog.get(line.itemId)?.name ?? line.name, line.gross.minor, order.id)
      } else {
        const categoryId = catalog.get(line.itemId)?.categoryId ?? ''
        add(categoryId, categoryId ? (categories.get(categoryId) ?? '') : '', line.gross.minor, order.id)
      }
    }
  }

  const ranked = [...groups.entries()]
    .map(([key, entry]) => ({ key, label: entry.label, gross: entry.gross, orders: entry.orders.size }))
    .sort((a, b) => b.gross - a.gross)
  const total = ranked.reduce((n, row) => n + row.gross, 0)
  const share = (gross: number) => (total === 0 ? 0 : Math.floor((gross * 10000) / total))
  const wire = (row: (typeof ranked)[number] | { key: string; label: string; gross: number; orders: number }) => ({
    key: row.key,
    label: row.label,
    gross: money(row.gross, currency),
    shareBasisPoints: share(row.gross),
    orders: row.orders,
  })

  const kept = limit > 0 ? ranked.slice(0, limit) : ranked
  const rest = limit > 0 ? ranked.slice(limit) : []
  return {
    slices: kept.map(wire),
    other:
      rest.length === 0
        ? null
        : wire({
            key: '',
            label: '',
            gross: rest.reduce((n, row) => n + row.gross, 0),
            orders: rest.reduce((n, row) => n + row.orders, 0),
          }),
    freshness: freshness(store.listOrders({})),
  }
}

export function heatmap(store: TenantStore, period: Period) {
  const currency = currencyOf(store)
  const found = new Map<number, { orders: number; gross: number }>()
  for (const order of trading(store, period)) {
    const { weekday, hour } = localParts(order.placedAt, period.tz)
    const key = weekday * 24 + hour
    const entry = found.get(key) ?? { orders: 0, gross: 0 }
    entry.orders += 1
    entry.gross += order.gross.minor
    found.set(key, entry)
  }

  const cells = []
  for (let weekday = 1; weekday <= 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const entry = found.get(weekday * 24 + hour)
      cells.push({
        weekday, hour,
        orders: entry?.orders ?? 0,
        gross: money(entry?.gross ?? 0, currency),
      })
    }
  }
  return { cells, freshness: freshness(store.listOrders({})) }
}
