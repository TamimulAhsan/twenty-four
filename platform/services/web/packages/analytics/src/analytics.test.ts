import { describe, expect, it } from 'vitest'
import {
  basketAffinity,
  change,
  cohorts,
  customerMetrics,
  dayCount,
  discountPerformance,
  financialSummary,
  hourlyHeatmap,
  previousPeriod,
  productPerformance,
  revenueBy,
  revenueByDay,
  segmentSummary,
  type AnalysedLine,
  type AnalysedOrder,
} from './index'

let sequence = 0

function line(itemId: string, quantity: number, unitNet: number, unitCost: number | null): AnalysedLine {
  const net = unitNet * quantity
  return {
    itemId,
    name: itemId.toUpperCase(),
    categoryId: null,
    quantity,
    netMinor: net,
    taxMinor: Math.round(net * 0.27),
    grossMinor: net + Math.round(net * 0.27),
    costMinor: unitCost === null ? null : unitCost * quantity,
  }
}

function order(
  placedAt: string,
  lines: AnalysedLine[],
  extra: Partial<AnalysedOrder> = {},
): AnalysedOrder {
  const net = lines.reduce((sum, entry) => sum + entry.netMinor, 0)
  const tax = lines.reduce((sum, entry) => sum + entry.taxMinor, 0)
  sequence += 1
  return {
    id: `o${sequence}`,
    placedAt,
    status: 'paid',
    customerId: null,
    discountCode: null,
    discountMinor: 0,
    netMinor: net,
    taxMinor: tax,
    grossMinor: net + tax,
    method: 'card',
    staffId: null,
    lines,
    ...extra,
  }
}

describe('periods', () => {
  // Comparing a 31-day month against a 28-day one moves every figure for a
  // reason that has nothing to do with the business.
  it('gives a comparison window of exactly equal length', () => {
    const period = { from: '2026-03-01', to: '2026-03-31' }
    const before = previousPeriod(period)
    expect(dayCount(before)).toBe(dayCount(period))
    expect(before.to).toBe('2026-02-28')
    expect(before.from).toBe('2026-01-29')
  })

  it('abuts the current period with no gap and no overlap', () => {
    const period = { from: '2026-09-01', to: '2026-09-07' }
    expect(previousPeriod(period)).toEqual({ from: '2026-08-25', to: '2026-08-31' })
  })

  // "Up from nothing" is not a percentage. Rendering it as +100% and as blank
  // both mislead, so the caller is made to decide.
  it('refuses to express a change from zero as a percentage', () => {
    expect(change(500, 0)).toBeNull()
    expect(change(0, 0)).toBeNull()
    expect(change(150, 100)).toBeCloseTo(0.5)
    expect(change(50, 100)).toBeCloseTo(-0.5)
  })
})

describe('financialSummary', () => {
  it('keeps tax out of margin', () => {
    const summary = financialSummary([order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400)])])
    expect(summary.netMinor).toBe(1000)
    expect(summary.taxMinor).toBe(270)
    expect(summary.grossMinor).toBe(1270)
    // Margin is net less cost. Taking it off gross would overstate the
    // business by the whole VAT rate.
    expect(summary.marginMinor).toBe(600)
    expect(summary.marginRate).toBeCloseTo(0.6)
  })

  it('excludes voided orders from every figure', () => {
    const summary = financialSummary([
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400)]),
      order('2026-09-01T11:00:00Z', [line('a', 1, 1000, 400)], { status: 'voided' }),
    ])
    expect(summary.orders).toBe(1)
    expect(summary.netMinor).toBe(1000)
  })

  // A margin averaged over only the lines that happen to have a cost is not a
  // margin. It looks like a number and is not one.
  it('reports no margin at all when any line has no cost', () => {
    const summary = financialSummary([
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400), line('b', 1, 500, null)]),
    ])
    expect(summary.marginMinor).toBeNull()
    expect(summary.marginRate).toBeNull()
    expect(summary.costMinor).toBeNull()
  })

  it('counts a refund without pretending the sale never happened', () => {
    const summary = financialSummary([
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400)], { status: 'refunded' }),
    ])
    expect(summary.orders).toBe(1)
    expect(summary.refundedMinor).toBe(1270)
  })
})

