/**
 * How each thing you sell is actually doing.
 *
 * The question a merchant has is never "what were the totals". It is which
 * lines to push, which to reprice, and which to stop making. So every product
 * carries a verdict alongside its figures, and the verdict is derived from two
 * axes a merchant can act on: how much of the business it is, and how much of
 * each sale it keeps.
 */
import { marginOf, sumBy, type AnalysedLine, type AnalysedOrder } from './types'

export type AbcClass = 'A' | 'B' | 'C'

/**
 * What to do about it.
 *
 * A 2x2 on volume share and margin rate, which is the pair a pricing or menu
 * decision actually turns on.
 */
export type ProductVerdict =
  /** High share, high margin. Protect it and keep it in stock. */
  | 'star'
  /** High share, low margin. It pulls people in and earns little: reprice,
   *  renegotiate, or accept it as a loss leader deliberately. */
  | 'traffic_driver'
  /** Low share, high margin. Worth pushing: it earns well and nobody buys it. */
  | 'hidden_gem'
  /** Low share, low margin. It occupies space and earns nothing. */
  | 'drag'
  /** Nothing sold in the period. */
  | 'dormant'

export interface ProductPerformance {
  readonly itemId: string
  readonly name: string
  readonly categoryId: string | null
  readonly units: number
  readonly grossMinor: number
  readonly netMinor: number
  readonly costMinor: number | null
  readonly marginMinor: number | null
  /** Margin as a fraction of net. null when cost is not recorded. */
  readonly marginRate: number | null
  /** This item's share of the period's gross revenue, 0 to 1. */
  readonly revenueShare: number
  /** Units per day over the period. */
  readonly velocity: number
  /** How many separate orders contained it. */
  readonly orderCount: number
  /** Fractional change in gross against the comparison period, null when it
   *  sold nothing then. */
  readonly revenueChange: number | null
  /** Pareto class by cumulative revenue: A is the top 80%, B the next 15%. */
  readonly abc: AbcClass
  readonly verdict: ProductVerdict
}

interface Accumulator {
  name: string
  categoryId: string | null
  units: number
  gross: number
  net: number
  cost: number | null
  orders: Set<string>
}

function accumulate(orders: readonly AnalysedOrder[]): Map<string, Accumulator> {
  const byItem = new Map<string, Accumulator>()
  for (const order of orders) {
    for (const line of order.lines) {
      const entry = byItem.get(line.itemId) ?? {
        name: line.name,
        categoryId: line.categoryId,
        units: 0,
        gross: 0,
        net: 0,
        cost: 0 as number | null,
        orders: new Set<string>(),
      }
      entry.units += line.quantity
      entry.gross += line.grossMinor
      entry.net += line.netMinor
      // One untracked cost poisons the whole item's margin, which is correct:
      // an average over the lines that happen to have a cost is not a margin.
      entry.cost = entry.cost === null || line.costMinor === null ? null : entry.cost + line.costMinor
      entry.orders.add(order.id)
      byItem.set(line.itemId, entry)
    }
  }
  return byItem
}

export interface ProductPerformanceInput {
  readonly orders: readonly AnalysedOrder[]
  readonly previousOrders?: readonly AnalysedOrder[]
  readonly days: number
  /** Items with no sales in the period, so dead stock is visible rather than
   *  simply absent from the table. */
  readonly catalog?: ReadonlyArray<{ id: string; name: string; categoryId: string | null }>
}

export function productPerformance(input: ProductPerformanceInput): ProductPerformance[] {
  const current = accumulate(input.orders)
  const previous = accumulate(input.previousOrders ?? [])
  const totalGross = [...current.values()].reduce((sum, entry) => sum + entry.gross, 0)

  const rows: ProductPerformance[] = [...current.entries()].map(([itemId, entry]) => {
    const marginMinor = entry.cost === null ? null : entry.net - entry.cost
    const before = previous.get(itemId)?.gross ?? 0
    return {
      itemId,
      name: entry.name,
      categoryId: entry.categoryId,
      units: entry.units,
      grossMinor: entry.gross,
      netMinor: entry.net,
      costMinor: entry.cost,
      marginMinor,
      marginRate: marginMinor === null || entry.net === 0 ? null : marginMinor / entry.net,
      revenueShare: totalGross === 0 ? 0 : entry.gross / totalGross,
      velocity: input.days === 0 ? 0 : entry.units / input.days,
      orderCount: entry.orders.size,
      revenueChange: before === 0 ? null : (entry.gross - before) / before,
      abc: 'C',
      verdict: 'drag',
    }
  })

  // Dormant items are the point of the catalog argument: a product that sold
  // nothing does not appear in the orders at all, and is exactly the one a
  // merchant needs to see.
  if (input.catalog) {
    for (const item of input.catalog) {
      if (current.has(item.id)) continue
      rows.push({
        itemId: item.id,
        name: item.name,
        categoryId: item.categoryId,
        units: 0,
        grossMinor: 0,
        netMinor: 0,
        costMinor: null,
        marginMinor: null,
        marginRate: null,
        revenueShare: 0,
        velocity: 0,
        orderCount: 0,
        revenueChange: null,
        abc: 'C',
        verdict: 'dormant',
      })
    }
  }

  rows.sort((a, b) => b.grossMinor - a.grossMinor)

  // Pareto: walk down the ranking accumulating revenue. A is everything up to
  // 80% of the total, B to 95%, C the tail.
  let cumulative = 0
  const medianMargin = medianOf(
    rows.map((row) => row.marginRate).filter((rate): rate is number => rate !== null),
  )
  const shareThreshold = rows.length > 0 ? 1 / rows.length : 0

  return rows.map((row) => {
    // Measured before this row is added, so the item that carries the total
    // past 80% is counted inside A rather than just outside it. Classifying on
    // the total afterwards puts a product that is 96% of the business into C.
    const ratioBefore = totalGross === 0 ? 1 : cumulative / totalGross
    cumulative += row.grossMinor
    const abc: AbcClass = row.grossMinor === 0 ? 'C' : ratioBefore < 0.8 ? 'A' : ratioBefore < 0.95 ? 'B' : 'C'

    let verdict: ProductVerdict
    if (row.units === 0) {
      verdict = 'dormant'
    } else {
      // Above its fair share of revenue if every item sold equally.
      const highVolume = row.revenueShare >= shareThreshold
      // Margin is compared against this business's own median rather than an
      // industry number: a 60% margin is poor in one trade and excellent in
      // another, and the merchant only ever competes with themselves here.
      const highMargin = row.marginRate !== null && medianMargin !== null && row.marginRate >= medianMargin
      verdict = highVolume
        ? highMargin
          ? 'star'
          : 'traffic_driver'
        : highMargin
          ? 'hidden_gem'
          : 'drag'
    }

    return { ...row, abc, verdict }
  })
}

