/**
 * What the Merchant BFF returns.
 *
 * Amounts arrive as { minor: string, currency: string } and are parsed into
 * Money at the boundary in parse.ts. Nothing downstream sees the wire shape.
 */
import type { Money } from '@twentyfour/money'
import type { CapabilityId, ModuleId, TierId } from '@twentyfour/entitlement'
import type { PartialTermSet } from '@twentyfour/terms'
import type { RoleId } from '@twentyfour/rbac'

/** The role catalog lives in @twentyfour/rbac, alongside what each one grants. */
export type StaffRole = RoleId

export type StaffStatus =
  /** Has accepted and can sign in. Holds a seat. */
  | 'active'
  /** Invited and not yet accepted. Still holds a seat: they will accept. */
  | 'invited'
  /** Cannot sign in. Releases the seat, and keeps their history intact. */
  | 'deactivated'

export interface Session {
  readonly userId: string
  readonly email: string
  readonly name: string
  readonly role: StaffRole
  readonly tenantId: string
}

export interface TaxRate {
  readonly id: string
  readonly label: string
  readonly basisPoints: number
  readonly isDefault: boolean
}

export interface OpeningHours {
  /** 0 is Sunday, matching Date.getDay(). */
  readonly weekday: number
  readonly opens: string | null
  readonly closes: string | null
}

export interface BusinessProfile {
  readonly tenantId: string
  readonly name: string
  /** Business type. Decides capabilities and vocabulary. */
  readonly industry: string
  /** BCP 47. From the profile, never the browser. */
  readonly locale: string
  /** ISO 4217. One per environment, because one environment is one market. */
  readonly currency: string
  readonly timezone: string
  readonly taxRates: readonly TaxRate[]
  readonly openingHours: readonly OpeningHours[]
  readonly pricesIncludeTax: boolean
}

export interface EntitlementPayload {
  readonly tier: TierId
  readonly modules: readonly ModuleId[]
  readonly capabilities: readonly CapabilityId[]
  readonly seats: { readonly limit: number | null; readonly used: number }
  readonly pending: readonly ModuleId[]
}

/**
 * One call at login. Entitlements, term set and profile arrive together
 * because the navigation cannot render without all three, and three round
 * trips to draw a sidebar is three chances to draw it half-built.
 */
export interface Bootstrap {
  readonly session: Session
  readonly profile: BusinessProfile
  readonly entitlement: EntitlementPayload
  readonly termOverrides: PartialTermSet
  readonly onboarding: OnboardingState | null
}

export type OnboardingStepStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  /** Cannot complete unattended: KYC, OAuth consent, hardware pairing. */
  | 'awaiting_specialist'

export interface OnboardingStep {
  readonly id: string
  readonly title: string
  readonly description: string
  /** Which of the 0 / 4 / 12 / 24 hour stages this belongs to. */
  readonly hour: 0 | 4 | 12 | 24
  readonly status: OnboardingStepStatus
  readonly completedAt: string | null
}

export interface OnboardingState {
  readonly startedAt: string
  /** The SLA the guarantee is measured against. */
  readonly dueAt: string
  readonly completedAt: string | null
  readonly steps: readonly OnboardingStep[]
}

export type ItemKind = 'product' | 'service'

export interface CatalogItem {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly description: string
  readonly kind: ItemKind
  readonly unitPrice: Money
  readonly taxBasisPoints: number
  readonly taxIncluded: boolean
  readonly categoryId: string | null
  /**
   * What the item costs you, per unit.
   *
   * null means not recorded, which is not the same as zero: an item with no
   * cost has no margin rather than a margin of 100%, and every analysis that
   * touches margin refuses to guess.
   */
  readonly costPrice: Money | null
  readonly trackStock: boolean
  readonly active: boolean
  /** How long a service occupies a resource. Zero for products. */
  readonly durationMinutes: number
  readonly colour: string | null
}

export interface CatalogCategory {
  readonly id: string
  readonly name: string
  readonly position: number
}

export interface OrderLine {
  readonly id: string
  readonly itemId: string
  readonly name: string
  readonly quantity: number
  readonly unitPrice: Money
  readonly taxBasisPoints: number
  readonly taxIncluded: boolean
  readonly discount: Money | null
  readonly gross: Money
  readonly net: Money
  readonly tax: Money
}

