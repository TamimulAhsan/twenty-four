import { describe, expect, it } from 'vitest'
import { storeFor } from './store'
import {
  customerMetrics, financialSummary, productPerformance, segmentSummary,
  discountPerformance, cohorts, presetPeriod,
} from '@twentyfour/analytics'

const toAnalysed = (store: ReturnType<typeof storeFor>) =>
  store.listOrders().map((order) => ({
    id: order.id,
    placedAt: order.placedAt,
    status: order.status,
    customerId: order.customerId,
    discountCode: order.discountCode,
    discountMinor: order.discount?.minor ?? 0,
    grossMinor: order.gross.minor,
    netMinor: order.net.minor,
    taxMinor: order.tax.minor,
    method: order.tenders[0]?.method ?? 'card',
    staffId: order.staffId,
    lines: order.lines.map((line) => {
      const item = store.items.find((entry) => entry.id === line.itemId)
      return {
        itemId: line.itemId,
        name: line.name,
        categoryId: item?.categoryId ?? null,
        quantity: line.quantity,
        grossMinor: line.gross.minor,
        netMinor: line.net.minor,
        taxMinor: line.tax.minor,
        costMinor: item?.costPrice ? item.costPrice.minor * line.quantity : null,
      }
    }),
  }))

describe.each(['cafe', 'salon', 'shop'])('generated data for %s', (tenantId) => {
  const store = storeFor(tenantId)
  const orders = toAnalysed(store)

  it('produces a substantial history', () => {
    expect(orders.length).toBeGreaterThan(300)
    expect(store.customers.length).toBeGreaterThan(40)
  })

  it('reconciles net plus tax to gross on every order', () => {
    for (const order of orders) {
      expect(order.netMinor + order.taxMinor).toBe(order.grossMinor)
    }
  })

  it('has a plausible margin', () => {
    const summary = financialSummary(orders)
    expect(summary.marginRate).not.toBeNull()
    expect(summary.marginRate as number).toBeGreaterThan(0.35)
    expect(summary.marginRate as number).toBeLessThan(0.85)
  })

  it('leaves most sales unattributed in the trades where that is true', () => {
    const attributed = orders.filter((order) => order.customerId !== null).length
    expect(attributed / orders.length).toBeGreaterThan(0.1)
    expect(attributed / orders.length).toBeLessThan(0.99)
  })

  it('spreads customers across more than one segment', () => {
    const metrics = customerMetrics({ orders })
    const populated = segmentSummary(metrics).filter((row) => row.customers > 0)
    expect(populated.length).toBeGreaterThanOrEqual(4)
  })

  it('has a long tail on products and a clear top', () => {
    const rows = productPerformance({ orders, days: 90 })
    expect(rows.length).toBeGreaterThan(5)
    expect(rows[0]?.abc).toBe('A')
    expect(rows.filter((row) => row.abc === 'A').length).toBeLessThan(rows.length)
  })

  it('has discount redemptions to analyse', () => {
    const rows = discountPerformance(orders)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.reduce((sum, row) => sum + row.redemptions, 0)).toBeGreaterThan(10)
  })

  it('has more than one cohort', () => {
    expect(cohorts(orders).length).toBeGreaterThan(1)
  })

  it('never places an order in the future', () => {
    const now = Date.now()
    for (const order of orders) expect(new Date(order.placedAt).getTime()).toBeLessThanOrEqual(now)
  })

  it('has today inside the ninety-day window', () => {
    const period = presetPeriod('90d')
    const inWindow = orders.filter((order) => order.placedAt.slice(0, 10) >= period.from)
    expect(inWindow.length).toBe(orders.length)
  })
})