describe('productPerformance', () => {
  const orders = [
    order('2026-09-01T10:00:00Z', [line('big', 10, 1000, 900)]),
    order('2026-09-02T10:00:00Z', [line('big', 10, 1000, 900)]),
    order('2026-09-03T10:00:00Z', [line('rich', 1, 900, 100)]),
  ]

  it('classes by Pareto over cumulative revenue', () => {
    const rows = productPerformance({ orders, days: 3 })
    const big = rows.find((row) => row.itemId === 'big')
    expect(big?.abc).toBe('A')
    expect(big?.revenueShare).toBeGreaterThan(0.9)
  })

  // The two axes a pricing decision actually turns on: how much of the
  // business it is, and how much of each sale it keeps.
  it('separates a traffic driver from a hidden gem', () => {
    const rows = productPerformance({ orders, days: 3 })
    // Sells constantly and keeps 10%.
    expect(rows.find((row) => row.itemId === 'big')?.verdict).toBe('traffic_driver')
    // Keeps 89% and nobody buys it.
    expect(rows.find((row) => row.itemId === 'rich')?.verdict).toBe('hidden_gem')
  })

  it('computes velocity per day rather than per period', () => {
    const rows = productPerformance({ orders, days: 4 })
    expect(rows.find((row) => row.itemId === 'big')?.velocity).toBe(5)
  })

  // The product that sold nothing does not appear in the orders at all, and is
  // exactly the one a merchant needs to see.
  it('surfaces items that sold nothing', () => {
    const rows = productPerformance({
      orders,
      days: 3,
      catalog: [
        { id: 'big', name: 'BIG', categoryId: null },
        { id: 'ghost', name: 'GHOST', categoryId: null },
      ],
    })
    const ghost = rows.find((row) => row.itemId === 'ghost')
    expect(ghost?.verdict).toBe('dormant')
    expect(ghost?.units).toBe(0)
  })

  it('reports growth against the comparison period', () => {
    const rows = productPerformance({
      orders,
      previousOrders: [order('2026-08-01T10:00:00Z', [line('big', 10, 1000, 900)])],
      days: 3,
    })
    // Two periods' worth against one: doubled.
    expect(rows.find((row) => row.itemId === 'big')?.revenueChange).toBeCloseTo(1)
    // Sold nothing before, so there is no percentage to give.
    expect(rows.find((row) => row.itemId === 'rich')?.revenueChange).toBeNull()
  })
})

describe('basketAffinity', () => {
  // Two popular items appear together often simply because both are popular.
  // Lift divides that out.
  it('finds a genuine pairing above chance', () => {
    const together = Array.from({ length: 10 }, () =>
      order('2026-09-01T10:00:00Z', [line('coffee', 1, 500, 100), line('cake', 1, 900, 300)]),
    )
    const other = Array.from({ length: 10 }, () =>
      order('2026-09-01T11:00:00Z', [line('water', 1, 400, 100), line('crisps', 1, 300, 100)]),
    )
    const pairs = basketAffinity([...together, ...other], { minimumTogether: 3 })
    const cake = pairs.find((pair) => [pair.a, pair.b].includes('cake'))
    // Each is in half the baskets and they are always together: twice chance.
    expect(cake?.lift).toBeCloseTo(2)
    expect(cake?.together).toBe(10)
    expect(cake?.confidence).toBe(1)
  })

  // An item in every basket predicts nothing, and a lift of exactly 1 is the
  // correct answer rather than a bug. Pinned, because it looks like a failure.
  it('reports no lift for an item that is in every basket', () => {
    const orders = [
      ...Array.from({ length: 10 }, () =>
        order('2026-09-01T10:00:00Z', [line('coffee', 1, 500, 100), line('cake', 1, 900, 300)]),
      ),
      ...Array.from({ length: 10 }, () =>
        order('2026-09-01T11:00:00Z', [line('coffee', 1, 500, 100), line('water', 1, 400, 100)]),
      ),
    ]
    const cake = basketAffinity(orders).find((pair) => [pair.a, pair.b].includes('cake'))
    expect(cake?.lift).toBeCloseTo(1)
  })

  it('ignores single-line baskets, which contain no pairing at all', () => {
    const solo = Array.from({ length: 20 }, () =>
      order('2026-09-01T10:00:00Z', [line('coffee', 1, 500, 100)]),
    )
    expect(basketAffinity(solo)).toEqual([])
  })
})