export type TenderMethod = 'cash' | 'card' | 'wallet' | 'transfer' | 'voucher'
export type OrderStatus = 'open' | 'paid' | 'refunded' | 'partly_refunded' | 'voided'

export interface Tender {
  readonly id: string
  /** Method-neutral by contract: POS asks for a payment and gets a result. It
   *  never learns which rail this market answered with. */
  readonly method: TenderMethod
  readonly amount: Money
  readonly tendered: Money | null
  readonly change: Money | null
  readonly reference: string | null
}

export interface Order {
  readonly id: string
  readonly number: string
  readonly placedAt: string
  readonly status: OrderStatus
  /** null for a walk-in. Most sales in most trades are walk-ins, and
   *  pretending otherwise makes every customer figure wrong. */
  readonly customerId: string | null
  readonly customerName: string | null
  readonly discountCode: string | null
  readonly discount: Money | null
  readonly lines: readonly OrderLine[]
  readonly gross: Money
  readonly net: Money
  readonly tax: Money
  readonly tenders: readonly Tender[]
  readonly staffId: string | null
  readonly note: string
}

export interface TakingsBand {
  readonly basisPoints: number
  readonly net: Money
  readonly tax: Money
  readonly gross: Money
}

export interface Takings {
  readonly date: string
  readonly orderCount: number
  readonly gross: Money
  readonly net: Money
  readonly tax: Money
  readonly refunded: Money
  readonly byMethod: ReadonlyArray<{ method: TenderMethod; amount: Money; count: number }>
  readonly byTaxBand: readonly TakingsBand[]
}

export type BookingStatus = 'confirmed' | 'arrived' | 'completed' | 'cancelled' | 'no_show'

export interface Booking {
  readonly id: string
  readonly reference: string
  readonly itemId: string
  readonly itemName: string
  readonly customerName: string
  readonly customerPhone: string
  readonly staffId: string | null
  readonly startsAt: string
  readonly endsAt: string
  readonly status: BookingStatus
  readonly deposit: Money | null
  readonly note: string
}

export interface StaffMember {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly role: StaffRole
  readonly status: StaffStatus
  readonly colour: string
  readonly invitedAt: string | null
  readonly lastActiveAt: string | null
  /** True for the person whose session this is. The rules that stop a team
   *  locking itself out all key off it. */
  readonly isSelf: boolean
}

export interface StockLevel {
  readonly itemId: string
  readonly itemName: string
  readonly onHand: number
  readonly reserved: number
  readonly lowStockThreshold: number | null
}

export type PaymentStatus = 'pending' | 'authorised' | 'captured' | 'refunded' | 'failed'

export interface Payment {
  readonly id: string
  readonly orderId: string | null
  readonly amount: Money
  readonly refunded: Money
  readonly method: TenderMethod
  readonly status: PaymentStatus
  readonly createdAt: string
  /** Whatever this market's provider returned. Never parsed for meaning. */
  readonly providerReference: string | null
}

export type DocumentKind = 'invoice' | 'receipt' | 'credit_note'
/** Generic on purpose: no tax authority is named in shared code. */
export type ReportingStatus = 'not_required' | 'queued' | 'reported' | 'retrying' | 'failed'

export interface FiscalDocument {
  readonly id: string
  /** Issued by this market's implementation. Never generated client-side. */
  readonly number: string
  readonly kind: DocumentKind
  readonly issuedAt: string
  readonly orderId: string | null
  readonly gross: Money
  readonly net: Money
  readonly tax: Money
  readonly customerName: string | null
  readonly reportingStatus: ReportingStatus
  /** The stored artifact. Documents re-render exactly as issued; nothing is
   *  recomputed from current prices or current tax rates. */
  readonly artifactUrl: string
  /** Set on a document that has been corrected by a later one. */
  readonly correctedBy: string | null
  /** Set on a credit note, pointing at what it corrects. */
  readonly corrects: string | null
}

export interface Subscription {
  readonly tier: TierId
  readonly status: 'active' | 'past_due' | 'cancelled'
  readonly billingPeriod: 'monthly' | 'annual'
  readonly amount: Money
  readonly renewsAt: string
  readonly seats: { readonly limit: number | null; readonly used: number }
}

/**
 * A table on the floor.
 *
 * Part of the Kitchen Display and floor-plan capability, which the industry
 * profile switches on for venues where customers sit down. Named for what it
 * is rather than through the term set: this is a distinct capability with its
 * own screen, not one trade's word for a concept every trade shares.
 */
