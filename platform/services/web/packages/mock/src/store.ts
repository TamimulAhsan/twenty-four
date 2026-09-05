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
  Order,
  OrderLine,
  OnboardingState,
  Payment,
  PlaceOrderInput,
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

  placeOrder(input: PlaceOrderInput): Order {
    if (input.lines.length === 0) {
      throw new MockError(422, 'empty_order', 'An order needs at least one line.')
    }

    const priced: Array<{ line: OrderLine; amounts: Amounts }> = []
    for (const [index, lineInput] of input.lines.entries()) {
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

      priced.push({
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
      })
    }

    const total = totalOf(priced.map((entry) => entry.amounts))
    const tendered = sumMoney(
      input.tenders.map((tender) => money(Number(tender.amount.minor), tender.amount.currency)),
      this.currency,
    )
    if (tendered.minor < total.gross.minor) {
      throw new MockError(422, 'insufficient_tender', 'The tender does not cover the total.')
    }

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
      tenders: this.buildTenders(input, total.gross),
      staffId: input.staffId ?? this.staff[0]?.id ?? null,
      note: input.note ?? '',
    }

    // Stock moves here, on the order, not on a settled card. A cash sale, a
    // comp and an unpaid booking all move stock too, and an earlier draft that
    // decremented on payment.succeeded broke every one of them silently.
    for (const entry of priced) {
      const row = this.stock.get(entry.line.itemId)
      if (row) row.onHand -= entry.line.quantity
    }

    this.orders = [order, ...this.orders]
    this.recordPayments(order)
    this.issueDocument(order, 'receipt')
    return order
  }

  private buildTenders(input: PlaceOrderInput, due: Money): Tender[] {
    // A running counter, not an amount: it is compared and decremented, and
    // every value that leaves this function is rebuilt through money().
    let remaining: number = due.minor
    return input.tenders.map((tender) => {
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
   * Issues a document and stores it.
   *
   * The artifact is stored, never recomputed. A receipt from last year must
   * re-render exactly as issued even after a price or a tax rate has changed,
   * which is why the URL points at a stored file and not at a render endpoint.
   */
  private issueDocument(order: Order, kind: FiscalDocument['kind']): FiscalDocument {
    this.counters.document += 1
    const year = new Date().getFullYear()
    const document: FiscalDocument = {
      id: `${this.id}-doc-${this.counters.document}`,
      number: `${year}/${String(this.counters.document).padStart(5, '0')}`,
      kind,
      issuedAt: order.placedAt,
      orderId: order.id,
      gross: order.gross,
      net: order.net,
      tax: order.tax,
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
    if (order.status === 'voided') return order
    // Stock comes back: a void is not a sale that happened.
    for (const line of order.lines) {
      const row = this.stock.get(line.itemId)
      if (row) row.onHand += line.quantity
    }
    const voided: Order = { ...order, status: 'voided' }
    this.orders = this.orders.map((candidate) => (candidate.id === id ? voided : candidate))
    return voided
  }

  refundOrder(id: string, lineIds?: string[]): Order {
    const order = this.orders.find((candidate) => candidate.id === id)
    if (!order) throw new MockError(404, 'not_found', 'No such order.')
    const refundingAll = !lineIds || lineIds.length === order.lines.length
    for (const line of order.lines) {
      if (lineIds && !lineIds.includes(line.id)) continue
      const row = this.stock.get(line.itemId)
      if (row) row.onHand += line.quantity
    }
    const refunded: Order = { ...order, status: refundingAll ? 'refunded' : 'partly_refunded' }
    this.orders = this.orders.map((candidate) => (candidate.id === id ? refunded : candidate))
    // A correction is a new document referencing the original. The original is
    // never edited and never deleted.
    this.issueDocument(refunded, 'credit_note')
    return refunded
  }

  listOrders(filters: { from?: string; to?: string; status?: string } = {}): Order[] {
    return this.orders
      .filter((order) => {
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
      (order) => order.placedAt.slice(0, 10) === date && order.status !== 'voided',
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

    const refunded = forDay
      .filter((order) => order.status === 'refunded')
      .reduce((sum, order) => sum + order.gross.minor, 0)

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
    input: { status?: DiningTable['status']; partySize?: number | null; staffId?: string | null },
  ): DiningTable {
    const existing = this.tables.find((table) => table.id === id)
    if (!existing) throw new MockError(404, 'not_found', 'No such table.')

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
   * Spreads an order-level discount across its lines.
   *
   * In proportion to each line's value, with the rounding remainder given to
   * the largest line. Applying it to the total instead would leave net plus
   * tax no longer equal to gross, and a receipt that does not add up is a
   * receipt that fails an audit.
   */
  private static spreadDiscount(lineGross: readonly number[], discountMinor: number): number[] {
    const total = lineGross.reduce((sum, value) => sum + value, 0)
    if (total <= 0 || discountMinor <= 0) return lineGross.map(() => 0)
    const capped = Math.min(discountMinor, total)
    const shares = lineGross.map((value) => Math.floor((capped * value) / total))
    let remainder = capped - shares.reduce((sum, value) => sum + value, 0)
    if (remainder > 0) {
      let largest = 0
      for (let index = 1; index < lineGross.length; index++) {
        if ((lineGross[index] as number) > (lineGross[largest] as number)) largest = index
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
    const spread = TenantStore.spreadDiscount(preDiscount, discountTotal)

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
    }

    for (const entry of priced) {
      const row = this.stock.get(entry.item.id)
      if (row) row.onHand -= entry.quantity
    }

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
