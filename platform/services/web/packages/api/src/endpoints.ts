/**
 * The Merchant BFF surface, typed.
 *
 * Written against the contract the gateway will expose, not against the mock.
 * Swapping the mock for the real gateway is deleting the service worker; not
 * one line in this file changes.
 */
import { idempotencyKey, request } from './http'
import {
  parseBooking,
  parseBootstrap,
  parseCatalogItem,
  parseDocument,
  parseList,
  parseOrder,
  parsePayment,
  parseSubscription,
  parseTakings,
} from './parse'
import type {
  Booking,
  BusinessProfile,
  Customer,
  NotificationPreferences,
  ProfileInput,
  DiningTable,
  Discount,
  LoyaltyMember,
  LoyaltyProgramme,
  Bootstrap,
  CatalogCategory,
  CatalogItem,
  FiscalDocument,
  ItemKind,
  OnboardingState,
  Order,
  Payment,
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

export interface SignupInput {
  email: string
  password: string
  businessName: string
  /** Business type, chosen from the selector. Decides everything trade-specific. */
  industry: string
  /** The tier the merchant arrived from the pricing page with. */
  tier: TierId
}

export const auth = {
  session: () => request<Session | null>('/auth/session'),
  login: (input: Credentials) => request<Session>('/auth/login', { method: 'POST', body: input }),
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

export const orders = {
  list: (filters: { from?: string; to?: string; status?: string } = {}) =>
    request<unknown>('/orders', { query: filters }).then((data) =>
      parseList(data, parseOrder, 'orders'),
    ) as Promise<Order[]>,

  detail: (id: string) =>
    request<unknown>(`/orders/${encodeURIComponent(id)}`).then(parseOrder) as Promise<Order>,

  /** Idempotent by contract. A retried checkout without a key is a double
   *  charge, so the key is generated here rather than left to the caller. */
  place: (input: PlaceOrderInput) =>
    request<unknown>('/orders', {
      method: 'POST',
      body: input,
      idempotencyKey: idempotencyKey(),
    }).then(parseOrder) as Promise<Order>,

  void: (id: string, reason: string) =>
    request<unknown>(`/orders/${encodeURIComponent(id)}/void`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: idempotencyKey(),
    }).then(parseOrder) as Promise<Order>,

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
}

/* --------------------------------------------------------------- bookings */

export interface BookingInput {
  itemId: string
  staffId: string | null
  customerName: string
  customerPhone: string
  startsAt: string
  note?: string
  deposit?: { minor: string; currency: string }
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
