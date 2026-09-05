/**
 * Who your customers are, and what to do about each group.
 *
 * RFM, because it is the segmentation a small business can act on the same
 * afternoon: how recently someone came, how often they come, and how much they
 * spend. Every segment carries the action it implies, since a segment nobody
 * knows what to do with is a label, not an insight.
 */
import type { AnalysedOrder } from './types'

export type Segment =
  | 'champion'
  | 'loyal'
  | 'promising'
  | 'new'
  | 'occasional'
  | 'needs_attention'
  | 'at_risk'
  | 'cannot_lose'
  | 'lost'

export interface CustomerMetrics {
  readonly customerId: string
  /** Days since their last order. */
  readonly recencyDays: number
  readonly orderCount: number
  readonly lifetimeMinor: number
  readonly averageBasketMinor: number
  readonly firstOrderAt: string
  readonly lastOrderAt: string
  /** Mean days between visits. null for a customer with one order. */
  readonly cadenceDays: number | null
  /** Recency, frequency and monetary scores, 1 (worst) to 5 (best). */
  readonly r: number
  readonly f: number
  readonly m: number
  readonly segment: Segment
  /**
   * How overdue their next visit is, as a multiple of their own cadence.
   * 1 means they are exactly due. Above 2 they have broken their pattern.
   * null when there is no pattern yet to break.
   */
  readonly overdueRatio: number | null
  readonly favouriteItems: ReadonlyArray<{ itemId: string; name: string; units: number }>
}

/**
 * Quintile score.
 *
 * Scored against this business's own customers rather than an absolute
 * threshold: spending 40,000 Ft a month makes you a whale in a cafe and a
 * casual in a jeweller.
 */
function quintileScores(values: readonly number[], ascendingIsBetter: boolean): Map<number, number> {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const out = new Map<number, number>()
  if (n === 0) return out
  if (n === 1) {
    out.set(sorted[0] as number, 3)
    return out
  }

  // Ranked by position rather than against value cuts. Cuts cannot award a 5
  // on a small sample, because nothing is greater than the maximum, and a
  // business with four customers still has a best one.
  for (const value of new Set(sorted)) {
    const below = sorted.filter((entry) => entry < value).length
    const rank = below / (n - 1)
    const score = Math.min(5, Math.max(1, Math.round(rank * 4) + 1))
    out.set(value, ascendingIsBetter ? score : 6 - score)
  }
  return out
}

function segmentOf(r: number, f: number): Segment {
  if (r >= 4 && f >= 4) return 'champion'
  if (r >= 3 && f >= 3) return 'loyal'
  if (r >= 4 && f <= 1) return 'new'
  if (r >= 4) return 'promising'
  if (r <= 2 && f >= 4) return 'cannot_lose'
  if (r <= 2 && f >= 3) return 'at_risk'
  if (r <= 1) return 'lost'
  // The two remaining cells are genuinely different, and folding them into one
  // bucket made "needs attention" the largest segment in every fixture, which
  // is a label that tells a merchant to act on half their book.
  if (r === 3) return 'occasional'
  return 'needs_attention'
}

export interface CustomerAnalysisInput {
  readonly orders: readonly AnalysedOrder[]
  /** The day recency is measured from. Injected so the analysis is testable. */
  readonly asOf?: Date
}

export function customerMetrics(input: CustomerAnalysisInput): CustomerMetrics[] {
  const asOf = input.asOf ?? new Date()
  const byCustomer = new Map<string, AnalysedOrder[]>()

  for (const order of input.orders) {
    if (!order.customerId) continue
    const bucket = byCustomer.get(order.customerId) ?? []
    bucket.push(order)
    byCustomer.set(order.customerId, bucket)
  }

  const raw = [...byCustomer.entries()].map(([customerId, orders]) => {
    const sorted = [...orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt))
    const first = sorted[0] as AnalysedOrder
    const last = sorted[sorted.length - 1] as AnalysedOrder
    const lifetime = orders.reduce((sum, order) => sum + order.grossMinor, 0)
    const recencyDays = Math.max(
      0,
      Math.floor((asOf.getTime() - new Date(last.placedAt).getTime()) / 86_400_000),
    )

    const spanDays =
      (new Date(last.placedAt).getTime() - new Date(first.placedAt).getTime()) / 86_400_000
    const cadenceDays = orders.length > 1 ? spanDays / (orders.length - 1) : null

    const units = new Map<string, { name: string; units: number }>()
    for (const order of orders) {
      for (const line of order.lines) {
        const entry = units.get(line.itemId) ?? { name: line.name, units: 0 }
        entry.units += line.quantity
        units.set(line.itemId, entry)
      }
    }

    return {
      customerId,
      recencyDays,
      orderCount: orders.length,
      lifetimeMinor: lifetime,
      averageBasketMinor: Math.round(lifetime / orders.length),
      firstOrderAt: first.placedAt,
      lastOrderAt: last.placedAt,
      cadenceDays,
      // Below 1 they are not yet due. Above 2 they have broken their own
      // pattern, which is the earliest honest signal that they have gone.
      overdueRatio: cadenceDays && cadenceDays > 0 ? recencyDays / cadenceDays : null,
      favouriteItems: [...units.entries()]
        .map(([itemId, entry]) => ({ itemId, ...entry }))
        .sort((a, b) => b.units - a.units)
        .slice(0, 5),
    }
  })

  if (raw.length === 0) return []

  const rScores = quintileScores(raw.map((entry) => entry.recencyDays), false)
  const fScores = quintileScores(raw.map((entry) => entry.orderCount), true)
  const mScores = quintileScores(raw.map((entry) => entry.lifetimeMinor), true)

  return raw
    .map((entry) => {
      const r = rScores.get(entry.recencyDays) ?? 3
      const f = fScores.get(entry.orderCount) ?? 3
      const m = mScores.get(entry.lifetimeMinor) ?? 3
      return { ...entry, r, f, m, segment: segmentOf(r, f) }
    })
    .sort((a, b) => b.lifetimeMinor - a.lifetimeMinor)
}

