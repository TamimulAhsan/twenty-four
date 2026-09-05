/**
 * Revenue over time, and when it actually happens.
 */
import { eachDay, type Period } from './period'
import { marginOf, type AnalysedOrder } from './types'

export interface DayPoint {
  readonly date: string
  readonly grossMinor: number
  readonly netMinor: number
  readonly taxMinor: number
  readonly marginMinor: number | null
  readonly orders: number
  readonly customers: number
}

/** Every day in the period, including the ones with nothing. A gap in a line
 *  chart reads as missing data; a zero reads as a quiet Tuesday. */
export function revenueByDay(orders: readonly AnalysedOrder[], period: Period): DayPoint[] {
  const byDay = new Map<string, AnalysedOrder[]>()
  for (const order of orders) {
    const key = order.placedAt.slice(0, 10)
    const bucket = byDay.get(key) ?? []
    bucket.push(order)
    byDay.set(key, bucket)
  }

  return eachDay(period).map((date) => {
    const group = byDay.get(date) ?? []
    return {
      date,
      grossMinor: group.reduce((sum, order) => sum + order.grossMinor, 0),
      netMinor: group.reduce((sum, order) => sum + order.netMinor, 0),
      taxMinor: group.reduce((sum, order) => sum + order.taxMinor, 0),
      marginMinor: marginOf(group.flatMap((order) => order.lines)),
      orders: group.length,
      customers: new Set(group.map((order) => order.customerId).filter(Boolean)).size,
    }
  })
}

export interface HeatCell {
  /** 0 is Sunday, matching Date.getDay(). */
  readonly weekday: number
  readonly hour: number
  readonly orders: number
  readonly grossMinor: number
}

/**
 * When the business is busy.
 *
 * A weekday by hour grid, which is the shape that decides a rota. A revenue
 * line by day cannot answer "should anyone be here at four on a Tuesday".
 */
export function hourlyHeatmap(orders: readonly AnalysedOrder[]): HeatCell[] {
  const cells = new Map<string, { orders: number; gross: number }>()
  for (const order of orders) {
    const at = new Date(order.placedAt)
    const key = `${at.getDay()}:${at.getHours()}`
    const entry = cells.get(key) ?? { orders: 0, gross: 0 }
    entry.orders += 1
    entry.gross += order.grossMinor
    cells.set(key, entry)
  }

  const out: HeatCell[] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const entry = cells.get(`${weekday}:${hour}`)
      out.push({
        weekday,
        hour,
        orders: entry?.orders ?? 0,
        grossMinor: entry?.gross ?? 0,
      })
    }
  }
  return out
}

export interface FinancialSummary {
  readonly grossMinor: number
  readonly netMinor: number
  readonly taxMinor: number
  readonly costMinor: number | null
  readonly marginMinor: number | null
  readonly marginRate: number | null
  readonly discountMinor: number
  readonly refundedMinor: number
  readonly orders: number
  readonly customers: number
  readonly averageBasketMinor: number
  readonly averageLinesPerOrder: number
}

/**
 * The period's trading position.
 *
 * Gross is what customers paid, net is gross less tax, cost is what the goods
 * cost, and margin is what is left. Tax is never revenue: it was collected on
 * someone else's behalf and showing it inside a revenue figure overstates the
 * business by the whole VAT rate.
 */
export function financialSummary(orders: readonly AnalysedOrder[]): FinancialSummary {
  const trading = orders.filter((order) => order.status !== 'voided')
  const refunded = trading.filter(
    (order) => order.status === 'refunded' || order.status === 'partly_refunded',
  )

  const gross = trading.reduce((sum, order) => sum + order.grossMinor, 0)
  const net = trading.reduce((sum, order) => sum + order.netMinor, 0)
  const lines = trading.flatMap((order) => order.lines)
  const margin = marginOf(lines)
  const cost = margin === null ? null : net - margin

  return {
    grossMinor: gross,
    netMinor: net,
    taxMinor: trading.reduce((sum, order) => sum + order.taxMinor, 0),
    costMinor: cost,
    marginMinor: margin,
    marginRate: margin === null || net === 0 ? null : margin / net,
    discountMinor: trading.reduce((sum, order) => sum + order.discountMinor, 0),
    refundedMinor: refunded.reduce((sum, order) => sum + order.grossMinor, 0),
    orders: trading.length,
    customers: new Set(trading.map((order) => order.customerId).filter(Boolean)).size,
    averageBasketMinor: trading.length === 0 ? 0 : Math.round(gross / trading.length),
    averageLinesPerOrder:
      trading.length === 0 ? 0 : lines.length / trading.length,
  }
}

/** Revenue split by a dimension, largest first, with everything past `limit`
 *  folded into one row rather than a long tail nobody reads. */
export function revenueBy<T extends string>(
  orders: readonly AnalysedOrder[],
  pick: (order: AnalysedOrder) => T,
  options: { limit?: number; otherLabel?: string } = {},
): Array<{ key: string; grossMinor: number; orders: number; share: number }> {
  const groups = new Map<string, { gross: number; orders: number }>()
  for (const order of orders) {
    const key = pick(order)
    const entry = groups.get(key) ?? { gross: 0, orders: 0 }
    entry.gross += order.grossMinor
    entry.orders += 1
    groups.set(key, entry)
  }

  const total = [...groups.values()].reduce((sum, entry) => sum + entry.gross, 0)
  const rows = [...groups.entries()]
    .map(([key, entry]) => ({
      key,
      grossMinor: entry.gross,
      orders: entry.orders,
      share: total === 0 ? 0 : entry.gross / total,
    }))
    .sort((a, b) => b.grossMinor - a.grossMinor)

  const limit = options.limit
  if (!limit || rows.length <= limit) return rows

  const kept = rows.slice(0, limit)
  const rest = rows.slice(limit)
  kept.push({
    key: options.otherLabel ?? 'Other',
    grossMinor: rest.reduce((sum, row) => sum + row.grossMinor, 0),
    orders: rest.reduce((sum, row) => sum + row.orders, 0),
    share: rest.reduce((sum, row) => sum + row.share, 0),
  })
  return kept
}
