/**
 * Subscription tiers.
 *
 * The tier is what a merchant buys and what they are billed for; the module set
 * follows from it. There is no per-module pricing anywhere: entitlement is
 * still evaluated per module, but the module count never enters a price.
 *
 * Enterprise is the exception. Its module set is agreed per customer, which is
 * why it has no fixed contents and no list price: the override is the tier.
 */
import { resolveDependencies, type ModuleId } from './modules'

export const TIER_IDS = ['starter', 'growth', 'max', 'enterprise'] as const
export type TierId = (typeof TIER_IDS)[number]

export interface TierPerk {
  readonly label: string
  /**
   * Shipped as "coming soon" on the tier page rather than deferred silently.
   * The Registry carries this per perk, so the label disappears when the work
   * lands and no release is needed.
   */
  readonly comingSoon?: boolean
}

export interface TierDefinition {
  readonly id: TierId
  readonly name: string
  readonly tagline: string
  /** What this tier grants directly. Dependencies resolve on top. */
  readonly grants: readonly ModuleId[]
  /**
   * Staff seats. One seat is one person across both surfaces, so the limit is
   * enforced twice from this one number: the Staff service refuses the seat,
   * and CRM Sync refuses the matching workspace member. Enforcing it only in
   * the dashboard lets the CRM drift past the tier silently.
   *
   * null means negotiated per customer.
   */
  readonly seats: number | null
  readonly perks: readonly TierPerk[]
  /**
   * Monthly list price in minor units, ex VAT. Placeholders carried over
   * positionally from the marketing site: these are not final, and they are
   * Registry values, so changing one is not a code change.
   *
   * null means no list price: Enterprise is quoted.
   */
  readonly monthlyMinor: number | null
  readonly currency: string
  readonly recommended?: boolean
}

/** Annual billing discount, in percent. A Registry value. */
export const ANNUAL_DISCOUNT_PERCENT = 20

export const TIERS: Readonly<Record<TierId, TierDefinition>> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Everything needed to trade on day one.',
    grants: ['pos_orders', 'bookings', 'payments'],
    seats: 3,
    perks: [{ label: 'Deployment and training included' }],
    monthlyMinor: 8900,
    currency: 'EUR',
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    tagline: 'Add a public storefront and put the ad budget to work.',
    grants: ['pos_orders', 'bookings', 'payments', 'website_storefront', 'marketing_ads'],
    seats: 5,
    perks: [
      { label: 'Deployment and training included' },
      { label: 'Budget reallocation across your ad channels' },
    ],
    monthlyMinor: 18900,
    currency: 'EUR',
    recommended: true,
  },
  max: {
    id: 'max',
    name: 'Max',
    tagline: 'The full platform, with creative generation and your own CRM.',
    grants: [
      'pos_orders',
      'bookings',
      'payments',
      'website_storefront',
      'marketing_ads',
      'ai_creative',
      'crm',
    ],
    seats: 15,
    perks: [
      { label: 'Deployment and training included' },
      { label: 'Budget reallocation across your ad channels' },
      { label: 'Custom domain', comingSoon: true },
    ],
    monthlyMinor: 34900,
    currency: 'EUR',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Provisioned to fit. The override is the tier.',
    grants: [
      'pos_orders',
      'bookings',
      'payments',
      'website_storefront',
      'marketing_ads',
      'ai_creative',
      'crm',
    ],
    seats: null,
    perks: [
      { label: 'Named account team and an SLA' },
      { label: 'Custom integration work' },
      { label: 'Custom domain', comingSoon: true },
      { label: 'API access', comingSoon: true },
    ],
    monthlyMinor: null,
    currency: 'EUR',
  },
}

export function tierDefinition(id: TierId): TierDefinition {
  return TIERS[id]
}

/** Everything a tier resolves to, dependencies included. */
export function tierModules(id: TierId): ModuleId[] {
  return resolveDependencies(TIERS[id].grants)
}

/** What a tier pulls in that its own list does not name. */
export function tierAutoEnabled(id: TierId): ModuleId[] {
  const granted = new Set<ModuleId>(TIERS[id].grants)
  return tierModules(id).filter((moduleId) => !granted.has(moduleId))
}

export function tierRank(id: TierId): number {
  return TIER_IDS.indexOf(id)
}

export function isUpgrade(from: TierId, to: TierId): boolean {
  return tierRank(to) > tierRank(from)
}

/** Applies the annual discount to a monthly figure, in minor units. */
export function annualMonthlyMinor(monthlyMinor: number): number {
  return Math.round((monthlyMinor * (100 - ANNUAL_DISCOUNT_PERCENT)) / 100)
}
