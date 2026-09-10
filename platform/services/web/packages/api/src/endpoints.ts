/**
 * The Merchant BFF surface, typed.
 *
 * Written against the contract the gateway will expose, not against the mock.
 * Swapping the mock for the real gateway is deleting the service worker; not
 * one line in this file changes.
 */
import { HttpError, idempotencyKey, request } from './http'
import {
  parseBooking,
  parseBootstrap,
  parseCatalogItem,
  parseDayClose,
  parseDocument,
  parseList,
  parseCheckoutResult,
  parseOrder,
  parsePayment,
  parseReportBreakdown,
  parseReportHeatmap,
  parseReportSeries,
  parseReportSummary,
  parseSubscription,
  parseTakings,
  parseTrialBalance,
  parseJournalEntry,
} from './parse'
// The ledger shapes live beside their parsers, because that is where the wire
// is turned into them and a second declaration here would be a second answer.
import type {
  AccountKind,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  TrialBalance,
  TrialBalanceRow,
} from './parse'
import type { Money } from '@twentyfour/money'
import type {
  Booking,
  BusinessProfile,
  Customer,
  DayClose,
  NotificationPreferences,
  ProfileInput,
  DiningTable,
  Discount,
  LoyaltyMember,
  LoyaltyProgramme,
  Bootstrap,
  CatalogCategory,
  CatalogItem,
  CheckoutResult,
  FiscalDocument,
  ItemKind,
  OnboardingState,
  Order,
  Payment,
  ReportBreakdown,
  ReportDimension,
  ReportHeatmap,
  ReportSeries,
  ReportSummary,
  Session,
  StaffMember,
  StockLevel,
  Subscription,
  Takings,
  TenderMethod,
} from './types'
import type { TierId } from '@twentyfour/entitlement'
import type { RoleDefinition } from '@twentyfour/rbac'

/* ---------------------------------------------------------------- session */

export interface Credentials {
  email: string
  password: string
}

/**
 * What the form assumes until Auth says otherwise.
 *
 * The real number is Auth's and only Auth's: it is configurable per
 * deployment, twelve by default and four in development, and it is fetched
 * from `/auth/policy`. This constant is what the field shows in the moment
 * before that answer arrives, or if it never does.
 *
 * It is deliberately lower than the default rather than equal to it. A
 * fallback that is too high refuses a password the deployment would have
 * accepted, and the person on the other side has no way to discover that; a
 * fallback that is too low costs a round trip and comes back as an error under
 * the field. Only one of those two is recoverable.
 */
export const PASSWORD_LENGTH_FALLBACK = 10

/** Auth's password rules, as the gateway reports them. */
export interface PasswordPolicy {
  readonly minPasswordLength: number
}

export interface SignupInput {
  email: string
  password: string
  /** The owner's own name. Signs their sales, and seeds their CRM member. */
  displayName: string
  businessName: string
  /** Business type, chosen from the selector. Decides everything trade-specific. */
  industry: string
  /** The tier the merchant arrived from the pricing page with. */
  tier: TierId
}

/**
 * What signing in answers.
 *
 * One form serves both planes, so the client does not decide where somebody
 * goes: Auth resolves the account from the address and the gateway answers with
 * a destination. The form follows it and never has to know that two planes
 * exist.
 *
 * session is absent for a specialist. They have no session on this origin and
 * never will: their cookie is set by the admin gateway, on its own host, when
 * it redeems the one-time code carried in the redirect.
 */
export interface LoginResult {
  readonly session?: Session
  readonly redirect: string
}