export interface SegmentSummary {
  readonly segment: Segment
  readonly customers: number
  readonly revenueMinor: number
  /** Share of all customers, 0 to 1. */
  readonly share: number
  readonly averageLifetimeMinor: number
}

export function segmentSummary(metrics: readonly CustomerMetrics[]): SegmentSummary[] {
  const order: Segment[] = [
    'champion', 'loyal', 'promising', 'new', 'occasional',
    'needs_attention', 'at_risk', 'cannot_lose', 'lost',
  ]
  const total = metrics.length
  return order.map((segment) => {
    const members = metrics.filter((entry) => entry.segment === segment)
    const revenue = members.reduce((sum, entry) => sum + entry.lifetimeMinor, 0)
    return {
      segment,
      customers: members.length,
      revenueMinor: revenue,
      share: total === 0 ? 0 : members.length / total,
      averageLifetimeMinor: members.length === 0 ? 0 : Math.round(revenue / members.length),
    }
  })
}

export const SEGMENTS: Readonly<
  Record<Segment, { label: string; meaning: string; action: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }>
> = {
  champion: {
    label: 'Champions',
    meaning: 'Recent, frequent, and they spend.',
    action: 'Reward them. Early access, a named greeting, first pick of anything scarce.',
    tone: 'good',
  },
  loyal: {
    label: 'Loyal',
    meaning: 'They come back regularly.',
    action: 'Ask them what they want next. They will tell you, and they will buy it.',
    tone: 'good',
  },
  promising: {
    label: 'Promising',
    meaning: 'Recent, still finding their feet.',
    action: 'A second visit is the one that decides. Give them a reason within their cadence.',
    tone: 'neutral',
  },
  new: {
    label: 'New',
    meaning: 'One visit, and it was recent.',
    action: 'Welcome them properly. Most of these never come back unless something invites them.',
    tone: 'neutral',
  },
  occasional: {
    label: 'Occasional',
    meaning: 'They drop in now and then. Most businesses are mostly these.',
    action: 'Nothing urgent. Worth a nudge if you want a second visit inside the month.',
    tone: 'neutral',
  },
  needs_attention: {
    label: 'Needs attention',
    meaning: 'Not seen in a while, and never came often.',
    action: 'One prompt. If it does nothing, stop spending on them.',
    tone: 'warn',
  },
  at_risk: {
    label: 'At risk',
    meaning: 'They were frequent and have not been back.',
    action: 'Win-back, and make it worth opening. You have weeks, not months.',
    tone: 'warn',
  },
  cannot_lose: {
    label: 'Cannot lose',
    meaning: 'They spent a lot and have stopped coming.',
    action: 'Call them. Not an email: these are worth a person picking up the phone.',
    tone: 'bad',
  },
  lost: {
    label: 'Lost',
    meaning: 'Long gone.',
    action: 'One last offer, then stop spending on them and learn from why they left.',
    tone: 'bad',
  },
}

/**
 * Retention by joining month.
 *
 * Cohorts answer the question a revenue line cannot: whether the business is
 * growing because it keeps people, or because it keeps finding new ones. Those
 * are different businesses with the same chart.
 */
export interface Cohort {
  /** YYYY-MM of the customer's first order. */
  readonly cohort: string
  readonly size: number
  /** Fraction of the cohort that ordered in month 0, 1, 2 and so on. */
  readonly retention: readonly number[]
}

export function cohorts(orders: readonly AnalysedOrder[], months = 6): Cohort[] {
  const monthOf = (iso: string): string => iso.slice(0, 7)
  const monthIndex = (from: string, to: string): number => {
    const [fy, fm] = from.split('-').map(Number) as [number, number]
    const [ty, tm] = to.split('-').map(Number) as [number, number]
    return (ty - fy) * 12 + (tm - fm)
  }

  const first = new Map<string, string>()
  const active = new Map<string, Set<string>>()

  for (const order of orders) {
    if (!order.customerId) continue
    const month = monthOf(order.placedAt)
    const seen = first.get(order.customerId)
    if (!seen || month < seen) first.set(order.customerId, month)
    const bucket = active.get(order.customerId) ?? new Set<string>()
    bucket.add(month)
    active.set(order.customerId, bucket)
  }

  const byCohort = new Map<string, string[]>()
  for (const [customerId, month] of first) {
    const bucket = byCohort.get(month) ?? []
    bucket.push(customerId)
    byCohort.set(month, bucket)
  }

  return [...byCohort.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cohort, members]) => ({
      cohort,
      size: members.length,
      retention: Array.from({ length: months }, (_, offset) => {
        const returning = members.filter((customerId) =>
          [...(active.get(customerId) ?? [])].some(
            (month) => monthIndex(cohort, month) === offset,
          ),
        ).length
        return members.length === 0 ? 0 : returning / members.length
      }),
    }))
}
