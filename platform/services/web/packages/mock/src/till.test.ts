import { beforeEach, describe, expect, it } from 'vitest'
import { resetStore, MockError, type TenantStore } from './store'
import { money } from '@twentyfour/money'
import type { TenderInput } from '@twentyfour/api'

/**
 * The till's money and stock rules.
 *
 * Every one of these went wrong silently in an earlier shape of the code: a
 * split that recorded more than the sale was worth, a parked tab counted as
 * revenue, a partial refund that issued a credit note for the whole sale, a
 * drawer whose expected figure included card takings. None of them looks wrong
 * on screen, which is exactly why they are asserted here.
 */
const CURRENCY = 'HUF'

const tender = (method: TenderInput['method'], minor: number, tendered?: number): TenderInput => ({
  method,
  amount: { minor: String(minor), currency: CURRENCY },
  ...(tendered !== undefined ? { tendered: { minor: String(tendered), currency: CURRENCY } } : {}),
})

const today = () => new Date().toISOString().slice(0, 10)

describe('the till', () => {
  let store: TenantStore
  /** A tracked item, so stock assertions have something to move. */
  let itemId: string
  let onHandBefore: number

  const stockOf = (id: string): { onHand: number; reserved: number } => {
    const row = store.stockLevels().find((level) => level.itemId === id)
    return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 }
  }

  beforeEach(() => {
    store = resetStore('cafe')
    const tracked = store.stockLevels()[0]
    if (!tracked) throw new Error('the cafe fixture has no tracked stock to test against')
    itemId = tracked.itemId
    onHandBefore = tracked.onHand
  })

  describe('split tender', () => {
    it('refuses a sale with no payment at all', () => {
      expect(() => store.placeOrder({ lines: [{ itemId, quantity: 2 }], tenders: [] })).toThrow(
        MockError,
      )
    })

    it('refuses a split that does not cover the sale', () => {
      const order = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })
      expect(() =>
        store.settleParkedOrder(order.id, [
          tender('cash', order.gross.minor - 100),
          tender('card', 50),
        ]),
      ).toThrow(MockError)
    })

    it('splits one sale across two methods', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })
      const half = Math.floor(parked.gross.minor / 2)
      const order = store.settleParkedOrder(parked.id, [
        tender('cash', half),
        tender('card', parked.gross.minor - half),
      ])

      expect(order.tenders).toHaveLength(2)
      expect(order.tenders.reduce((sum, entry) => sum + entry.amount.minor, 0)).toBe(
        order.gross.minor,
      )
      expect(order.status).toBe('paid')
    })

    it('never records more than the sale was worth, and gives the rest as change', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }] })
      const over = parked.gross.minor + 1000
      const order = store.settleParkedOrder(parked.id, [tender('cash', over, over)])

      const cash = order.tenders[0]
      expect(cash?.amount.minor).toBe(order.gross.minor)
      expect(cash?.tendered?.minor).toBe(over)
      expect(cash?.change?.minor).toBe(1000)
    })

    it('leaves only the non-cash parts as payments to a provider', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })
      const half = Math.floor(parked.gross.minor / 2)
      const order = store.settleParkedOrder(parked.id, [
        tender('cash', half),
        tender('card', parked.gross.minor - half),
      ])

      const payments = store.payments.filter((payment) => payment.orderId === order.id)
      expect(payments).toHaveLength(1)
      expect(payments[0]?.method).toBe('card')
    })
  })

  describe('parking a sale', () => {
    it('holds stock without selling it', () => {
      store.parkOrder({ lines: [{ itemId, quantity: 3 }] })
      expect(stockOf(itemId)).toEqual({ onHand: onHandBefore, reserved: 3 })
    })

    it('is in nobody’s takings and in no order list', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })

      expect(store.listOrders().some((order) => order.id === parked.id)).toBe(false)
      expect(store.listParkedOrders().map((order) => order.id)).toContain(parked.id)

    })

    it('does not move the day’s takings by one unit', () => {
      const before = store.takings(today()).gross.minor
      store.parkOrder({ lines: [{ itemId, quantity: 4 }] })
      expect(store.takings(today()).gross.minor).toBe(before)
    })

    it('issues no document, because nothing has been paid for', () => {
      const before = store.documents.length
      store.parkOrder({ lines: [{ itemId, quantity: 1 }] })
      expect(store.documents).toHaveLength(before)
    })

    it('can still be fetched by id even though the list hides it', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }] })
      expect(store.getOrder(parked.id).status).toBe('open')
    })

    it('re-reserves from scratch when the tab is edited', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 3 }] })
      store.updateParkedOrder(parked.id, { lines: [{ itemId, quantity: 1 }] })
      expect(stockOf(itemId)).toEqual({ onHand: onHandBefore, reserved: 1 })
    })

    it('puts what it was holding back when it is thrown away', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })
      store.discardParkedOrder(parked.id)

      expect(stockOf(itemId)).toEqual({ onHand: onHandBefore, reserved: 0 })
      expect(store.listParkedOrders()).toHaveLength(0)
      expect(() => store.getOrder(parked.id)).toThrow(MockError)
    })

    it('turns the reservation into a sale when it settles', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 2 }] })
      const settled = store.settleParkedOrder(parked.id, [tender('card', parked.gross.minor)])

      expect(settled.id).toBe(parked.id)
      expect(settled.number).toBe(parked.number)
      expect(settled.status).toBe('paid')
      expect(stockOf(itemId)).toEqual({ onHand: onHandBefore - 2, reserved: 0 })
      expect(store.documents.some((document) => document.orderId === settled.id)).toBe(true)
      expect(store.takings(today()).gross.minor).toBeGreaterThanOrEqual(settled.gross.minor)
    })

    it('cannot be settled twice', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }] })
      store.settleParkedOrder(parked.id, [tender('card', parked.gross.minor)])
      expect(() =>
        store.settleParkedOrder(parked.id, [tender('card', parked.gross.minor)]),
      ).toThrow(MockError)
    })

    it('cannot be refunded or voided, because nobody paid for it', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }] })
      expect(() => store.refundOrder(parked.id)).toThrow(MockError)
      expect(() => store.voidOrder(parked.id, 'test')).toThrow(MockError)
    })
  })

  describe('a tab on a table', () => {
    const tableId = () => store.listTables()[0]?.id as string

    it('attaches to the table and comes off when it settles', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }], tableId: tableId() })
      expect(store.listTables().find((table) => table.id === tableId())?.orderId).toBe(parked.id)

      store.settleParkedOrder(parked.id, [tender('card', parked.gross.minor)])
      expect(store.listTables().find((table) => table.id === tableId())?.orderId).toBeNull()
    })

    it('refuses a second tab on the same table', () => {
      store.parkOrder({ lines: [{ itemId, quantity: 1 }], tableId: tableId() })
      expect(() =>
        store.parkOrder({ lines: [{ itemId, quantity: 1 }], tableId: tableId() }),
      ).toThrow(MockError)
    })

    it('refuses to clear a table that still owes money', () => {
      store.parkOrder({ lines: [{ itemId, quantity: 1 }], tableId: tableId() })
      expect(() => store.updateTable(tableId(), { status: 'free' })).toThrow(MockError)
    })

    it('releases the table when the tab is thrown away', () => {
      const parked = store.parkOrder({ lines: [{ itemId, quantity: 1 }], tableId: tableId() })
      store.discardParkedOrder(parked.id)
      expect(store.listTables().find((table) => table.id === tableId())?.orderId).toBeNull()
      expect(() => store.updateTable(tableId(), { status: 'free' })).not.toThrow()
    })
  })

  describe('refunding', () => {
    const twoLineSale = () => {
      const second = store.stockLevels()[1]
      if (!second) throw new Error('need a second tracked item')
      return store.placeOrder({
        lines: [
          { itemId, quantity: 2 },
          { itemId: second.itemId, quantity: 1 },
        ],
        tenders: [tender('card', 1_000_000)],
      })
    }

    it('gives back only the line that was returned', () => {
      const order = twoLineSale()
      const first = order.lines[0]
      if (!first) throw new Error('no line')

      const refunded = store.refundOrder(order.id, [first.id])

      expect(refunded.status).toBe('partly_refunded')
      expect(refunded.refunded.minor).toBe(first.gross.minor)
      expect(refunded.refundedLineIds).toEqual([first.id])
      // Only the returned line comes back to stock.
      expect(stockOf(itemId).onHand).toBe(onHandBefore)
    })

    it('issues a credit note for what went back, not for the sale', () => {
      const order = twoLineSale()
      const first = order.lines[0]
      if (!first) throw new Error('no line')

      store.refundOrder(order.id, [first.id])
      const note = store.documents.find(
        (document) => document.orderId === order.id && document.kind === 'credit_note',
      )

      expect(note).toBeDefined()
      expect(note?.gross.minor).toBe(first.gross.minor)
      expect(note?.gross.minor).toBeLessThan(order.gross.minor)
      // The original is untouched and still there.
      const receipt = store.documents.find(
        (document) => document.orderId === order.id && document.kind === 'receipt',
      )
      expect(receipt?.gross.minor).toBe(order.gross.minor)
    })

    it('refuses to give the same line back twice', () => {
      const order = twoLineSale()
      const first = order.lines[0]
      if (!first) throw new Error('no line')

      store.refundOrder(order.id, [first.id])
      expect(() => store.refundOrder(order.id, [first.id])).toThrow(MockError)
    })

    it('completes to a full refund once the rest goes back', () => {
      const order = twoLineSale()
      const [first, second] = order.lines
      if (!first || !second) throw new Error('need two lines')

      store.refundOrder(order.id, [first.id])
      const done = store.refundOrder(order.id, [second.id])

      expect(done.status).toBe('refunded')
      expect(done.refunded.minor).toBe(order.gross.minor)
      expect(() => store.refundOrder(order.id)).toThrow(MockError)
    })

    it('counts a partial refund in the day’s refunded figure', () => {
      const order = twoLineSale()
      const first = order.lines[0]
      if (!first) throw new Error('no line')

      const before = store.takings(today()).refunded.minor
      store.refundOrder(order.id, [first.id])

      expect(store.takings(today()).refunded.minor).toBe(before + first.gross.minor)
    })

    it('puts a refund back on the payment that took it', () => {
      const order = twoLineSale()
      const first = order.lines[0]
      if (!first) throw new Error('no line')

      store.refundOrder(order.id, [first.id])
      const payment = store.payments.find((entry) => entry.orderId === order.id)

      expect(payment?.refunded.minor).toBe(first.gross.minor)
      expect(payment?.status).toBe('captured')
    })
  })

  describe('counting the drawer', () => {
    it('expects only what was taken in cash', () => {
      const cashSale = store.placeOrder({
        lines: [{ itemId, quantity: 1 }],
        tenders: [tender('cash', 1_000_000)],
      })
      store.placeOrder({
        lines: [{ itemId, quantity: 1 }],
        tenders: [tender('card', 1_000_000)],
      })

      const before = store.dayClose(today())
      const drawer = store.closeDay({
        date: today(),
        openingFloat: money(10_000, CURRENCY),
        countedCash: money(0, CURRENCY),
      })

      // The card sale is in the day's takings and in none of the drawer.
      expect(drawer.cashTaken.minor).toBe(before.cashTaken.minor)
      expect(drawer.cashTaken.minor).toBeGreaterThanOrEqual(cashSale.gross.minor)
      expect(drawer.expectedCash.minor).toBe(
        10_000 + drawer.cashTaken.minor - drawer.cashRefunded.minor,
      )
    })

    it('takes a cash refund back out of the drawer', () => {
      const order = store.placeOrder({
        lines: [{ itemId, quantity: 1 }],
        tenders: [tender('cash', 1_000_000)],
      })
      const expectedBefore = store.dayClose(today()).expectedCash.minor

      store.refundOrder(order.id)

      const after = store.dayClose(today())
      expect(after.cashRefunded.minor).toBe(order.gross.minor)
      expect(after.expectedCash.minor).toBe(expectedBefore - order.gross.minor)
    })

    it('reports short and over as a signed difference', () => {
      const drawer = store.dayClose(today())
      const short = store.closeDay({
        date: today(),
        openingFloat: drawer.openingFloat,
        countedCash: money(drawer.expectedCash.minor - 500, CURRENCY),
      })
      expect(short.variance?.minor).toBe(-500)
      expect(short.closed).toBe(true)

      const over = store.closeDay({
        date: today(),
        openingFloat: short.openingFloat,
        countedCash: money(short.expectedCash.minor + 200, CURRENCY),
      })
      // A recount replaces: the figure that stands is the last one counted.
      expect(over.variance?.minor).toBe(200)
    })

    it('has nothing counted until somebody counts it', () => {
      const drawer = store.dayClose(today())
      expect(drawer.closed).toBe(false)
      expect(drawer.countedCash).toBeNull()
      expect(drawer.variance).toBeNull()
    })
  })
})