export const auth = {
  session: () => request<Session | null>('/auth/session'),
  /** The rules this deployment enforces, so the form states the same ones. */
  policy: () => request<PasswordPolicy>('/auth/policy'),
  login: (input: Credentials) =>
    request<LoginResult>('/auth/login', { method: 'POST', body: input }),
  signup: (input: SignupInput) => request<Session>('/auth/signup', { method: 'POST', body: input }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  requestPasswordReset: (email: string) =>
    request<void>('/auth/password-reset', { method: 'POST', body: { email } }),
  resetPassword: (token: string, password: string) =>
    request<void>('/auth/password-reset/confirm', { method: 'POST', body: { token, password } }),
}

/** Entitlements, term set and profile in one call. See types.Bootstrap. */
export const bootstrap = () => request<unknown>('/bootstrap').then(parseBootstrap) as Promise<Bootstrap>

/* ------------------------------------------------------------- onboarding */

export const onboarding = {
  get: () => request<OnboardingState>('/onboarding'),
  retryStep: (stepId: string) =>
    request<OnboardingState>(`/onboarding/steps/${encodeURIComponent(stepId)}/retry`, {
      method: 'POST',
    }),
}

/* ---------------------------------------------------------------- catalog */

export interface CatalogFilters {
  kind?: ItemKind
  categoryId?: string
  search?: string
  includeInactive?: boolean
}

export interface CatalogItemInput {
  sku: string
  name: string
  description: string
  kind: ItemKind
  /** Minor units as a string, matching the wire form. */
  unitPrice: { minor: string; currency: string }
  costPrice: { minor: string; currency: string } | null
  taxBasisPoints: number
  taxIncluded: boolean
  categoryId: string | null
  trackStock: boolean
  durationMinutes: number
  active: boolean
}

export const catalog = {
  items: (filters: CatalogFilters = {}) =>
    request<unknown>('/catalog/items', { query: filters as Record<string, string | boolean> }).then(
      (data) => parseList(data, parseCatalogItem, 'catalog items'),
    ) as Promise<CatalogItem[]>,

  item: (id: string) =>
    request<unknown>(`/catalog/items/${encodeURIComponent(id)}`).then(
      parseCatalogItem,
    ) as Promise<CatalogItem>,

  createItem: (input: CatalogItemInput) =>
    request<unknown>('/catalog/items', { method: 'POST', body: input }).then(
      parseCatalogItem,
    ) as Promise<CatalogItem>,

  updateItem: (id: string, input: Partial<CatalogItemInput>) =>
    request<unknown>(`/catalog/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }).then(parseCatalogItem) as Promise<CatalogItem>,

  /** Archives rather than deletes. A sold item must stay resolvable from every
   *  order that ever referenced it. */
  archiveItem: (id: string) =>
    request<void>(`/catalog/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  categories: () => request<CatalogCategory[]>('/catalog/categories'),
}

/* ----------------------------------------------------------------- orders */

export interface OrderLineInput {
  itemId: string
  quantity: number
  /** Minor units as a string. */
  discount?: { minor: string; currency: string }
}

export interface TenderInput {
  method: TenderMethod
  amount: { minor: string; currency: string }
  tendered?: { minor: string; currency: string }
}

export interface PlaceOrderInput {
  lines: OrderLineInput[]
  tenders: TenderInput[]
  note?: string
  staffId?: string
  /** Attaching a sale is what makes every customer figure possible. Most
   *  sales in most trades have nobody attached, and that is honest. */
  customerId?: string
  discountCode?: string
}

/**
 * A sale set aside rather than paid for.
 *
 * The same lines as a sale and no tenders, because there is no money yet. The
 * split is deliberate: a request that can carry tenders is a request that can
 * take payment, and parking must never be one keystroke away from charging.
 */
export interface ParkOrderInput {
  lines: OrderLineInput[]
  note?: string
  staffId?: string
  customerId?: string
  /** The table the tab belongs to, where the venue has a floor. */
  tableId?: string | null
}

export const orders = {
  list: (filters: { from?: string; to?: string; status?: string } = {}) =>
    request<unknown>('/orders', { query: filters }).then((data) =>
      parseList(data, parseOrder, 'orders'),
    ) as Promise<Order[]>,

  detail: (id: string) =>
    request<unknown>(`/orders/${encodeURIComponent(id)}`).then(parseOrder) as Promise<Order>,

  /**
   * Rings up a sale and takes the money for it.
   *
   * Answers with the sale, or with what is standing between the till and one:
   * a payment the customer has to complete somewhere else. In that case the
   * till sends them there and calls this again with the same `key` once the
   * payment settles.
   *
   * The key is the caller's precisely so it can be held across those attempts.
   * A retry that generated a fresh one would be a second checkout, and a second
   * checkout is a second charge. It defaults to a new key for the ordinary case
   * of a sale asked for once.
   */
  place: (input: PlaceOrderInput, key: string = idempotencyKey()) =>
    request<unknown>('/orders', {
      method: 'POST',
      body: input,
      idempotencyKey: key,
    }).then(parseCheckoutResult) as Promise<CheckoutResult>,

  /**
   * Gives back the money of a checkout nobody finished.
   *
   * There is no sale to void: a sale is only written once its money is in. What
   * exists is a payment against a checkout that will now never become one, and
   * leaving it there is leaving a customer out of pocket.
   */
  abandonCheckout: (checkoutId: string, reason?: string) =>
    request<{ released: number }>('/orders/abandon', {
      method: 'POST',
      body: { checkoutId, ...(reason ? { reason } : {}) },
    }),

  void: (id: string, reason: string) =>
    request<unknown>(`/orders/${encodeURIComponent(id)}/void`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: idempotencyKey(),
    }).then(parseOrder) as Promise<Order>,

  /** Omitting lineIds refunds the whole sale. Naming them refunds only those,
   *  and a line already refunded is refused rather than paid out twice. */
  refund: (id: string, input: { lineIds?: string[]; reason: string }) =>
    request<unknown>(`/orders/${encodeURIComponent(id)}/refund`, {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parseOrder) as Promise<Order>,

  takings: (date: string) =>
    request<unknown>('/orders/takings', { query: { date } }).then(
      parseTakings,
    ) as Promise<Takings>,

  /* --------------------------------------------------------- parked sales */

  parked: () =>
    request<unknown>('/orders/parked').then((data) =>
      parseList(data, parseOrder, 'parked orders'),
    ) as Promise<Order[]>,

  park: (input: ParkOrderInput) =>
    request<unknown>('/orders/parked', {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parseOrder) as Promise<Order>,

  /** Replaces what is on a parked sale. The lines are sent whole rather than
   *  as a patch: a tab that is edited on two tills at once must land on one
   *  answer, not on an accumulation of both. */
  updateParked: (id: string, input: ParkOrderInput) =>
    request<unknown>(`/orders/parked/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }).then(parseOrder) as Promise<Order>,

  discardParked: (id: string) =>
    request<void>(`/orders/parked/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Takes the money on a parked sale. It becomes the same sale it always was:
   *  same id, same number, stock moving from reserved to gone. */
  settleParked: (id: string, tenders: TenderInput[], key: string = idempotencyKey()) =>
    request<unknown>(`/orders/parked/${encodeURIComponent(id)}/settle`, {
      method: 'POST',
      body: { tenders },
      idempotencyKey: key,
    }).then(parseCheckoutResult) as Promise<CheckoutResult>,

  /* ----------------------------------------------------------- day close */

  dayClose: (date: string) =>
    request<unknown>('/orders/day-close', { query: { date } }).then(
      parseDayClose,
    ) as Promise<DayClose>,

  closeDay: (input: {
    date: string
    openingFloat: { minor: string; currency: string }
    countedCash: { minor: string; currency: string }
    note?: string
  }) =>
    request<unknown>('/orders/day-close', {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parseDayClose) as Promise<DayClose>,
}

/* --------------------------------------------------------------- bookings */

export interface BookingInput {
  itemId: string
  /**
   * What to book it on. Empty means anybody free, which is what a customer
   * booking online usually wants and what the service resolves for them.
   *
   * A resource rather than a member of staff: a salon books a person, a hotel
   * books a room, a restaurant books a table, and they are one shape.
   */
  resourceId: string | null
  customerName: string
  customerPhone: string
  customerEmail?: string
  startsAt: string
  note?: string
  /** Minor units. Absent means no deposit was asked for, which is not zero. */
  depositMinor?: number
  idempotencyKey?: string
}

/** A free time, as the service worked it out from opening hours minus what is booked. */
export interface Slot {
  readonly startsAt: string
  readonly endsAt: string
  readonly resourceId: string
  readonly resourceName: string
}

/** When a resource is open, as wall clock times in the tenant's own zone. */
export interface OpeningWindow {
  /** ISO weekday: 1 is Monday, matching the analytics heatmap. */
  readonly weekday: number
  readonly opens: string
  readonly closes: string
}

/**
 * Something that can be booked.
 *
 * Not "staff" and not "rooms". A salon books a person, a hotel books a room, a
 * clinic books both and a restaurant books a table; naming the concept after
 * one trade is how a calendar stops working for the other forty. What a
 * merchant sees these called comes from the term set.
 */
export interface BookingResource {
  readonly id: string
  readonly name: string
  /** Set when this resource is a person, so a rota and a calendar can agree. */
  readonly staffId: string | null
  /** How many bookings it holds at once. One for a chair, six for a table. */
  readonly capacity: number
  readonly active: boolean
  readonly opening: readonly OpeningWindow[]
}

export interface ResourceInput {
  id?: string
  name: string
  staffId?: string
  capacity: number
  active: boolean
  opening: readonly OpeningWindow[]
}

export const bookings = {
  range: (from: string, to: string) =>
    request<unknown>('/bookings', { query: { from, to } }).then((data) =>
      parseList(data, parseBooking, 'bookings'),
    ) as Promise<Booking[]>,

  create: (input: BookingInput) =>
    request<unknown>('/bookings', {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parseBooking) as Promise<Booking>,

  update: (id: string, input: Partial<BookingInput> & { status?: Booking['status'] }) =>
    request<unknown>(`/bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }).then(
      parseBooking,
    ) as Promise<Booking>,

  /**
   * Free times for one item on one day.
   *
   * Asked rather than worked out here, and that is the point: availability is
   * the opening pattern minus what is already booked, and a browser computing
   * it would be computing it from a list it fetched a moment ago. The service
   * answers from the same rows it will lock against when the booking is made.
   */
  availability: (itemId: string, date: string, resourceId?: string) =>
    request<Slot[]>('/bookings/availability', { query: { itemId, date, resourceId } }),

  resources: (includeInactive = false) =>
    request<BookingResource[]>('/bookings/resources', {
      query: includeInactive ? { includeInactive: 'true' } : {},
    }),

  /**
   * Creates or replaces a resource, opening pattern and all.
   *
   * The pattern is replaced rather than merged, because a merge cannot express
   * "we no longer work Saturdays": the absence of a window is the fact being
   * stated, and a merge has no way to send an absence.
   */
  putResource: (input: ResourceInput) =>
    request<BookingResource>('/bookings/resources', { method: 'PUT', body: input }),

  /** Deactivates rather than deleting: bookings point at it. */
  removeResource: (id: string) =>
    request<void>(`/bookings/resources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/* -------------------------------------------------------------- inventory */

export const inventory = {
  levels: () => request<StockLevel[]>('/inventory/levels'),
  /** Stock moves on cash sales, comps and manual corrections, not only on a
   *  settled card. The reason is required because the ledger needs it. */
  adjust: (input: { itemId: string; delta: number; reason: string }) =>
    request<StockLevel>('/inventory/adjustments', { method: 'POST', body: input }),
}

/* -------------------------------------------------------------- customers */

export const customers = {
  list: (filters: { search?: string } = {}) =>
    request<Customer[]>('/customers', { query: filters }),
  detail: (id: string) => request<Customer>(`/customers/${encodeURIComponent(id)}`),
  update: (id: string, input: Partial<Pick<Customer, 'name' | 'email' | 'phone' | 'note' | 'marketingConsent'>>) =>
    request<Customer>(`/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
}

/* -------------------------------------------------------------- discounts */

export interface DiscountInput {
  code: string
  name: string
  kind: Discount['kind']
  value: number
  scope: Discount['scope']
  appliesTo: string[]
  startsAt: string
  endsAt: string | null
  usageLimit: number | null
  perCustomerLimit: number | null
  minimumBasket: { minor: string; currency: string } | null
  stackable: boolean
}

export const discounts = {
  list: () => request<Discount[]>('/discounts'),
  create: (input: DiscountInput) =>
    request<Discount>('/discounts', { method: 'POST', body: input }),
  update: (id: string, input: Partial<DiscountInput> & { status?: Discount['status'] }) =>
    request<Discount>(`/discounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
}

/* ---------------------------------------------------------------- loyalty */

export const loyalty = {
  programme: () => request<LoyaltyProgramme>('/loyalty/programme'),
  updateProgramme: (input: Partial<LoyaltyProgramme>) =>
    request<LoyaltyProgramme>('/loyalty/programme', { method: 'PATCH', body: input }),
  members: () => request<LoyaltyMember[]>('/loyalty/members'),
}

/* ----------------------------------------------------------------- tables */

export const tables = {
  list: () => request<DiningTable[]>('/tables'),
  /** Seat a party, move one, or clear a table down. */
  update: (
    id: string,
    input: {
      status?: DiningTable['status']
      partySize?: number | null
      staffId?: string | null
    },
  ) => request<DiningTable>(`/tables/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
}

/* --------------------------------------------------------------- settings */

export const settings = {
  updateProfile: (input: ProfileInput) =>
    request<BusinessProfile>('/settings/profile', { method: 'PATCH', body: input }),

  /**
   * The third layer of the vocabulary cascade.
   *
   * Only the words this tenant wants different from their trade's. Sending a
   * key back to null drops the override and the trade's word returns.
   */
  updateTerms: (overrides: Record<string, { one: string; other: string } | null>) =>
    request<Record<string, { one: string; other: string }>>('/settings/terms', {
      method: 'PATCH',
      body: overrides,
    }),

  notifications: () => request<NotificationPreferences>('/settings/notifications'),
  updateNotifications: (input: Partial<NotificationPreferences>) =>
    request<NotificationPreferences>('/settings/notifications', { method: 'PATCH', body: input }),
}

/* ------------------------------------------------------------------ roles */

export interface RoleInput {
  name: string
  description: string
  permissions: string[]
}

export const roles = {
  /** The four built-ins plus whatever this tenant has defined. */
  list: () => request<RoleDefinition[]>('/roles'),
  create: (input: RoleInput) => request<RoleDefinition>('/roles', { method: 'POST', body: input }),
  update: (id: string, input: Partial<RoleInput>) =>
    request<RoleDefinition>(`/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
  /** Refused while anyone still holds it: reassign them first, or their
   *  access silently becomes nothing. */
  remove: (id: string) => request<void>(`/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/* ------------------------------------------------------------------ staff */

export const staff = {
  list: () => request<StaffMember[]>('/staff'),

  /** Refused at the seat limit. One seat is one person across both surfaces,
   *  so CRM Sync refuses the matching workspace member from the same number. */
  invite: (input: { email: string; name: string; role: StaffMember['role'] }) =>
    request<StaffMember>('/staff/invitations', { method: 'POST', body: input }),

  /**
   * Changes a role or reactivates an account.
   *
   * The server refuses a change that would leave the tenant with no owner, or
   * that hands out standing the caller does not have. The client checks the
   * same rules to keep the button out of the way, but the refusal is the
   * server's.
   */
  update: (id: string, input: { role?: StaffMember['role']; status?: 'active' | 'deactivated' }) =>
    request<StaffMember>(`/staff/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),

  /** Sends the invitation again. Does not consume another seat. */
  resendInvitation: (id: string) =>
    request<StaffMember>(`/staff/${encodeURIComponent(id)}/invitation`, { method: 'POST' }),

  /**
   * Removes an account outright.
   *
   * Only offered for an invitation that was never accepted. Someone who has
   * traded is deactivated instead, because their name is on orders and
   * documents that have to stay resolvable.
   */
  remove: (id: string) => request<void>(`/staff/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/* --------------------------------------------------------------- payments */

export const payments = {
  list: (filters: { from?: string; to?: string; status?: string } = {}) =>
    request<unknown>('/payments', { query: filters }).then((data) =>
      parseList(data, parsePayment, 'payments'),
    ) as Promise<Payment[]>,

  detail: (id: string) =>
    request<unknown>(`/payments/${encodeURIComponent(id)}`).then(parsePayment) as Promise<Payment>,

  refund: (id: string, input: { amount: { minor: string; currency: string }; reason: string }) =>
    request<unknown>(`/payments/${encodeURIComponent(id)}/refunds`, {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parsePayment) as Promise<Payment>,
}

/* -------------------------------------------------------------- documents */

export const documents = {
  list: (filters: { kind?: string; from?: string; to?: string } = {}) =>
    request<unknown>('/documents', { query: filters }).then((data) =>
      parseList(data, parseDocument, 'documents'),
    ) as Promise<FiscalDocument[]>,

  detail: (id: string) =>
    request<unknown>(`/documents/${encodeURIComponent(id)}`).then(
      parseDocument,
    ) as Promise<FiscalDocument>,

  /**
   * The stored artifact, as it was issued.
   *
   * Fetched directly rather than through request(), because it is a document
   * download and not an API call: the body is text, there is no envelope to
   * unwrap, and asking the JSON path to make an exception for one caller would
   * put a content type into every other one.
   */
  artifact: async (id: string): Promise<string> => {
    const response = await fetch(`/api${'/documents/'}${encodeURIComponent(id)}/artifact`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/plain' },
    })
    if (!response.ok) {
      throw new HttpError({
        status: response.status,
        code: 'artifact_unavailable',
        message: 'That document could not be read.',
      })
    }
    return response.text()
  },

  /**
   * A correction is a new document referencing the original. There is no edit
   * and no delete: an issued document is immutable, and the original stays
   * exactly as it was issued.
   */
  correct: (id: string, reason: string) =>
    request<unknown>(`/documents/${encodeURIComponent(id)}/corrections`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: idempotencyKey(),
    }).then(parseDocument) as Promise<FiscalDocument>,
}

/* ---------------------------------------------------------------- billing */

export interface UpgradeResult {
  readonly subscription: Subscription
  /** Provisioned cleanly and usable now. */
  readonly granted: readonly string[]
  /** Paid for, queued to a specialist, and named to the merchant. */
  readonly queued: readonly string[]
}

export const billing = {
  subscription: () =>
    request<unknown>('/billing/subscription').then(parseSubscription) as Promise<Subscription>,

  changeTier: (tier: TierId, billingPeriod: 'monthly' | 'annual') =>
    request<UpgradeResult>('/billing/subscription', {
      method: 'PATCH',
      body: { tier, billingPeriod },
      idempotencyKey: idempotencyKey(),
    }),
}

/* -------------------------------------------------------------- analytics */

/**
 * A window, in the merchant's own days.
 *
 * The time zone travels with it rather than being assumed anywhere downstream.
 * It decides which day a sale belongs to, and the browser is the only
 * participant that knows what the merchant's clock says: bucketing in UTC moves
 * takings between days for every business that trades in the evening.
 */
export interface ReportPeriod {
  /** Inclusive, YYYY-MM-DD. */
  readonly from: string
  /** Inclusive, YYYY-MM-DD. */
  readonly to: string
}

const timeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const window = (period: ReportPeriod) => ({
  from: period.from,
  to: period.to,
  tz: timeZone(),
})

/**
 * Figures, computed where the data is.
 *
 * These read a projection kept by change capture off the operational stores,
 * not the stores themselves. That is why they can aggregate a year without
 * the till noticing, and why every answer carries how fresh it is.
 */
export const analytics = {
  summary: (period: ReportPeriod) =>
    request<unknown>('/analytics/summary', { query: window(period) })
      .then(parseReportSummary) as Promise<ReportSummary>,

  series: (period: ReportPeriod) =>
    request<unknown>('/analytics/series', { query: window(period) })
      .then(parseReportSeries) as Promise<ReportSeries>,

  /** `limit` folds the tail into one remainder row rather than dropping it. */
  breakdown: (period: ReportPeriod, by: ReportDimension, limit?: number) =>
    request<unknown>('/analytics/breakdown', {
      query: { ...window(period), by, ...(limit ? { limit: String(limit) } : {}) },
    }).then(parseReportBreakdown) as Promise<ReportBreakdown>,

  heatmap: (period: ReportPeriod) =>
    request<unknown>('/analytics/heatmap', { query: window(period) })
      .then(parseReportHeatmap) as Promise<ReportHeatmap>,
}

/* ------------------------------------------------------------------- media */

/** What a file is for. The purpose decides what may be uploaded and who may. */
export type MediaPurpose =
  | 'catalog_image'
  | 'brand_logo'
  | 'site_asset'
  | 'attachment'
  | 'ad_creative'

export interface MediaFile {
  readonly id: string
  readonly purpose: MediaPurpose
  readonly filename: string
  readonly contentType: string
  readonly sizeBytes: number
  /**
   * Whether the bytes are actually there. A record exists from the moment a
   * URL is signed, which is before anything has been uploaded, so a file that
   * is not ready is a reservation rather than a file.
   */
  readonly ready: boolean
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly createdAt: string
}

export interface UploadTicket {
  readonly file: MediaFile
  /** Where to PUT the bytes. Expires: it is a capability, not an address. */
  readonly uploadUrl: string
  readonly expiresAt: string
}

/**
 * Files, in three steps, because the bytes never pass through the API.
 *
 * Ask for somewhere to put it, PUT straight to storage, then say it finished.
 * That shape is visible here on purpose: an endpoint that took a multipart body
 * would be an endpoint every product photograph in the market passes through,
 * and it would be the thing that falls over the day somebody uploads a video.
 */
export const media = {
  list: (filters: { purpose?: MediaPurpose; subjectType?: string; subjectId?: string } = {}) =>
    request<MediaFile[]>('/media', { query: filters }),

  detail: (id: string) => request<MediaFile>(`/media/${encodeURIComponent(id)}`),

  /** Step one. Nothing is stored yet. */
  requestUpload: (input: {
    purpose: MediaPurpose
    filename: string
    contentType: string
    sizeBytes: number
    subjectType?: string
    subjectId?: string
  }) => request<UploadTicket>('/media/uploads', { method: 'POST', body: input }),

  /** Step three. The size is taken from the store, not from what we claimed. */
  confirm: (id: string) =>
    request<MediaFile>(`/media/${encodeURIComponent(id)}/confirm`, { method: 'POST' }),

  /**
   * A short-lived link to read one file. Fetched when it is needed rather than
   * held, because it stops working: a signed URL is a capability, and one kept
   * in a cache outlives its usefulness and then renders as a broken image.
   */
  url: (id: string) =>
    request<{ url: string; expiresAt: string }>(`/media/${encodeURIComponent(id)}/url`),

  remove: (id: string) => request<MediaFile>(`/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/**
 * Uploads the bytes, then confirms.
 *
 * Step two is a plain PUT straight at object storage and deliberately does not
 * go through `request`: it carries no session cookie, no credentials and no
 * JSON, because the signature in the URL is the entire authorisation. Sending
 * our cookie to a storage host would be sending it somewhere it does not belong.
 */
export async function uploadFile(
  file: File,
  input: { purpose: MediaPurpose; subjectType?: string; subjectId?: string },
): Promise<MediaFile> {
  const ticket = await media.requestUpload({
    purpose: input.purpose,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  })
  const put = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  })
  if (!put.ok) {
    throw new HttpError({
      status: put.status,
      code: 'upload_failed',
      // Written for a merchant. The storage host's own error body is not, and
      // it is not ours to pass on.
      message: 'That file could not be uploaded. Try again.',
    })
  }
  return media.confirm(ticket.file.id)
}

/* ------------------------------------------------------------------- audit */

export type AuditActor = 'user' | 'staff' | 'system' | 'anonymous'

export interface AuditEntry {
  readonly id: string
  readonly action: string
  readonly actorKind: AuditActor
  readonly actorId: string
  /** The name whoever acted had at the time, not the name they have now. */
  readonly actor: string
  readonly subjectType: string
  readonly subjectId: string
  /** One sentence, written for a person. This is the point of the service. */
  readonly summary: string
  readonly source: string
  readonly occurredAt: string
  readonly detail?: unknown
}

export const audit = {
  list: (filters: { action?: string; actorId?: string; pageToken?: string } = {}) =>
    request<{ entries: AuditEntry[]; nextPageToken: string }>('/audit', { query: filters }),

  /** Everything recorded about one thing, oldest first. */
  trail: (subjectType: string, subjectId: string) =>
    request<AuditEntry[]>(
      `/audit/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
    ),
}

/* ----------------------------------------------------------------- support */

/** Live, stopped by the merchant, or run out on its own. Nobody approves one. */
export type SupportState = 'live' | 'stopped' | 'expired'
/** Read-only is the default, and acting is asked for separately. */
export type SupportScope = 'read_only' | 'act_on_behalf'

export interface SupportAccessRequest {
  readonly id: string
  /** Who looked, by name, and never a shared account. */
  readonly specialist: string
  readonly specialistId: string
  readonly reason: string
  readonly scope: SupportScope
  readonly state: SupportState
  readonly createdAt: string
  /** When it stops working on its own, which is why a forgotten grant is safe. */
  readonly expiresAt?: string
}

export interface SupportAccessSession {
  readonly id: string
  readonly specialist: string
  readonly scope: SupportScope
  readonly active: boolean
  readonly startedAt: string
  readonly expiresAt: string
  readonly endedAt?: string
}

/**
 * The merchant's side of impersonation: what has been looked at, and stopping
 * one that is running.
 *
 * There is no approve. A specialist starts a session without asking, so what
 * this offers is the record and the off switch, and both matter more for
 * nobody having been prompted.
 */
export const support = {
  requests: () => request<SupportAccessRequest[]>('/support/requests'),
  sessions: () => request<SupportAccessSession[]>('/support/sessions'),

  /**
   * Take it back. Ends any session running under the grant, which is the point:
   * a revocation that left somebody still reading would be one in name only.
   */
  revoke: (id: string) =>
    request<{ request: SupportAccessRequest; sessionsEnded: number }>(
      `/support/requests/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}

/* ------------------------------------------------------------------ ledger */

export type { AccountKind, JournalEntry, JournalLine, LedgerAccount, TrialBalance, TrialBalanceRow }

export const ledger = {
  accounts: () => request<LedgerAccount[]>('/ledger/accounts'),

  // Through the parsers, like every other amount: the wire carries minor units
  // as a string so an int64 does not lose digits in JSON, and typing it as
  // Money without parsing would compile while holding the wrong thing.
  trialBalance: (period: { from?: string; to?: string } = {}) =>
    request<unknown>('/ledger/trial-balance', { query: period }).then(parseTrialBalance),

  entries: (filters: { kind?: string; from?: string; to?: string; pageToken?: string } = {}) =>
    request<{ entries: unknown[]; nextPageToken: string }>('/ledger/entries', {
      query: filters,
    }).then((data) => ({
      entries: data.entries.map(parseJournalEntry),
      nextPageToken: data.nextPageToken,
    })),

  account: (code: string, period: { from?: string; to?: string } = {}) =>
    request<{
      account: LedgerAccount
      openingBalance: Money
      closingBalance: Money
      lines: ReadonlyArray<{
        entryId: string
        kind: string
        memo: string
        amount: Money
        runningBalance: Money
        occurredAt: string
      }>
    }>(`/ledger/accounts/${encodeURIComponent(code)}`, { query: period }),
}

/* ----------------------------------------------------------------- kitchen */

export type TicketState = 'waiting' | 'cooking' | 'ready' | 'passed' | 'voided'
export type LineState = 'waiting' | 'claimed' | 'done' | 'voided'

export interface TicketLine {
  readonly id: string
  readonly itemId: string
  /** Copied when the ticket was made: renaming the dish does not rewrite it. */
  readonly name: string
  readonly quantity: number
  readonly note: string
  readonly stationId: string
  readonly stationName: string
  readonly state: LineState
  /** Who is cooking it. This is the whole reason claiming exists. */
  readonly claimedBy: string | null
}

export interface Ticket {
  readonly id: string
  readonly orderId: string
  /** What the till calls the sale, so a cook and a server say the same number. */
  readonly orderNumber: string
  readonly tableLabel: string
  readonly state: TicketState
  readonly note: string
  readonly lines: readonly TicketLine[]
  /**
   * When it was rung up, not when the kitchen read it.
   *
   * The screen colours by how long a table has been waiting, and that clock
   * starts at the till: measuring from when this service happened to consume
   * the event would reset every ticket's age on a restart.
   */
  readonly placedAt: string
  readonly passedAt?: string
}

export interface Station {
  readonly id: string
  readonly name: string
  /** The pass sees every ticket, not only the lines routed to it. */
  readonly isPass: boolean
  readonly active: boolean
}

/**
 * The prep screens.
 *
 * The ticket state lives on the server, which is the point of the service
 * existing at all: two screens in one kitchen have to agree about what is
 * already being cooked, and a bump held in one browser is a bump the other
 * screen never sees.
 */
export const kitchen = {
  tickets: (stationId?: string) =>
    request<Ticket[]>('/kitchen/tickets', { query: stationId ? { stationId } : {} }),

  /** Takes a dish. Refused if somebody already has it, which is the point. */
  claim: (lineId: string) =>
    request<Ticket>(`/kitchen/lines/${encodeURIComponent(lineId)}/claim`, { method: 'POST' }),

  complete: (lineId: string) =>
    request<Ticket>(`/kitchen/lines/${encodeURIComponent(lineId)}/done`, { method: 'POST' }),

  voidLine: (lineId: string, reason: string) =>
    request<Ticket>(`/kitchen/lines/${encodeURIComponent(lineId)}/void`, {
      method: 'POST',
      body: { reason },
    }),

  /** Refused while anything on the ticket is still cooking. */
  pass: (ticketId: string) =>
    request<Ticket>(`/kitchen/tickets/${encodeURIComponent(ticketId)}/pass`, { method: 'POST' }),

  stations: () => request<Station[]>('/kitchen/stations'),

  putStation: (input: { id?: string; name: string; isPass: boolean; active: boolean }) =>
    request<Station>('/kitchen/stations', { method: 'PUT', body: input }),

  removeStation: (id: string) =>
    request<void>(`/kitchen/stations/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** An empty station sends the dish to the pass rather than to nowhere. */
  routeItem: (itemId: string, stationId: string) =>
    request<void>(`/kitchen/routes/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      body: { stationId },
    }),
}
