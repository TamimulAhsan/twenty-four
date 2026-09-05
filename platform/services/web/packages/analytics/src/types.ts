/**
 * What the engine consumes.
 *
 * Deliberately structural rather than importing the API types: the analysis
 * should be testable from a handful of literals, and it should not break every
 * time a field is added to an order.
 *
 * Money crosses this boundary as a plain integer count of minor units, already
 * validated by the API layer's parser. Every function that returns a
 * money-shaped figure rounds explicitly, and the caller wraps the result in
 * money(), which re-checks that it is a whole number. Ratios and shares are
 * floats and are never money.
 */
export interface AnalysedLine {
  readonly itemId: string
  readonly name: string
  readonly categoryId: string | null
  readonly quantity: number
  readonly grossMinor: number
  readonly netMinor: number
  readonly taxMinor: number
  /** Unit cost times quantity. null when the item has no cost recorded, which
   *  is different from zero and must not be averaged as if it were. */
  readonly costMinor: number | null
}

export interface AnalysedOrder {
  readonly id: string
  /** ISO timestamp. */
  readonly placedAt: string
  readonly status: string
  readonly customerId: string | null
  readonly discountCode: string | null
  /** Order-level discount in minor units. Line discounts are already inside
   *  the line's gross. */
  readonly discountMinor: number
  readonly grossMinor: number
  readonly netMinor: number
  readonly taxMinor: number
  readonly method: string
  readonly staffId: string | null
  readonly lines: readonly AnalysedLine[]
}

/** Orders that count towards trade. A void never happened; a refund is handled
 *  as its own figure rather than by pretending the sale did not occur. */
export function isTrading(order: AnalysedOrder): boolean {
  return order.status !== 'voided'
}

export const day = (order: AnalysedOrder): string => order.placedAt.slice(0, 10)

export function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0
  for (const item of items) total += pick(item)
  return total
}

/** Margin in minor units, or null when any line in the set has no cost. A
 *  partial margin is worse than none: it looks like a number and is not one. */
export function marginOf(lines: readonly AnalysedLine[]): number | null {
  let net = 0
  let cost = 0
  for (const line of lines) {
    if (line.costMinor === null) return null
    net += line.netMinor
    cost += line.costMinor
  }
  return net - cost
}