describe('customerMetrics', () => {
  const asOf = new Date('2026-09-30T12:00:00Z')

  // A realistic population. RFM scores against the business's own customers,
  // so it needs a population to score against: on three customers the middle
  // one is the median of everything and the segmentation is noise.
  const history: AnalysedOrder[] = [
    // Comes constantly, most recently a week ago.
    ...Array.from({ length: 12 }, (_, index) =>
      order(`2026-09-${String(1 + index * 2).padStart(2, '0')}T10:00:00Z`, [line('a', 2, 3000, 1000)], {
        customerId: 'regular',
      }),
    ),
    // Used to come often, has not been since June.
    ...Array.from({ length: 8 }, (_, index) =>
      order(`2026-06-${String(1 + index * 3).padStart(2, '0')}T10:00:00Z`, [line('a', 3, 4000, 1200)], {
        customerId: 'lapsed',
      }),
    ),
    // A tail of occasional customers, so the quintiles have something to cut.
    ...Array.from({ length: 8 }, (_, index) =>
      order(`2026-08-${String(5 + index * 2).padStart(2, '0')}T10:00:00Z`, [line('a', 1, 900, 300)], {
        customerId: `casual${index}`,
      }),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      order(`2026-07-${String(3 + index * 4).padStart(2, '0')}T10:00:00Z`, [line('a', 1, 600, 200)], {
        customerId: `oneoff${index}`,
      }),
    ),
    // One visit, yesterday.
    order('2026-09-29T10:00:00Z', [line('a', 1, 500, 200)], { customerId: 'newcomer' }),
  ]

  it('scores recency, frequency and money against this business, not an absolute', () => {
    const metrics = customerMetrics({ orders: history, asOf })
    const regular = metrics.find((entry) => entry.customerId === 'regular')
    expect(regular?.orderCount).toBe(12)
    expect(regular?.f).toBe(5)
    expect(regular?.m).toBe(5)
    expect(regular?.segment).toBe('champion')
  })

  it('spots a valuable customer who has stopped coming', () => {
    const metrics = customerMetrics({ orders: history, asOf })
    const lapsed = metrics.find((entry) => entry.customerId === 'lapsed')
    // Last seen 22 June, measured 30 September.
    expect(lapsed?.recencyDays).toBe(100)
    expect(lapsed?.f).toBeGreaterThanOrEqual(4)
    // Frequent, valuable, and gone. This is the one worth a phone call.
    expect(lapsed?.segment).toBe('cannot_lose')
  })

  it('awards a top score even when the population is small', () => {
    const two = [
      order('2026-09-29T10:00:00Z', [line('a', 1, 100, 10)], { customerId: 'a' }),
      order('2026-01-02T10:00:00Z', [line('a', 1, 100, 10)], { customerId: 'b' }),
    ]
    const metrics = customerMetrics({ orders: two, asOf })
    // Value cuts cannot do this: nothing is greater than the maximum.
    expect(metrics.find((entry) => entry.customerId === 'a')?.r).toBe(5)
    expect(metrics.find((entry) => entry.customerId === 'b')?.r).toBe(1)
  })

  it('has no cadence for someone who has come once', () => {
    const metrics = customerMetrics({ orders: history, asOf })
    const newcomer = metrics.find((entry) => entry.customerId === 'newcomer')
    expect(newcomer?.cadenceDays).toBeNull()
    // Without a pattern there is nothing to be overdue against.
    expect(newcomer?.overdueRatio).toBeNull()
    expect(newcomer?.segment).toBe('new')
  })

  // The earliest honest signal that someone has gone is that they broke their
  // own rhythm, not that they crossed a fixed number of days.
  it('measures overdue against the customer own rhythm', () => {
    const weekly = Array.from({ length: 5 }, (_, index) =>
      order(`2026-08-${String(1 + index * 7).padStart(2, '0')}T10:00:00Z`, [line('a', 1, 1000, 400)], {
        customerId: 'weekly',
      }),
    )
    const metrics = customerMetrics({ orders: weekly, asOf })
    const entry = metrics.find((item) => item.customerId === 'weekly')
    expect(entry?.cadenceDays).toBeCloseTo(7, 0)
    // Last seen 29 August, measured 30 September: about a month on a weekly
    // rhythm.
    expect(entry?.overdueRatio ?? 0).toBeGreaterThan(3)
  })

  it('ignores orders with nobody attached', () => {
    const metrics = customerMetrics({
      orders: [order('2026-09-01T10:00:00Z', [line('a', 1, 100, 10)])],
      asOf,
    })
    expect(metrics).toEqual([])
  })

  it('summarises every segment, including the empty ones', () => {
    const metrics = customerMetrics({ orders: history, asOf })
    const summary = segmentSummary(metrics)
    expect(summary).toHaveLength(9)
    expect(summary.reduce((sum, row) => sum + row.customers, 0)).toBe(metrics.length)
    expect(summary.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1)
    // Every customer's lifetime value lands in exactly one segment.
    expect(summary.reduce((sum, row) => sum + row.revenueMinor, 0)).toBe(
      metrics.reduce((sum, entry) => sum + entry.lifetimeMinor, 0),
    )
  })
})