/**
 * The two lines the verdicts are drawn against.
 *
 * Exported so a chart can put its dividers exactly where the classification
 * puts them. Scaling a quadrant plot to the maximum instead would let a dot
 * labelled "hidden gem" land in the "consider dropping" corner, and a chart
 * that contradicts the table beside it is worse than no chart.
 */
export function performanceThresholds(rows: readonly ProductPerformance[]): {
  medianMarginRate: number | null
  revenueShare: number
} {
  return {
    medianMarginRate: medianOf(
      rows.map((row) => row.marginRate).filter((rate): rate is number => rate !== null),
    ),
    // The share each item would have if everything sold equally.
    revenueShare: rows.length > 0 ? 1 / rows.length : 0,
  }
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number)
}

export const VERDICT_LABELS: Readonly<Record<ProductVerdict, { label: string; action: string }>> = {
  star: { label: 'Star', action: 'Sells well and earns well. Keep it in stock and in sight.' },
  traffic_driver: {
    label: 'Traffic driver',
    action: 'Popular but thin. Reprice it, cut its cost, or keep it deliberately as a draw.',
  },
  hidden_gem: {
    label: 'Hidden gem',
    action: 'Earns well and nobody buys it. Move it up the list or suggest it at the till.',
  },
  drag: { label: 'Drag', action: 'Little volume, little margin. Consider dropping it.' },
  dormant: { label: 'Dormant', action: 'Sold nothing in this period. Check stock, price and placement.' },
}

/**
 * What sells together.
 *
 * Lift, not raw co-occurrence: two popular items appear together often simply
 * because both are popular. Lift divides that out, so a pair above 1 really is
 * bought together more than chance would produce.
 */
export interface BasketPair {
  readonly a: string
  readonly b: string
  readonly aName: string
  readonly bName: string
  readonly together: number
  readonly lift: number
  /** Of the baskets containing a, the fraction that also contain b. */
  readonly confidence: number
}

export function basketAffinity(
  orders: readonly AnalysedOrder[],
  options: { minimumTogether?: number; limit?: number } = {},
): BasketPair[] {
  const minimum = options.minimumTogether ?? 3
  const baskets = orders
    .map((order) => ({
      items: new Set(order.lines.map((line) => line.itemId)),
      names: new Map(order.lines.map((line) => [line.itemId, line.name] as const)),
    }))
    .filter((basket) => basket.items.size > 1)

  if (baskets.length === 0) return []

  const single = new Map<string, number>()
  const names = new Map<string, string>()
  const pairs = new Map<string, number>()

  for (const basket of baskets) {
    const ids = [...basket.items].sort()
    for (const id of ids) {
      single.set(id, (single.get(id) ?? 0) + 1)
      names.set(id, basket.names.get(id) ?? id)
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }

  const total = baskets.length
  const out: BasketPair[] = []
  for (const [key, together] of pairs) {
    if (together < minimum) continue
    const [a, b] = key.split('|') as [string, string]
    const supportA = (single.get(a) ?? 0) / total
    const supportB = (single.get(b) ?? 0) / total
    if (supportA === 0 || supportB === 0) continue
    out.push({
      a,
      b,
      aName: names.get(a) ?? a,
      bName: names.get(b) ?? b,
      together,
      lift: together / total / (supportA * supportB),
      confidence: together / (single.get(a) ?? 1),
    })
  }

  return out.sort((x, y) => y.lift - x.lift).slice(0, options.limit ?? 12)
}

export type { AnalysedLine, AnalysedOrder }
export { sumBy, marginOf }
