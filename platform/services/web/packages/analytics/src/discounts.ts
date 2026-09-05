/**
 * Whether a discount was worth running.
 *
 * The figure that matters is not how many were redeemed, it is what the
 * business kept afterwards. A code with a thousand redemptions that moved
 * nothing except margin from you to people who would have bought anyway is a
 * successful campaign by every vanity measure and a loss by the only real one.
 */
import { marginOf, type AnalysedOrder } from './types'

export interface DiscountPerformance {
  readonly code: string
  readonly redemptions: number
  /** Gross taken on orders that used the code. */
  readonly revenueMinor: number
  /** What the discount cost, in minor units. */
  readonly costMinor: number
  /** Margin kept on those orders, null when any line has no cost recorded. */
  readonly marginMinor: number | null
  /** Margin as a fraction of net on discounted orders. */
  readonly marginRate: number | null
  /** Average basket on discounted orders, as the customer paid it. */
  readonly averageBasketMinor: number
  /**
   * How much bigger a discounted basket is than an undiscounted one, as a
   * fraction. Positive means the code made people put more in the basket,
   * which is the case for running it at all.
   *
   * Measured before the discount is taken off. Comparing what was actually
   * paid would report a negative lift on every working code, because the
   * discount is subtracted from exactly the figure being compared: the
   * measurement would be of the discount rate, not of behaviour.
   */
  readonly basketLift: number | null
  /**
   * Margin kept per unit of discount given. Above 1 the campaign returned more
   * margin than it gave away against the undiscounted baseline; below 1 it did
   * not. Null when cost is not recorded, because guessing here is worse than
   * saying nothing.
   */
  readonly returnOnDiscount: number | null
  readonly firstUsedAt: string | null
  readonly lastUsedAt: string | null
  /** How many redeemers had never ordered before. A code that only ever
   *  rewards regulars is a discount, not an acquisition. */
  readonly newCustomers: number
}

export function discountPerformance(
  orders: readonly AnalysedOrder[],
  options: { firstOrderByCustomer?: ReadonlyMap<string, string> } = {},
): DiscountPerformance[] {
  const discounted = orders.filter((order) => order.discountCode !== null)
  const plain = orders.filter((order) => order.discountCode === null)

  const baselineBasket =
    plain.length === 0
      ? null
      : plain.reduce((sum, order) => sum + order.grossMinor, 0) / plain.length

  const baselineMarginRate = (() => {
    const margin = marginOf(plain.flatMap((order) => order.lines))
    const net = plain.reduce((sum, order) => sum + order.netMinor, 0)
    return margin === null || net === 0 ? null : margin / net
  })()

  const byCode = new Map<string, AnalysedOrder[]>()
  for (const order of discounted) {
    const bucket = byCode.get(order.discountCode as string) ?? []
    bucket.push(order)
    byCode.set(order.discountCode as string, bucket)
  }

  return [...byCode.entries()]
    .map(([code, group]) => {
      const sorted = [...group].sort((a, b) => a.placedAt.localeCompare(b.placedAt))
      const revenue = group.reduce((sum, order) => sum + order.grossMinor, 0)
      const cost = group.reduce((sum, order) => sum + order.discountMinor, 0)
      const net = group.reduce((sum, order) => sum + order.netMinor, 0)
      const margin = marginOf(group.flatMap((order) => order.lines))
      const averageBasket = Math.round(revenue / group.length)
      // What they put in the basket, before the code took anything off.
      const averageBasketBeforeDiscount =
        (revenue + cost) / group.length

      const newCustomers = options.firstOrderByCustomer
        ? group.filter((order) => {
            if (!order.customerId) return false
            const first = options.firstOrderByCustomer?.get(order.customerId)
            return first !== undefined && first === order.placedAt
          }).length
        : 0

      // What the same baskets would have kept at the undiscounted margin rate,
      // against what they actually kept. Anything above 1 earned its cost.
      const returnOnDiscount =
        margin === null || baselineMarginRate === null || cost === 0
          ? null
          : margin / (net * baselineMarginRate)

      return {
        code,
        redemptions: group.length,
        revenueMinor: revenue,
        costMinor: cost,
        marginMinor: margin,
        marginRate: margin === null || net === 0 ? null : margin / net,
        averageBasketMinor: averageBasket,
        basketLift:
          baselineBasket === null || baselineBasket === 0
            ? null
            : (averageBasketBeforeDiscount - baselineBasket) / baselineBasket,
        returnOnDiscount,
        firstUsedAt: sorted[0]?.placedAt ?? null,
        lastUsedAt: sorted[sorted.length - 1]?.placedAt ?? null,
        newCustomers,
      }
    })
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
}
