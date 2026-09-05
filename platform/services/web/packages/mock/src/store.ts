/**
 * The mock server's state.
 *
 * Stateful on purpose. A till that does not actually move stock, land in the
 * day's takings and issue a receipt cannot be built, only mocked up, and the
 * difference shows the first time someone tries to use it.
 *
 * It prices with the real pricing package rather than a shortcut, so the
 * figures on screen are the figures the Go service will return. That makes
 * this the executable spec for the Merchant BFF as well as a fixture.
 */
import {
  money,
  priceLine,
  totalOf,
  sumMoney,
  zero,
  type Amounts,
  type Money,
} from '@twentyfour/money'
import type {
  Booking,
  Customer,
  NotificationPreferences,
  DiningTable,
  Discount,
  LoyaltyMember,
  LoyaltyProgramme,
  BookingInput,
  BusinessProfile,
  CatalogCategory,
  CatalogItem,
  CatalogItemInput,
  EntitlementPayload,
  FiscalDocument,
  DayClose,
  Order,
  OrderLine,
  OnboardingState,
  ParkOrderInput,
  Payment,
  PlaceOrderInput,
  TenderInput,
  Session,
  StaffMember,
  StockLevel,
  Subscription,
  Takings,
  Tender,
  TenderMethod,
} from '@twentyfour/api'
import {
  generateHistory,
  buildLoyaltyProgramme,
  type OrderIntent,
} from './generate'
import {
  BUILT_IN_ROLES,
  CUSTOM_ROLE_RANK,
  can,
  canAssignRole,
  canInvite,
  checkDeactivate,
  checkRoleChange,
  seatsUsed,
  type PermissionId,
  type RoleDefinition,
  type TeamMember,
} from '@twentyfour/rbac'
import { industryProfile } from '@twentyfour/entitlement'
import { seedFor, SEEDS, type TenantSeed } from './seed'

export class MockError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface StockRow {
  onHand: number
  reserved: number
  lowStockThreshold: number | null
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function at(daysFromToday: number, hour: number, minute = 0): Date {
  const date = new Date()
  date.setDate(date.getDate() + daysFromToday)
  date.setHours(hour, minute, 0, 0)
  return date
}

export class TenantStore {
  readonly id: string
  readonly label: string
  readonly proves: string
  profile: BusinessProfile
  session: Session
  entitlement: EntitlementPayload
  subscription: Subscription
  onboarding: OnboardingState | null

  categories: CatalogCategory[]
  items: CatalogItem[]
  staff: StaffMember[]
  orders: Order[] = []
  bookings: Booking[] = []
  tables: DiningTable[] = []
  customers: Customer[] = []
  discounts: Discount[] = []
  loyaltyProgramme: LoyaltyProgramme
  loyaltyMembers: LoyaltyMember[] = []
  customRoles: RoleDefinition[] = []
  termOverrides: Record<string, { one: string; other: string }> = {}
  notifications: NotificationPreferences = {
    channels: ['email', 'sms'],
    quietFrom: '21:00',
    quietTo: '08:00',
    bookingReminders: true,
    receiptByEmail: true,
    marketing: false,
  }
  payments: Payment[] = []
  documents: FiscalDocument[] = []

  private stock = new Map<string, StockRow>()
  private counters = { order: 0, document: 0, booking: 0, payment: 0, item: 0, staff: 0 }
  /** Drawer counts, by date. Minor units, because a counted drawer is money. */
  private dayCloses = new Map<
    string,
    {
      openingFloat: number
      countedCash: number
      countedBy: string
      countedAt: string
      note: string
    }
  >()

  constructor(seed: TenantSeed) {
    this.id = seed.id
    this.label = seed.label
    this.proves = seed.proves
    this.profile = seed.profile
    this.session = seed.session
    this.entitlement = seed.entitlement
    this.subscription = seed.subscription
    this.onboarding = seed.onboarding
    this.categories = [...seed.categories]
    this.items = [...seed.items]
    this.staff = [...seed.staff]
    this.tables = [...seed.tables]
    this.loyaltyProgramme = buildLoyaltyProgramme(seed.profile.currency)
    this.counters.item = seed.items.length
    this.counters.staff = seed.staff.length

    for (const item of seed.items) {
      if (!item.trackStock) continue
      this.stock.set(item.id, { onHand: 0, reserved: 0, lowStockThreshold: 6 })
    }

    this.syncSeats()
    this.seedHistory()

    // Opening stock is what is on the shelf right now, so it is set after the
    // history has run rather than before it. Setting it first and then selling
    // two weeks against it drives every tracked line negative, which is not a
    // state a shop is ever actually in.
    // Keyed off position rather than the sku, so the same couple of lines are
    // always under the reorder point whatever a fixture happens to be called.
    // An inventory screen with nothing to act on demonstrates nothing, and
    // character codes collide: every tracked item in the cafe starts with C.
    let tracked = 0
    for (const item of seed.items) {
      if (!item.trackStock) continue
      const row = this.stock.get(item.id)
      if (!row) continue
      const position = tracked % 5
      row.onHand = position === 0 ? 0 : position === 1 ? 4 : 9 + position * 7
      tracked += 1
    }
  }

  private get currency(): string {
    return this.profile.currency
  }

  /* ------------------------------------------------------------- catalog */

  listItems(filters: { kind?: string; categoryId?: string; search?: string; includeInactive?: boolean } = {}): CatalogItem[] {
    const needle = filters.search?.trim().toLowerCase()
    return this.items.filter((item) => {
      if (!filters.includeInactive && !item.active) return false
      if (filters.kind && item.kind !== filters.kind) return false
      if (filters.categoryId && item.categoryId !== filters.categoryId) return false
      if (needle && !`${item.name} ${item.sku}`.toLowerCase().includes(needle)) return false
      return true
    })
  }

  getItem(id: string): CatalogItem {
    const item = this.items.find((candidate) => candidate.id === id)
    if (!item) throw new MockError(404, 'not_found', 'No such item.')
    return item
  }

  createItem(input: CatalogItemInput): CatalogItem {
    this.counters.item += 1
    const item: CatalogItem = {
      id: `${this.id}-item-${this.counters.item}`,
      sku: input.sku,
      name: input.name,
      description: input.description,
      kind: input.kind,
      unitPrice: money(Number(input.unitPrice.minor), input.unitPrice.currency),
      costPrice: input.costPrice
        ? money(Number(input.costPrice.minor), input.costPrice.currency)
        : null,
      taxBasisPoints: input.taxBasisPoints,
      taxIncluded: input.taxIncluded,
      categoryId: input.categoryId,
      trackStock: input.trackStock,
      active: input.active,
      durationMinutes: input.durationMinutes,
      colour: null,
    }
    this.items = [...this.items, item]
    if (item.trackStock) this.stock.set(item.id, { onHand: 0, reserved: 0, lowStockThreshold: 6 })
    return item
  }