describe('cohorts', () => {
  // A revenue line cannot tell you whether a business is growing because it
  // keeps people or because it keeps finding new ones.
  it('retains everyone in their joining month', () => {
    const result = cohorts([
      order('2026-07-05T10:00:00Z', [line('a', 1, 100, 10)], { customerId: 'c1' }),
      order('2026-08-05T10:00:00Z', [line('a', 1, 100, 10)], { customerId: 'c1' }),
      order('2026-07-06T10:00:00Z', [line('a', 1, 100, 10)], { customerId: 'c2' }),
    ])
    const july = result.find((entry) => entry.cohort === '2026-07')
    expect(july?.size).toBe(2)
    expect(july?.retention[0]).toBe(1)
    // One of the two came back the next month.
    expect(july?.retention[1]).toBe(0.5)
    expect(july?.retention[2]).toBe(0)
  })
})

describe('discountPerformance', () => {
  it('measures what the business kept, not how many were redeemed', () => {
    const plain = Array.from({ length: 10 }, () =>
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400)]),
    )
    // Twice the basket, with 300 taken off at the till. Gross is what was
    // actually paid, so the fixture has to subtract it: declaring a discount
    // and leaving gross alone describes a sale that never happened.
    const promoted = Array.from({ length: 5 }, () =>
      order('2026-09-02T10:00:00Z', [line('a', 2, 1000, 400)], {
        discountCode: 'SPRING',
        discountMinor: 300,
        grossMinor: 2540 - 300,
      }),
    )
    const rows = discountPerformance([...plain, ...promoted])
    const spring = rows.find((row) => row.code === 'SPRING')

    expect(spring?.redemptions).toBe(5)
    expect(spring?.costMinor).toBe(1500)
    // Baskets on the code held twice as much before the discount came off.
    expect(spring?.basketLift).toBeCloseTo(1)
    expect(spring?.marginRate).toBeCloseTo(0.6)
    // The margin rate held, so it returned roughly what it gave away.
    expect(spring?.returnOnDiscount).toBeCloseTo(1)
  })

  // Measured on what went into the basket, not on what was paid. Comparing
  // paid figures subtracts the discount from exactly the number being
  // compared, so every working code would report a negative lift and a
  // merchant would conclude their codes shrink baskets.
  it('measures basket lift before the discount is taken off', () => {
    const plain = Array.from({ length: 10 }, () =>
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, 400)]),
    )
    // Same basket as everyone else, with 20% taken off at the till.
    const promoted = Array.from({ length: 5 }, () =>
      order('2026-09-02T10:00:00Z', [line('a', 1, 1000, 400)], {
        discountCode: 'FLAT',
        discountMinor: 254,
        grossMinor: 1270 - 254,
      }),
    )
    const flat = discountPerformance([...plain, ...promoted]).find((row) => row.code === 'FLAT')
    // They bought exactly the same thing, so the lift is zero rather than
    // minus twenty percent.
    expect(flat?.basketLift).toBeCloseTo(0)
  })

  it('says nothing about return rather than guessing when cost is unknown', () => {
    const rows = discountPerformance([
      order('2026-09-01T10:00:00Z', [line('a', 1, 1000, null)], {
        discountCode: 'X',
        discountMinor: 100,
      }),
    ])
    expect(rows[0]?.returnOnDiscount).toBeNull()
    expect(rows[0]?.marginMinor).toBeNull()
  })
})

describe('time series', () => {
  // A gap in a line chart reads as missing data. A zero reads as a quiet
  // Tuesday, which is what it is.
  it('emits a point for every day, including empty ones', () => {
    const points = revenueByDay(
      [order('2026-09-03T10:00:00Z', [line('a', 1, 1000, 400)])],
      { from: '2026-09-01', to: '2026-09-05' },
    )
    expect(points).toHaveLength(5)
    expect(points[0]?.grossMinor).toBe(0)
    expect(points[2]?.grossMinor).toBe(1270)
  })

  it('lays the week out as a full weekday by hour grid', () => {
    const cells = hourlyHeatmap([order('2026-09-03T10:00:00Z', [line('a', 1, 1000, 400)])])
    expect(cells).toHaveLength(7 * 24)
    expect(cells.filter((cell) => cell.orders > 0)).toHaveLength(1)
  })

  it('folds a long tail into one row rather than a list nobody reads', () => {
    const orders = ['a', 'b', 'c', 'd', 'e'].flatMap((key, index) =>
      Array.from({ length: 5 - index }, () =>
        order('2026-09-01T10:00:00Z', [line(key, 1, 1000, 400)], { method: key }),
      ),
    )
    const rows = revenueBy(orders, (entry) => entry.method, { limit: 2 })
    expect(rows).toHaveLength(3)
    expect(rows[2]?.key).toBe('Other')
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1)
  })
})