export type TableStatus =
  /** Nobody is on it. */
  | 'free'
  /** A party is seated and has not ordered. */
  | 'seated'
  /** They have ordered and are eating. */
  | 'ordered'
  /** They have asked to pay. */
  | 'bill_requested'

export interface DiningTable {
  readonly id: string
  readonly label: string
  readonly seats: number
  /** Which part of the venue: inside, terrace, bar. */
  readonly area: string
  readonly status: TableStatus
  readonly partySize: number | null
  readonly seatedAt: string | null
  readonly staffId: string | null
}

/* --------------------------------------------------------------- customers */

export interface Customer {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly phone: string | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  /** Whether they agreed to be contacted. A win-back campaign that ignores
   *  this is a legal problem, not a marketing one. */
  readonly marketingConsent: boolean
  readonly note: string
  readonly loyaltyMemberId: string | null
}

/* --------------------------------------------------------------- discounts */

export type DiscountKind =
  /** A share off the basket or the matching lines. */
  | 'percent'
  /** A flat amount off. */
  | 'fixed'
  /** Buy some, get one free. */
  | 'free_item'

export type DiscountStatus = 'draft' | 'scheduled' | 'live' | 'paused' | 'ended'

export type DiscountScope =
  /** Everything in the basket. */
  | 'order'
  /** Only the items in the named categories. */
  | 'category'
  /** Only the named items. */
  | 'item'

export interface Discount {
  readonly id: string
  /** What the customer types or the code on the card. Uppercase by
   *  convention, and unique per tenant. */
  readonly code: string
  readonly name: string
  readonly kind: DiscountKind
  /** Basis points for percent, minor units for fixed, a count for free_item. */
  readonly value: number
  readonly scope: DiscountScope
  readonly appliesTo: readonly string[]
  readonly status: DiscountStatus
  readonly startsAt: string
  readonly endsAt: string | null
  /** Total redemptions allowed. null is unlimited. */
  readonly usageLimit: number | null
  readonly perCustomerLimit: number | null
  /** Below this the code does not apply. Stops a 20% code being used on a
   *  coffee to unlock a discount worth more than the sale. */
  readonly minimumBasket: Money | null
  readonly redemptions: number
  /** Whether it can be combined with another code. */
  readonly stackable: boolean
}

/* ----------------------------------------------------------------- loyalty */

export type LoyaltyKind =
  /** Spend earns points, points buy things. */
  | 'points'
  /** Every nth visit is free. */
  | 'stamps'

export interface LoyaltyTier {
  readonly id: string
  readonly name: string
  /** Lifetime points needed to reach it. */
  readonly threshold: number
  /** Extra earn rate as a multiplier, so 1.5 earns half again. */
  readonly earnMultiplier: number
  readonly perks: readonly string[]
}

export interface LoyaltyProgramme {
  readonly enabled: boolean
  readonly kind: LoyaltyKind
  readonly name: string
  /** Points earned per minor unit spent, as basis points, so 100 means one
   *  point per unit. Integers, because a points balance is a liability. */
  readonly earnBasisPoints: number
  /** What one point is worth when redeemed, in minor units. */
  readonly pointValue: Money
  /** For a stamp card: how many stamps earn the reward. */
  readonly stampsPerReward: number
  readonly tiers: readonly LoyaltyTier[]
}

export interface LoyaltyMember {
  readonly id: string
  readonly customerId: string
  readonly customerName: string
  readonly joinedAt: string
  readonly points: number
  readonly lifetimePoints: number
  readonly redeemedPoints: number
  readonly stamps: number
  readonly tierId: string | null
  readonly lastEarnedAt: string | null
}

/* ---------------------------------------------------------------- settings */

export type NotificationChannel = 'email' | 'sms' | 'push'

export interface NotificationPreferences {
  /** Which channels the business is willing to send on at all. */
  readonly channels: readonly NotificationChannel[]
  /**
   * Nothing goes out between these, local to the tenant's timezone.
   * A booking reminder at two in the morning is worse than none.
   */
  readonly quietFrom: string
  readonly quietTo: string
  readonly bookingReminders: boolean
  readonly receiptByEmail: boolean
  readonly marketing: boolean
}

export interface ProfileInput {
  name?: string
  industry?: string
  timezone?: string
  pricesIncludeTax?: boolean
  openingHours?: OpeningHours[]
  taxRates?: TaxRate[]
}
