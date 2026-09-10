import { beforeEach, describe, expect, it } from 'vitest'
import { resetStore, type TenantStore } from './store'
import { breakdown, heatmap, series, summary } from './analytics'

/**
 * What a reporting answer is allowed to say.
 *
 * These assert the contract rather than the arithmetic, because the arithmetic
 * moves to ClickHouse in a real deployment and the shape must not. Three of
 * them are about a distinction that is invisible on screen until it is wrong:
 * a figure that is zero and a figure that has no answer are not the same, and
 * a dashboard that confuses them tells a merchant their goods cost nothing.
 */
const CURRENCY = 'HUF'
const tender = (method: 'cash' | 'card', minor: number) => ({
  method,
  amount: { minor: String(minor), currency: CURRENCY },
})

/** A window wide enough to hold anything a test rings up today. */
const today = () => new Date().toISOString().slice(0, 10)
const period = () => ({ from: today(), to: today(), tz: 'UTC' })

describe('reporting', () => {
  let store: TenantStore
  let itemId: string

  beforeEach(() => {
    store = resetStore('cafe')
    const first = store.listItems({})[0]
    if (!first) throw new Error('the cafe fixture has no items to sell')
    itemId = first.id
  })

  it('leaves voided sales out of the totals', () => {
    const sale = store.placeOrder({ lines: [{ itemId, quantity: 2 }], tenders: [tender('cash', 1_000_000)] })
    const before = Number(summary(store, period()).current.gross.minor)

    store.voidOrder(sale.id, 'rung up twice')

    const after = summary(store, period())
    expect(Number(after.current.gross.minor)).toBe(before - sale.gross.minor)
    // A void is the record of a sale that did not happen, so it is not a
    // refund either. Counting it in both would correct the day twice.
    expect(Number(after.current.refunded.minor)).toBe(0)
  })

  it('has no margin at all when one line has no recorded cost', () => {
    const uncosted = store.createItem({
      sku: 'NOCOST', name: 'Uncosted', description: '', kind: 'product',
      unitPrice: { minor: '500', currency: CURRENCY },
      // Null, not zero, and that is the whole point of this test: a cost
      // nobody entered is absent, and a margin computed over it would be a
      // number invented from a blank field.
      costPrice: null,
      taxBasisPoints: 2700, taxIncluded: true, categoryId: null,
      trackStock: false, durationMinutes: 0, active: true,
    })
    store.placeOrder({ lines: [{ itemId, quantity: 1 }], tenders: [tender('cash', 1_000_000)] })

    const costed = summary(store, period()).current
    expect(costed.margin).not.toBeNull()

    store.placeOrder({ lines: [{ itemId: uncosted.id, quantity: 1 }], tenders: [tender('cash', 1_000_000)] })

    const mixed = summary(store, period()).current
    // Not a smaller margin. An item nobody costed has no margin, and a figure
    // of zero here would read as goods that cost nothing to buy.
    expect(mixed.margin).toBeNull()
    expect(mixed.cost).toBeNull()
    // The revenue figures are unaffected: only the cost is unknown.
    expect(Number(mixed.gross.minor)).toBeGreaterThan(Number(costed.gross.minor))
  })

  it('splits a sale across the methods that paid for it', () => {
    const taken = (method: string) => {
      const rows = breakdown(store, period(), 'method', 0).slices
      return Number(rows.find((row) => row.key === method)?.gross.minor ?? 0)
    }
    // The fixture is already trading today, so what this measures is the
    // difference one split sale makes rather than the day's whole figure.
    const cardBefore = taken('card')
    const cashBefore = taken('cash')

    // Rung up once to learn what it comes to, then again paid two ways.
    const reference = store.placeOrder({
      lines: [{ itemId, quantity: 4 }],
      tenders: [tender('cash', 1_000_000)],
    })
    const total = reference.gross.minor
    const onCard = total - 200

    store.placeOrder({
      lines: [{ itemId, quantity: 4 }],
      tenders: [tender('card', onCard), tender('cash', 200)],
    })

    // The card took what the card took. Attributing the whole sale to the
    // first tender is how a drawer stops reconciling at the end of a day.
    expect(taken('card') - cardBefore).toBe(onCard)
    expect(taken('cash') - cashBefore).toBe(total + 200)

    const rows = breakdown(store, period(), 'method', 0).slices

    // Shares are of the whole, so they add up to it.
    const share = rows.reduce((sum, row) => sum + row.shareBasisPoints, 0)
    expect(share).toBeGreaterThan(9900)
    expect(share).toBeLessThanOrEqual(10000)
  })

  it('folds the tail into a remainder rather than dropping it', () => {
    for (const item of store.listItems({}).slice(0, 5)) {
      store.placeOrder({ lines: [{ itemId: item.id, quantity: 1 }], tenders: [tender('cash', 1_000_000)] })
    }
    const all = breakdown(store, period(), 'item', 0)
    const capped = breakdown(store, period(), 'item', 2)

    expect(capped.slices).toHaveLength(2)
    expect(capped.other).not.toBeNull()
    const kept = capped.slices.reduce((sum, row) => sum + Number(row.gross.minor), 0)
    const folded = Number(capped.other?.gross.minor ?? 0)
    const whole = all.slices.reduce((sum, row) => sum + Number(row.gross.minor), 0)
    // Nothing is lost by capping the list: what is not shown is still counted.
    expect(kept + folded).toBe(whole)
  })

  it('gives every day in the window, including the ones with nothing', () => {
    const from = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)
    const points = series(store, { from, to: today(), tz: 'UTC' }).points
    expect(points).toHaveLength(5)
    // A quiet day took nothing, which is a figure. It is not a day with no
    // answer, and a chart that skips it draws a gap that reads as broken.
    for (const point of points) {
      expect(point.gross).not.toBeNull()
    }
  })

  it('reports every cell of the week, traded in or not', () => {
    expect(heatmap(store, period()).cells).toHaveLength(7 * 24)
    // ISO weekdays: Monday is 1 and Sunday is 7, never zero.
    const weekdays = new Set(heatmap(store, period()).cells.map((cell) => cell.weekday))
    expect([...weekdays].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('says how fresh it is, and says nothing when it holds nothing', () => {
    const sale = store.placeOrder({ lines: [{ itemId, quantity: 1 }], tenders: [tender('card', 1_000_000)] })
    expect(summary(store, period()).freshness?.through).toBe(sale.placedAt)
  })
})