  updateItem(id: string, input: Partial<CatalogItemInput>): CatalogItem {
    const existing = this.getItem(id)
    const updated: CatalogItem = {
      ...existing,
      ...(input.sku !== undefined ? { sku: input.sku } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.unitPrice !== undefined
        ? { unitPrice: money(Number(input.unitPrice.minor), input.unitPrice.currency) }
        : {}),
      ...(input.costPrice !== undefined
        ? {
            costPrice: input.costPrice
              ? money(Number(input.costPrice.minor), input.costPrice.currency)
              : null,
          }
        : {}),
      ...(input.taxBasisPoints !== undefined ? { taxBasisPoints: input.taxBasisPoints } : {}),
      ...(input.taxIncluded !== undefined ? { taxIncluded: input.taxIncluded } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.trackStock !== undefined ? { trackStock: input.trackStock } : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    }
    this.items = this.items.map((item) => (item.id === id ? updated : item))
    return updated
  }

  /** Archives rather than deletes: every order that referenced it must stay
   *  resolvable, and a receipt from last year must still render. */
  archiveItem(id: string): void {
    this.updateItem(id, { active: false })
  }

  /* ------------------------------------------------------------- ordering */

  /* ------------------------------------------------------------- ordering */

  /**
   * Prices a set of lines.
   *
   * Shared by a sale and a parked sale, so a tab settled an hour after it was
   * opened comes out at the figure the customer was shown when it was opened
   * rather than at whatever the catalog says by then.
   */
  private priceOrderLines(
    lines: PlaceOrderInput['lines'],
  ): Array<{ line: OrderLine; amounts: Amounts }> {
    if (lines.length === 0) {
      throw new MockError(422, 'empty_order', 'An order needs at least one line.')
    }

    return lines.map((lineInput, index) => {
      const item = this.getItem(lineInput.itemId)
      const discount = lineInput.discount
        ? money(Number(lineInput.discount.minor), lineInput.discount.currency)
        : undefined

      const amounts = priceLine({
        quantity: lineInput.quantity,
        unitPrice: item.unitPrice,
        taxBasisPoints: item.taxBasisPoints,
        taxIncluded: item.taxIncluded,
        ...(discount ? { discount } : {}),
      })

      return {
        amounts,
        line: {
          id: `line-${index + 1}`,
          itemId: item.id,
          name: item.name,
          quantity: lineInput.quantity,
          unitPrice: item.unitPrice,
          taxBasisPoints: item.taxBasisPoints,
          taxIncluded: item.taxIncluded,
          discount: discount ?? null,
          gross: amounts.gross,
          net: amounts.net,
          tax: amounts.tax,
        },
      }
    })
  }

  /**
   * Refuses a payment that does not cover what is owed.
   *
   * The tenders are summed first, so a sale settled half in cash and half on a
   * card is one payment that covers it rather than two that each fall short.
   */
  private requireCoveringTender(tenders: readonly TenderInput[], due: Money): void {
    const tendered = sumMoney(
      tenders.map((tender) => money(Number(tender.amount.minor), tender.amount.currency)),
      this.currency,
    )
    if (tendered.minor < due.minor) {
      throw new MockError(422, 'insufficient_tender', 'The tender does not cover the total.')
    }
  }

  /** Stock leaving or coming back. sign is -1 for a sale, 1 for a return. */
  private moveStock(lines: readonly OrderLine[], sign: 1 | -1): void {
    for (const line of lines) {
      const row = this.stock.get(line.itemId)
      if (row) row.onHand += sign * line.quantity
    }
  }

  /**
   * Stock spoken for but not gone.
   *
   * A parked sale holds its lines here so a second till cannot sell the same
   * last one, and an inventory count is not short every time a tab is
   * abandoned. Reserving is not selling.
   */
  private reserveStock(lines: readonly OrderLine[], sign: 1 | -1): void {
    for (const line of lines) {
      const row = this.stock.get(line.itemId)
      if (row) row.reserved = Math.max(0, row.reserved + sign * line.quantity)
    }
  }

  placeOrder(input: PlaceOrderInput): Order {
    const priced = this.priceOrderLines(input.lines)
    const total = totalOf(priced.map((entry) => entry.amounts))
    this.requireCoveringTender(input.tenders, total.gross)

    this.counters.order += 1
    const placedAt = new Date().toISOString()
    const customer = input.customerId
      ? this.customers.find((entry) => entry.id === input.customerId)
      : undefined
    const order: Order = {
      id: `${this.id}-order-${this.counters.order}`,
      number: this.orderNumber(),
      placedAt,
      status: 'paid',
      customerId: input.customerId ?? null,
      customerName: customer?.name ?? null,
      discountCode: input.discountCode ?? null,
      discount: null,
      lines: priced.map((entry) => entry.line),
      gross: total.gross,
      net: total.net,
      tax: total.tax,
      tenders: this.buildTenders(input.tenders, total.gross),
      staffId: input.staffId ?? this.staff[0]?.id ?? null,
      note: input.note ?? '',
      tableId: null,
      refunded: zero(this.currency),
      refundedLineIds: [],
    }

    // Stock moves here, on the order, not on a settled card. A cash sale, a
    // comp and an unpaid booking all move stock too, and an earlier draft that
    // decremented on payment.succeeded broke every one of them silently.
    this.moveStock(order.lines, -1)

    this.orders = [order, ...this.orders]
    this.recordPayments(order)
    this.issueDocument(order, 'receipt')
    return order
  }

  /* --------------------------------------------------------- parked sales */

  /**
   * Parks a sale.
   *
   * Rung up and set aside: a tab on a table, or a basket held while somebody
   * goes out to the car for their card. No money has changed hands, so nothing
   * is charged, no document is issued, and it is a sale in no figure anywhere.
   *
   * Parking and paying are separate calls on purpose. A request that can carry
   * tenders is a request that can take money, and the button a cashier presses
   * a hundred times a day must not be one field away from charging a card.
   */
  parkOrder(input: ParkOrderInput): Order {
    const priced = this.priceOrderLines(input.lines)
    const total = totalOf(priced.map((entry) => entry.amounts))

    this.counters.order += 1
    const customer = input.customerId
      ? this.customers.find((entry) => entry.id === input.customerId)
      : undefined
    const order: Order = {
      id: `${this.id}-order-${this.counters.order}`,
      number: this.orderNumber(),
      // While it is parked this is when it was parked, which is what the till
      // shows and what "waiting 40 minutes" is measured against. Settling
      // moves it to the moment it became a sale, so the receipt and the day's
      // takings agree about which day it belongs to.
      placedAt: new Date().toISOString(),
      status: 'open',
      customerId: input.customerId ?? null,
      customerName: customer?.name ?? null,
      discountCode: null,
      discount: null,
      lines: priced.map((entry) => entry.line),
      gross: total.gross,
      net: total.net,
      tax: total.tax,
      tenders: [],
      staffId: input.staffId ?? this.staff[0]?.id ?? null,
      note: input.note ?? '',
      tableId: null,
      refunded: zero(this.currency),
      refundedLineIds: [],
    }

    this.reserveStock(order.lines, 1)
    this.orders = [order, ...this.orders]
    return this.attachTable(order, input.tableId ?? null)
  }

  /** Oldest first. The tab that has been waiting longest is the one somebody
   *  needs to do something about. */
  listParkedOrders(): Order[] {
    return this.orders
      .filter((order) => order.status === 'open')
      .sort((a, b) => a.placedAt.localeCompare(b.placedAt))
  }

  private requireParked(id: string): Order {
    const order = this.orders.find((candidate) => candidate.id === id)
    if (!order) throw new MockError(404, 'not_found', 'No such order.')
    if (order.status !== 'open') {
      throw new MockError(409, 'not_parked', 'That sale has already been settled.')
    }
    return order
  }

  /**
   * Puts a parked sale on a table, or takes it off one.
   *
   * A table holds at most one open tab. Letting a second one attach is how a
   * round of drinks ends up on a bill belonging to the party who left.
   */
  private attachTable(order: Order, tableId: string | null): Order {
    if (order.tableId === tableId) return order

    if (tableId !== null) {
      const table = this.tables.find((entry) => entry.id === tableId)
      if (!table) throw new MockError(404, 'not_found', 'No such table.')
      if (table.orderId !== null && table.orderId !== order.id) {
        throw new MockError(
          409,
          'table_occupied',
          `Table ${table.label} already has an open sale on it.`,
        )
      }
    }

    this.tables = this.tables.map((table) => {
      if (table.id === order.tableId) return { ...table, orderId: null }
      if (table.id === tableId) {
        // A tab exists, so they have ordered. Saying so here saves a server
        // pressing a second button to tell the floor screen what it can see.
        return {
          ...table,
          orderId: order.id,
          status: table.status === 'free' ? 'ordered' : table.status,
        }
      }
      return table
    })

    const updated: Order = { ...order, tableId }
    this.orders = this.orders.map((entry) => (entry.id === order.id ? updated : entry))
    return updated
  }

  /**
   * Replaces what is on a parked sale.
   *
   * The lines arrive whole rather than as a patch. Two tills editing one tab
   * have to land on one answer, and a patch stream lands on the sum of both.
   */
  updateParkedOrder(id: string, input: ParkOrderInput): Order {
    const existing = this.requireParked(id)
    const priced = this.priceOrderLines(input.lines)
    const total = totalOf(priced.map((entry) => entry.amounts))

    // Released and retaken rather than reconciled line by line: the request
    // carries the whole tab, so what it holds is recomputed from scratch.
    this.reserveStock(existing.lines, -1)

    const customer = input.customerId
      ? this.customers.find((entry) => entry.id === input.customerId)
      : undefined
    const updated: Order = {
      ...existing,
      lines: priced.map((entry) => entry.line),
      gross: total.gross,
      net: total.net,
      tax: total.tax,
      note: input.note ?? existing.note,
      ...(input.customerId !== undefined
        ? { customerId: input.customerId, customerName: customer?.name ?? null }
        : {}),
    }

    this.reserveStock(updated.lines, 1)
    this.orders = this.orders.map((entry) => (entry.id === id ? updated : entry))
    return this.attachTable(updated, input.tableId !== undefined ? input.tableId : existing.tableId)
  }

  /** Abandons a parked sale. What it was holding goes back on the shelf. */
  discardParkedOrder(id: string): void {
    const order = this.requireParked(id)
    this.reserveStock(order.lines, -1)
    this.attachTable(order, null)
    this.orders = this.orders.filter((entry) => entry.id !== id)
  }

  /**
   * Takes the money on a parked sale.
   *
   * It stays the same sale it always was: same id, same number, same lines at
   * the same prices. Only now it is paid for.
   */
  settleParkedOrder(id: string, tenders: readonly TenderInput[]): Order {
    const existing = this.requireParked(id)
    this.requireCoveringTender(tenders, existing.gross)

    // Both halves together. A reservation released without the stock moving is
    // a shop that believes it still has what it has just sold.
    this.reserveStock(existing.lines, -1)
    this.moveStock(existing.lines, -1)

    const settled: Order = {
      ...existing,
      status: 'paid',
      placedAt: new Date().toISOString(),
      tenders: this.buildTenders(tenders, existing.gross),
      tableId: null,
    }
    this.orders = this.orders.map((entry) => (entry.id === id ? settled : entry))
    // The tab is closed. The table is left exactly as it was: people sit on
    // after they have paid, and clearing it for them is the till guessing.
    this.tables = this.tables.map((table) =>
      table.orderId === id ? { ...table, orderId: null } : table,
    )
    this.recordPayments(settled)
    this.issueDocument(settled, 'receipt')
    return settled
  }

  /**
   * Turns tender inputs into tenders.
   *
   * Each one is applied against what is still owed, so a split that overshoots
   * cannot record more money than the sale was worth. Only cash can overshoot
   * at all: change comes out of a drawer, and no card gives any back.
   */
  private buildTenders(tenders: readonly TenderInput[], due: Money): Tender[] {
    // A running counter, not an amount: it is compared and decremented, and
    // every value that leaves this function is rebuilt through money().
    let remaining: number = due.minor
    return tenders.map((tender) => {
      const amount = money(Number(tender.amount.minor), tender.amount.currency)
      const applied = Math.min(amount.minor, Math.max(remaining, 0))
      remaining -= applied
      const tenderedAmount = tender.tendered
        ? money(Number(tender.tendered.minor), tender.tendered.currency)
        : null
      const change =
        tenderedAmount && tenderedAmount.minor > applied
          ? money(tenderedAmount.minor - applied, this.currency)
          : null
      this.counters.payment += 1
      return {
        id: `${this.id}-tender-${this.counters.payment}`,
        method: tender.method,
        amount: money(applied, this.currency),
        tendered: tenderedAmount,
        change,
        reference: tender.method === 'cash' ? null : `ref-${this.counters.payment}`,
      }
    })
  }

  private recordPayments(order: Order): void {
    for (const tender of order.tenders) {
      if (tender.method === 'cash') continue
      this.payments = [
        {
          id: `${this.id}-payment-${tender.id}`,
          orderId: order.id,
          amount: tender.amount,
          refunded: zero(this.currency),
          method: tender.method,
          status: 'captured',
          createdAt: order.placedAt,
          providerReference: tender.reference,
        },
        ...this.payments,
      ]
    }
  }

  /**
   * Puts a refund back the way it came.
   *
   * Split across the tenders in proportion to what each of them paid, which is
   * what actually happens: a sale settled half in cash and half on a card
   * refunds half to each. Only the card half leaves a payment record, and only
   * that half is ever a provider's problem.
   */
  private refundPayments(order: Order, amount: Money): void {
    const shares = TenantStore.allocate(
      order.tenders.map((tender) => tender.amount.minor),
      amount.minor,
    )
    order.tenders.forEach((tender, index) => {
      const share = shares[index] ?? 0
      if (share <= 0) return
      const paymentId = `${this.id}-payment-${tender.id}`
      this.payments = this.payments.map((payment) => {
        if (payment.id !== paymentId) return payment
        const refunded = money(payment.refunded.minor + share, this.currency)
        return {
          ...payment,
          refunded,
          status: refunded.minor >= payment.amount.minor ? 'refunded' : payment.status,
        }
      })
    })
  }

  /** The cash share of what has been refunded on a sale. Money goes back the
   *  way it came, so a card sale takes nothing out of the drawer. */
  private cashRefundedOn(order: Order): number {
    if (order.refunded.minor <= 0) return 0
    const shares = TenantStore.allocate(
      order.tenders.map((tender) => tender.amount.minor),
      order.refunded.minor,
    )
    return order.tenders.reduce(
      (sum, tender, index) => (tender.method === 'cash' ? sum + (shares[index] ?? 0) : sum),
      0,
    )
  }

  /**
   * Issues a document and stores it.
   *
   * The artifact is stored, never recomputed. A receipt from last year must
   * re-render exactly as issued even after a price or a tax rate has changed,
   * which is why the URL points at a stored file and not at a render endpoint.
   *
   * The amounts are passed rather than read off the order: a credit note is
   * for what actually went back, which on a partial refund is one line out of
   * four and not the sale.
   */
  private issueDocument(
    order: Order,
    kind: FiscalDocument['kind'],
    amounts: Amounts = { gross: order.gross, net: order.net, tax: order.tax },
  ): FiscalDocument {
    this.counters.document += 1
    const year = new Date().getFullYear()
    const document: FiscalDocument = {
      id: `${this.id}-doc-${this.counters.document}`,
      number: `${year}/${String(this.counters.document).padStart(5, '0')}`,
      kind,
      issuedAt: order.placedAt,
      orderId: order.id,
      gross: amounts.gross,
      net: amounts.net,
      tax: amounts.tax,
      customerName: null,
      reportingStatus: kind === 'receipt' ? 'not_required' : 'queued',
      artifactUrl: `/api/documents/${this.id}-doc-${this.counters.document}/artifact`,
      correctedBy: null,
      corrects: null,
    }
    this.documents = [document, ...this.documents]
    return document
  }

  private orderNumber(): string {
    return `${isoDate(new Date()).replace(/-/g, '')}-${String(this.counters.order).padStart(4, '0')}`
  }

  voidOrder(id: string, _reason: string): Order {
    const order = this.orders.find((candidate) => candidate.id === id)
    if (!order) throw new MockError(404, 'not_found', 'No such order.')
    if (order.status === 'open') {
      throw new MockError(
        409,
        'not_a_sale',
        'That sale is parked and has never been paid for. Discard it instead.',
      )
    }
    if (order.status === 'voided') return order
    // Stock comes back: a void is not a sale that happened.
    this.moveStock(order.lines, 1)
    const voided: Order = { ...order, status: 'voided' }
    this.orders = this.orders.map((candidate) => (candidate.id === id ? voided : candidate))
    return voided
  }

  /**
   * Refunds a whole sale, or named lines of it.
   *
   * A line goes back once. Without that rule, refunding the same coffee twice
   * pays it out twice, returns two of them to stock, and issues two credit
   * notes against a sale that only ever happened once.
   */
  refundOrder(id: string, lineIds?: string[]): Order {
    const order = this.orders.find((candidate) => candidate.id === id)
    if (!order) throw new MockError(404, 'not_found', 'No such order.')
    if (order.status === 'open') {
      throw new MockError(
        409,
        'not_a_sale',
        'That sale is parked and has never been paid for. Discard it instead.',
      )
    }
    if (order.status === 'voided') {
      throw new MockError(409, 'voided', 'A voided sale has nothing to refund.')
    }

    const already = new Set(order.refundedLineIds)

    if (lineIds) {
      const unknown = lineIds.filter((lineId) => !order.lines.some((line) => line.id === lineId))
      if (unknown.length > 0) {
        throw new MockError(422, 'unknown_line', 'That line is not on this sale.')
      }
      const repeated = lineIds.filter((lineId) => already.has(lineId))
      if (repeated.length > 0) {
        throw new MockError(409, 'already_refunded', 'That line has already been refunded.')
      }
    }

    const returning = lineIds
      ? order.lines.filter((line) => lineIds.includes(line.id))
      : order.lines.filter((line) => !already.has(line.id))

    if (returning.length === 0) {
      throw new MockError(409, 'already_refunded', 'This sale has already been refunded in full.')
    }

    // Stock comes back for what was actually handed over, not for the sale.
    this.moveStock(returning, 1)

    const amounts = totalOf(
      returning.map((line) => ({ gross: line.gross, net: line.net, tax: line.tax })),
    )
    const refundedLineIds = [...order.refundedLineIds, ...returning.map((line) => line.id)]

    const refunded: Order = {
      ...order,
      status: refundedLineIds.length === order.lines.length ? 'refunded' : 'partly_refunded',
      refunded: money(order.refunded.minor + amounts.gross.minor, this.currency),
      refundedLineIds,
    }
    this.orders = this.orders.map((candidate) => (candidate.id === id ? refunded : candidate))
    this.refundPayments(refunded, amounts.gross)
    // A correction is a new document referencing the original. The original is
    // never edited and never deleted.
    this.issueDocument(refunded, 'credit_note', amounts)
    return refunded
  }

  /* ------------------------------------------------------------ day close */

  /**
   * What the drawer should hold, and what it was found to hold.
   *
   * Expected cash is built from what was actually tendered in cash, never from
   * the day's total: a card sale never touched the drawer. Refunds come back
   * out of it in the proportion they were paid in.
   */
  dayClose(date: string): DayClose {
    const record = this.dayCloses.get(date)
    let cashTaken = 0
    let cashRefunded = 0
    for (const order of this.orders) {
      if (order.placedAt.slice(0, 10) !== date) continue
      if (order.status === 'open' || order.status === 'voided') continue
      for (const tender of order.tenders) {
        if (tender.method === 'cash') cashTaken += tender.amount.minor
      }
      cashRefunded += this.cashRefundedOn(order)
    }

    // Suggested from the last count when this day has not been closed yet: the
    // float carried over is the figure a cashier is about to type anyway.
    const openingFloat = record?.openingFloat ?? this.lastOpeningFloat()
    const expected = openingFloat + cashTaken - cashRefunded
    const counted = record?.countedCash ?? null

    return {
      date,
      openingFloat: money(openingFloat, this.currency),
      cashTaken: money(cashTaken, this.currency),
      cashRefunded: money(cashRefunded, this.currency),
      expectedCash: money(expected, this.currency),
      countedCash: counted === null ? null : money(counted, this.currency),
      variance: counted === null ? null : money(counted - expected, this.currency),
      countedBy: record?.countedBy ?? null,
      countedAt: record?.countedAt ?? null,
      note: record?.note ?? '',
      closed: record !== undefined,
    }
  }

  private lastOpeningFloat(): number {
    const dates = [...this.dayCloses.keys()].sort()
    const latest = dates[dates.length - 1]
    return latest === undefined ? 0 : (this.dayCloses.get(latest)?.openingFloat ?? 0)
  }

  /** Records a count. Counting again replaces it: a recount is a correction,
   *  and the figure that stands is the one somebody arrived at last. */
  closeDay(input: {
    date: string
    openingFloat: Money
    countedCash: Money
    note?: string
  }): DayClose {
    if (input.openingFloat.minor < 0 || input.countedCash.minor < 0) {
      throw new MockError(422, 'negative_count', 'A drawer cannot hold less than nothing.')
    }
    this.dayCloses.set(input.date, {
      openingFloat: input.openingFloat.minor,
      countedCash: input.countedCash.minor,
      countedBy: this.session.name,
      countedAt: new Date().toISOString(),
      note: input.note ?? '',
    })
    return this.dayClose(input.date)
  }

  /** One order by id, parked or settled. Fetching a tab by its id has to work
   *  even though the list it is missing from deliberately hides it. */
  getOrder(id: string): Order {
    const order = this.orders.find((candidate) => candidate.id === id)
    if (!order) throw new MockError(404, 'not_found', 'No such order.')
    return order
  }

  listOrders(filters: { from?: string; to?: string; status?: string } = {}): Order[] {
    return this.orders
      .filter((order) => {
        // A parked sale is not a sale. It stays out of the order list, out of
        // the day's takings and out of every revenue figure until somebody
        // actually pays for it, and is served from its own endpoint until then.
        if (order.status === 'open' && filters.status !== 'open') return false
        const day = order.placedAt.slice(0, 10)
        if (filters.from && day < filters.from) return false
        if (filters.to && day > filters.to) return false
        if (filters.status && order.status !== filters.status) return false
        return true
      })
      // Newest first, which is what every caller shows and what the seeded
      // history does not produce on its own: it is built by loop index, not
      // by clock.
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
  }

  takings(date: string): Takings {
    const forDay = this.orders.filter(
      (order) =>
        order.placedAt.slice(0, 10) === date &&
        order.status !== 'voided' &&
        // Parked. Nobody has paid for it, so it is in nobody's takings.
        order.status !== 'open',
    )

    const byMethod = new Map<TenderMethod, { amount: number; count: number }>()
    for (const order of forDay) {
      for (const tender of order.tenders) {
        const row = byMethod.get(tender.method) ?? { amount: 0, count: 0 }
        row.amount += tender.amount.minor
        row.count += 1
        byMethod.set(tender.method, row)
      }
    }

    const byBand = new Map<number, { net: number; tax: number; gross: number }>()
    for (const order of forDay) {
      for (const line of order.lines) {
        const row = byBand.get(line.taxBasisPoints) ?? { net: 0, tax: 0, gross: 0 }
        row.net += line.net.minor
        row.tax += line.tax.minor
        row.gross += line.gross.minor
        byBand.set(line.taxBasisPoints, row)
      }
    }

    // What actually went back, not what the status implies. A sale with one
    // line out of four returned is worth exactly that one line, and counting
    // it as nothing or as everything are both wrong.
    const refunded = forDay.reduce((sum, order) => sum + order.refunded.minor, 0)

    return {
      date,
      orderCount: forDay.length,
      gross: money(forDay.reduce((sum, order) => sum + order.gross.minor, 0), this.currency),
      net: money(forDay.reduce((sum, order) => sum + order.net.minor, 0), this.currency),
      tax: money(forDay.reduce((sum, order) => sum + order.tax.minor, 0), this.currency),
      refunded: money(refunded, this.currency),
      byMethod: [...byMethod.entries()].map(([method, row]) => ({
        method,
        amount: money(row.amount, this.currency),
        count: row.count,
      })),
      byTaxBand: [...byBand.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([basisPoints, row]) => ({
          basisPoints,
          net: money(row.net, this.currency),
          tax: money(row.tax, this.currency),
          gross: money(row.gross, this.currency),
        })),
    }
  }

  /* ------------------------------------------------------------ inventory */

  stockLevels(): StockLevel[] {
    return [...this.stock.entries()].map(([itemId, row]) => ({
      itemId,
      itemName: this.items.find((item) => item.id === itemId)?.name ?? itemId,
      onHand: row.onHand,
      reserved: row.reserved,
      lowStockThreshold: row.lowStockThreshold,
    }))
  }

  adjustStock(itemId: string, delta: number, reason: string): StockLevel {
    if (!reason.trim()) {
      throw new MockError(422, 'reason_required', 'An adjustment needs a reason.')
    }
    const row = this.stock.get(itemId)
    if (!row) throw new MockError(404, 'not_found', 'That item does not track stock.')
    row.onHand += delta
    return {
      itemId,
      itemName: this.getItem(itemId).name,
      onHand: row.onHand,
      reserved: row.reserved,
      lowStockThreshold: row.lowStockThreshold,
    }
  }

  /* ------------------------------------------------------------- bookings */

  listBookings(from: string, to: string): Booking[] {
    return this.bookings
      .filter((booking) => {
        const day = booking.startsAt.slice(0, 10)
        return day >= from && day <= to
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }

  createBooking(input: BookingInput): Booking {
    const item = this.getItem(input.itemId)
    const startsAt = new Date(input.startsAt)
    const endsAt = new Date(startsAt.getTime() + (item.durationMinutes || 30) * 60_000)

    // Never double-book a person. The check is on the staff member, not the
    // slot, because two stylists can take the same nine o'clock.
    if (input.staffId) {
      const clash = this.bookings.find(
        (booking) =>
          booking.staffId === input.staffId &&
          booking.status !== 'cancelled' &&
          new Date(booking.startsAt) < endsAt &&
          startsAt < new Date(booking.endsAt),
      )
      if (clash) {
        throw new MockError(409, 'double_booked', 'That person is already booked at this time.')
      }
    }

    this.counters.booking += 1
    const booking: Booking = {
      id: `${this.id}-booking-${this.counters.booking}`,
      reference: `B-${String(this.counters.booking).padStart(4, '0')}`,
      itemId: item.id,
      itemName: item.name,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      staffId: input.staffId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: 'confirmed',
      deposit: input.deposit ? money(Number(input.deposit.minor), input.deposit.currency) : null,
      note: input.note ?? '',
    }
    this.bookings = [...this.bookings, booking]
    return booking
  }

  updateBooking(id: string, patch: Partial<Booking>): Booking {
    const existing = this.bookings.find((booking) => booking.id === id)
    if (!existing) throw new MockError(404, 'not_found', 'No such booking.')
    const updated = { ...existing, ...patch }
    this.bookings = this.bookings.map((booking) => (booking.id === id ? updated : booking))
    return updated
  }

  /* --------------------------------------------------------------- tables */

  listTables(): DiningTable[] {
    return this.tables
  }

  updateTable(
    id: string,
    input: {
      status?: DiningTable['status']
      partySize?: number | null
      staffId?: string | null
    },
  ): DiningTable {
    const existing = this.tables.find((table) => table.id === id)
    if (!existing) throw new MockError(404, 'not_found', 'No such table.')

    // Clearing a table with a tab still on it strands the sale: nothing on the
    // floor screen points at it any more, and the only way back to it is the
    // parked list. Settle it or discard it first.
    if (input.status === 'free' && existing.orderId !== null) {
      throw new MockError(
        409,
        'sale_open',
        `Table ${existing.label} still has an unpaid sale on it.`,
      )
    }

    if (input.partySize !== undefined && input.partySize !== null) {
      if (!Number.isInteger(input.partySize) || input.partySize < 1) {
        throw new MockError(422, 'invalid_party', 'A party is at least one person.')
      }
      // Seating more people than the table holds is a real thing a venue does,
      // so it is allowed, but it must be deliberate rather than a typo.
      if (input.partySize > existing.seats * 2) {
        throw new MockError(422, 'party_too_large', `Table ${existing.label} seats ${existing.seats}.`)
      }
    }

    const clearing = input.status === 'free'
    const seating = input.status === 'seated' && existing.status === 'free'

    const updated: DiningTable = {
      ...existing,
      ...(input.status ? { status: input.status } : {}),
      ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
      // Clearing a table down resets what was on it. Keeping a stale party
      // size and seated time is how a floor screen starts lying about how
      // long people have been waiting.
      ...(clearing ? { partySize: null, seatedAt: null, staffId: null } : {}),
      ...(seating ? { seatedAt: new Date().toISOString() } : {}),
    }
    this.tables = this.tables.map((table) => (table.id === id ? updated : table))
    return updated
  }

  /* ------------------------------------------------------------- settings */

  updateProfile(input: Partial<BusinessProfile>): BusinessProfile {
    this.profile = { ...this.profile, ...input, tenantId: this.profile.tenantId }
    return this.profile
  }

  updateTerms(
    overrides: Record<string, { one: string; other: string } | null>,
  ): Record<string, { one: string; other: string }> {
    const next = { ...this.termOverrides }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete next[key]
      else next[key] = value
    }
    this.termOverrides = next
    return this.termOverrides
  }

  updateNotifications(input: Partial<NotificationPreferences>): NotificationPreferences {
    this.notifications = { ...this.notifications, ...input }
    return this.notifications
  }

  /* ---------------------------------------------------------------- roles */

  /**
   * Role storage, and nothing more.
   *
   * The rules about who may define what live in packages/rbac, which is where
   * the screens read them from. Enforcement is the gateway's job and is not
   * modelled here: this holds a list so the forms have somewhere to submit to.
   */
  listRoles(): RoleDefinition[] {
    return [...BUILT_IN_ROLES, ...this.customRoles]
  }

  createRole(input: { name: string; description: string; permissions: PermissionId[] }): RoleDefinition {
    const id = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!id) throw new MockError(422, 'name_required', 'Give the role a name.')
    if (this.listRoles().some((role) => role.id === id)) {
      throw new MockError(409, 'name_taken', `A role called ${input.name.trim()} already exists.`)
    }
    const role: RoleDefinition = {
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      builtIn: false,
      rank: CUSTOM_ROLE_RANK,
      permissions: input.permissions,
    }
    this.customRoles = [...this.customRoles, role]
    return role
  }

  updateRole(
    id: string,
    input: { name?: string; description?: string; permissions?: PermissionId[] },
  ): RoleDefinition {
    const existing = this.customRoles.find((role) => role.id === id)
    if (!existing) throw new MockError(404, 'not_found', 'No such role.')
    const updated: RoleDefinition = {
      ...existing,
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
    }
    this.customRoles = this.customRoles.map((role) => (role.id === id ? updated : role))
    return updated
  }

  removeRole(id: string): void {
    this.customRoles = this.customRoles.filter((role) => role.id !== id)
  }

  /* ---------------------------------------------------------------- staff */

  /** The signed-in person, as a member of their own team. */
  private get actor(): TeamMember {
    const found = this.staff.find((member) => member.id === this.session.userId)
    if (!found) throw new MockError(403, 'not_a_member', 'You do not belong to this business.')
    return { id: found.id, role: found.role, status: found.status }
  }

  private get team(): TeamMember[] {
    return this.staff.map((member) => ({
      id: member.id,
      role: member.role,
      status: member.status,
    }))
  }

  private findStaff(id: string): StaffMember {
    const found = this.staff.find((member) => member.id === id)
    if (!found) throw new MockError(404, 'not_found', 'No such person.')
    return found
  }

  /** isSelf is resolved against the session here rather than stored, because
   *  it is a property of who is asking, not of the person being described. */
  listStaff(): StaffMember[] {
    return this.staff.map((member) => ({ ...member, isSelf: member.id === this.session.userId }))
  }

  private syncSeats(): void {
    this.entitlement = {
      ...this.entitlement,
      seats: { ...this.entitlement.seats, used: seatsUsed(this.team) },
    }
  }

  inviteStaff(input: { email: string; name: string; role: StaffMember['role'] }): StaffMember {
    if (!can(this.actor.role, 'staff.manage')) {
      throw new MockError(403, 'not_permitted', 'You cannot invite people.')
    }
    if (!canAssignRole(this.actor.role, input.role)) {
      throw new MockError(
        403,
        'outranked',
        `You cannot give someone the ${input.role} role.`,
      )
    }
    const limit = this.entitlement.seats.limit
    if (!canInvite(limit, this.team)) {
      // One seat is one person across both surfaces. CRM Sync refuses the
      // matching workspace member from this same number, which is why the
      // limit lives on the entitlement record and not in a component.
      throw new MockError(
        409,
        'seat_limit_reached',
        `Your plan includes ${limit} staff seats and all of them are in use.`,
      )
    }
    if (this.staff.some((member) => member.email.toLowerCase() === input.email.toLowerCase())) {
      throw new MockError(409, 'already_invited', 'Someone already has an account with that email.')
    }

    const member: StaffMember = {
      id: `${this.id}-staff-${this.counters.staff + 1}`,
      name: input.name,
      email: input.email,
      role: input.role,
      status: 'invited',
      colour: '#71717a',
      invitedAt: new Date().toISOString(),
      lastActiveAt: null,
      isSelf: false,
    }
    this.counters.staff += 1
    this.staff = [...this.staff, member]
    this.syncSeats()
    return member
  }

  /**
   * Changes a role, or deactivates and reactivates an account.
   *
   * The refusals here are the real ones. The dashboard runs the same checks to
   * keep a button out of the way, but a client that skipped them would still
   * be stopped, which is the point of putting them on this side.
   */
  updateStaff(
    id: string,
    input: { role?: StaffMember['role']; status?: 'active' | 'deactivated' },
  ): StaffMember {
    const target = this.findStaff(id)
    const asMember: TeamMember = { id: target.id, role: target.role, status: target.status }

    if (input.role && input.role !== target.role) {
      const check = checkRoleChange({
        actor: this.actor,
        target: asMember,
        nextRole: input.role,
        members: this.team,
      })
      if (!check.allowed) {
        throw new MockError(check.reason === 'last_owner' ? 409 : 403, check.reason!, check.message!)
      }
    }

    if (input.status === 'deactivated' && target.status !== 'deactivated') {
      const check = checkDeactivate({
        actor: this.actor,
        target: asMember,
        members: this.team,
      })
      if (!check.allowed) {
        throw new MockError(check.reason === 'last_owner' ? 409 : 403, check.reason!, check.message!)
      }
    }

    if (input.status === 'active' && target.status === 'deactivated') {
      const limit = this.entitlement.seats.limit
      if (!canInvite(limit, this.team)) {
        throw new MockError(
          409,
          'seat_limit_reached',
          'Reactivating this account needs a seat, and all of them are in use.',
        )
      }
    }

    const updated: StaffMember = {
      ...target,
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
    }
    this.staff = this.staff.map((member) => (member.id === id ? updated : member))
    this.syncSeats()
    return { ...updated, isSelf: updated.id === this.session.userId }
  }

  resendInvitation(id: string): StaffMember {
    const target = this.findStaff(id)
    if (target.status !== 'invited') {
      throw new MockError(422, 'not_invited', 'That account has already been accepted.')
    }
    const updated = { ...target, invitedAt: new Date().toISOString() }
    this.staff = this.staff.map((member) => (member.id === id ? updated : member))
    return updated
  }

  /**
   * Removes an account outright.
   *
   * Only for an invitation nobody accepted. Someone who has traded is
   * deactivated instead: their name is on orders and documents that have to
   * stay resolvable years later.
   */
  removeStaff(id: string): void {
    const target = this.findStaff(id)
    if (!can(this.actor.role, 'staff.manage')) {
      throw new MockError(403, 'not_permitted', 'You cannot remove people.')
    }
    if (target.status !== 'invited') {
      throw new MockError(
        422,
        'has_history',
        'This person has traded on the account. Deactivate them instead, so their orders stay attributed.',
      )
    }
    this.staff = this.staff.filter((member) => member.id !== id)
    this.syncSeats()
  }

  /* -------------------------------------------------------------- history */

  /** Gives every fixture a past, so no screen opens on an empty state that
   *  only exists because nobody has clicked anything yet. */
  private seedHistory(): void {
    const generated = generateHistory({
      tenantId: this.id,
      family: industryProfile(this.profile.industry)?.family ?? 'retail',
      items: this.items,
      staff: this.staff,
      currency: this.currency,
    })

    this.customers = generated.customers
    this.discounts = generated.discounts
    this.loyaltyMembers = generated.loyaltyMembers

    for (const intent of generated.intents) this.placeHistoricOrder(intent)

    // Redemption counts come from the orders that actually used each code,
    // rather than being a separate number that can drift away from them.
    const used = new Map<string, number>()
    for (const order of this.orders) {
      if (!order.discountCode) continue
      used.set(order.discountCode, (used.get(order.discountCode) ?? 0) + 1)
    }
    this.discounts = this.discounts.map((discount) => ({
      ...discount,
      redemptions: used.get(discount.code) ?? 0,
    }))

    // Bookings only matter to a fixture that sells time.
    const services = this.items.filter((item) => item.kind === 'service')
    if (services.length > 0 && this.staff.length > 0) {
      let counter = 0
      for (let dayOffset = -2; dayOffset <= 6; dayOffset++) {
        const perDay = 3 + (Math.abs(dayOffset) % 3)
        for (let index = 0; index < perDay; index++) {
          const service = services[(counter * 3) % services.length]!
          const person = this.staff[counter % this.staff.length]!
          const customer = this.customers[(counter * 5) % Math.max(this.customers.length, 1)]
          const hour = 9 + ((index * 2 + counter) % 8)
          try {
            const booking = this.createBooking({
              itemId: service.id,
              staffId: person.id,
              customerName: customer?.name ?? 'Walk-in',
              customerPhone: customer?.phone ?? '',
              startsAt: at(dayOffset, hour, index % 2 === 0 ? 0 : 30).toISOString(),
            })
            if (dayOffset < 0) {
              this.updateBooking(booking.id, { status: counter % 7 === 0 ? 'no_show' : 'completed' })
            }
          } catch {
            // A clash while seeding just means that slot was taken. Skip it:
            // the double-booking rule is the thing being demonstrated.
          }
          counter += 1
        }
      }
    }
  }

  /**
   * Splits an amount across parts, in proportion to their size.
   *
   * The rounding remainder goes to the largest part, so the shares always add
   * back up to exactly what was split. Two callers depend on that: an
   * order-level discount spread over its lines, where anything else leaves net
   * plus tax no longer equal to gross and a receipt that fails an audit, and a
   * refund spread over the tenders that paid for it, where anything else hands
   * back a forint more or less than was taken.
   */
  private static allocate(weights: readonly number[], amountMinor: number): number[] {
    const total = weights.reduce((sum, value) => sum + value, 0)
    if (total <= 0 || amountMinor <= 0) return weights.map(() => 0)
    const capped = Math.min(amountMinor, total)
    const shares = weights.map((value) => Math.floor((capped * value) / total))
    let remainder = capped - shares.reduce((sum, value) => sum + value, 0)
    if (remainder > 0) {
      let largest = 0
      for (let index = 1; index < weights.length; index++) {
        if ((weights[index] as number) > (weights[largest] as number)) largest = index
      }
      shares[largest] = (shares[largest] as number) + remainder
      remainder = 0
    }
    return shares
  }

  /** What a code takes off a basket, in minor units. */
  private discountAmount(code: string | null, basketGross: number): number {
    if (!code) return 0
    const discount = this.discounts.find((entry) => entry.code === code)
    if (!discount) return 0
    if (discount.minimumBasket && basketGross < discount.minimumBasket.minor) return 0
    switch (discount.kind) {
      case 'percent':
        return Math.round((basketGross * discount.value) / 10_000)
      case 'fixed':
        return Math.min(discount.value, basketGross)
      case 'free_item':
        return 0
    }
  }

  private placeHistoricOrder(intent: OrderIntent): void {
    const resolved = intent.lines
      .map((line) => {
        const item = this.items.find((entry) => entry.id === line.itemId)
        return item ? { item, quantity: line.quantity } : null
      })
      .filter((entry): entry is { item: CatalogItem; quantity: number } => entry !== null)
    if (resolved.length === 0) return

    const preDiscount = resolved.map((entry) => entry.item.unitPrice.minor * entry.quantity)
    const basketGross = preDiscount.reduce((sum, value) => sum + value, 0)
    const discountTotal = this.discountAmount(intent.discountCode, basketGross)
    const spread = TenantStore.allocate(preDiscount, discountTotal)

    const priced = resolved.map((entry, index) => ({
      ...entry,
      amounts: priceLine({
        quantity: entry.quantity,
        unitPrice: entry.item.unitPrice,
        taxBasisPoints: entry.item.taxBasisPoints,
        taxIncluded: entry.item.taxIncluded,
        ...(spread[index] ? { discount: money(spread[index] as number, this.currency) } : {}),
      }),
    }))
    const total = totalOf(priced.map((entry) => entry.amounts))

    this.counters.order += 1
    const customer = intent.customerId
      ? this.customers.find((entry) => entry.id === intent.customerId)
      : undefined

    const order: Order = {
      id: `${this.id}-order-${this.counters.order}`,
      number: `${isoDate(intent.placedAt).replace(/-/g, '')}-${String(this.counters.order).padStart(4, '0')}`,
      placedAt: intent.placedAt.toISOString(),
      status: 'paid',
      customerId: intent.customerId,
      customerName: customer?.name ?? null,
      discountCode: intent.discountCode,
      discount: discountTotal > 0 ? money(discountTotal, this.currency) : null,
      lines: priced.map((entry, index) => ({
        id: `line-${index + 1}`,
        itemId: entry.item.id,
        name: entry.item.name,
        quantity: entry.quantity,
        unitPrice: entry.item.unitPrice,
        taxBasisPoints: entry.item.taxBasisPoints,
        taxIncluded: entry.item.taxIncluded,
        discount: spread[index] ? money(spread[index] as number, this.currency) : null,
        gross: entry.amounts.gross,
        net: entry.amounts.net,
        tax: entry.amounts.tax,
      })),
      gross: total.gross,
      net: total.net,
      tax: total.tax,
      tenders: [
        {
          id: `${this.id}-tender-h${this.counters.order}`,
          method: intent.method,
          amount: total.gross,
          tendered: null,
          change: null,
          reference: intent.method === 'cash' ? null : `ref-h${this.counters.order}`,
        },
      ],
      staffId: intent.staffId,
      note: '',
      tableId: null,
      refunded: zero(this.currency),
      refundedLineIds: [],
    }

    this.moveStock(order.lines, -1)

    this.orders = [order, ...this.orders]
    this.recordPayments(order)
    this.issueDocument(order, 'receipt')
  }

  /* ------------------------------------------------------------ customers */

  listCustomers(filters: { search?: string } = {}): Customer[] {
    const needle = filters.search?.trim().toLowerCase()
    if (!needle) return this.customers
    return this.customers.filter((customer) =>
      `${customer.name} ${customer.email ?? ''} ${customer.phone ?? ''}`
        .toLowerCase()
        .includes(needle),
    )
  }

  getCustomer(id: string): Customer {
    const found = this.customers.find((customer) => customer.id === id)
    if (!found) throw new MockError(404, 'not_found', 'No such customer.')
    return found
  }

  updateCustomer(id: string, input: Partial<Customer>): Customer {
    const existing = this.getCustomer(id)
    const updated = { ...existing, ...input, id: existing.id }
    this.customers = this.customers.map((customer) => (customer.id === id ? updated : customer))
    return updated
  }

  /* ------------------------------------------------------------ discounts */

  createDiscount(input: Omit<Discount, 'id' | 'redemptions' | 'status'> & { status?: Discount['status'] }): Discount {
    const code = input.code.trim().toUpperCase()
    if (!code) throw new MockError(422, 'code_required', 'A code needs something to type.')
    if (this.discounts.some((entry) => entry.code === code)) {
      throw new MockError(409, 'code_taken', `${code} is already in use.`)
    }
    const discount: Discount = {
      ...input,
      code,
      id: `${this.id}-disc-${this.discounts.length + 1}`,
      redemptions: 0,
      status: input.status ?? 'draft',
    }
    this.discounts = [...this.discounts, discount]
    return discount
  }

  updateDiscount(id: string, input: Partial<Discount>): Discount {
    const existing = this.discounts.find((entry) => entry.id === id)
    if (!existing) throw new MockError(404, 'not_found', 'No such discount.')
    const updated = { ...existing, ...input, id: existing.id, redemptions: existing.redemptions }
    this.discounts = this.discounts.map((entry) => (entry.id === id ? updated : entry))
    return updated
  }

  /* -------------------------------------------------------------- loyalty */

  updateLoyaltyProgramme(input: Partial<LoyaltyProgramme>): LoyaltyProgramme {
    this.loyaltyProgramme = { ...this.loyaltyProgramme, ...input }
    return this.loyaltyProgramme
  }
}

/* ------------------------------------------------------------------ facade */

const stores = new Map<string, TenantStore>()

export function storeFor(tenantId: string): TenantStore {
  let store = stores.get(tenantId)
  if (!store) {
    store = new TenantStore(seedFor(tenantId))
    stores.set(tenantId, store)
  }
  return store
}

export function resetStore(tenantId: string): TenantStore {
  stores.delete(tenantId)
  return storeFor(tenantId)
}

export function availableTenants(): Array<{ id: string; label: string; proves: string }> {
  return SEEDS.map((seed) => ({ id: seed.id, label: seed.label, proves: seed.proves }))
}
