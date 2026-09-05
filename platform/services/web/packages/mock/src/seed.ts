/**
 * Three tenants, three trades, three tiers.
 *
 * This is the trade-neutrality test made into data. The same screens are built
 * once and watched under all three: if a POS screen behaves differently when
 * the fixture changes, that is the bug the architecture warns about, and it is
 * visible in the dev toolbar rather than in production.
 *
 * All three are on HUF. The forint has no minor unit in circulation, so its
 * exponent is 0, and any place in the UI that assumed a division by one
 * hundred shows itself immediately.
 */
import { money, type Money } from '@twentyfour/money'
import { resolveEntitlement, type TierId } from '@twentyfour/entitlement'
import type {
  Booking,
  DiningTable,
  BusinessProfile,
  CatalogCategory,
  CatalogItem,
  EntitlementPayload,
  OnboardingState,
  Session,
  StaffMember,
  Subscription,
} from '@twentyfour/api'

const HUF = 'HUF'
const huf = (amount: number): Money => money(amount, HUF)

/** Hungarian VAT bands. Content, not code: another market ships another list. */
const TAX_RATES = [
  { id: 'standard', label: 'Standard 27%', basisPoints: 2700, isDefault: true },
  { id: 'reduced_18', label: 'Reduced 18%', basisPoints: 1800, isDefault: false },
  { id: 'reduced_5', label: 'Reduced 5%', basisPoints: 500, isDefault: false },
]

const WEEK = [
  { weekday: 1, opens: '08:00', closes: '18:00' },
  { weekday: 2, opens: '08:00', closes: '18:00' },
  { weekday: 3, opens: '08:00', closes: '18:00' },
  { weekday: 4, opens: '08:00', closes: '18:00' },
  { weekday: 5, opens: '08:00', closes: '20:00' },
  { weekday: 6, opens: '09:00', closes: '20:00' },
  { weekday: 0, opens: null, closes: null },
]

function tablesFor(tenantId: string): DiningTable[] {
  const plan: Array<[string, number, string]> = [
    ['1', 2, 'Window'], ['2', 2, 'Window'], ['3', 4, 'Window'],
    ['4', 4, 'Inside'], ['5', 4, 'Inside'], ['6', 6, 'Inside'], ['7', 2, 'Inside'],
    ['8', 2, 'Terrace'], ['9', 4, 'Terrace'], ['10', 6, 'Terrace'],
    ['B1', 1, 'Bar'], ['B2', 1, 'Bar'], ['B3', 1, 'Bar'],
  ]
  return plan.map(([label, seats, area], index) => {
    // A few tables start occupied so the floor is not empty on first load.
    const occupied = index === 1 || index === 4 || index === 8
    const waiting = index === 5
    return {
      id: `${tenantId}-table-${label}`,
      label,
      seats,
      area,
      status: waiting ? 'bill_requested' : occupied ? 'ordered' : 'free',
      partySize: waiting || occupied ? Math.max(1, seats - 1) : null,
      seatedAt:
        waiting || occupied
          ? new Date(Date.now() - (20 + index * 7) * 60_000).toISOString()
          : null,
      staffId: waiting || occupied ? `${tenantId}-staff-${(index % 3) + 1}` : null,
      // Seeded tables carry no tab. A tab is a parked sale, and a sale that
      // nothing on the till can open is worse than an empty floor.
      orderId: null,
    }
  })
}

export interface TenantSeed {
  readonly id: string
  readonly label: string
  /** What this fixture is here to prove. Shown in the dev toolbar. */
  readonly proves: string
  readonly profile: BusinessProfile
  readonly session: Session
  readonly entitlement: EntitlementPayload
  readonly subscription: Subscription
  readonly categories: CatalogCategory[]
  readonly items: CatalogItem[]
  readonly staff: StaffMember[]
  readonly bookings: Booking[]
  readonly tables: DiningTable[]
  readonly onboarding: OnboardingState | null
}

interface ItemSpec {
  sku: string
  name: string
  price: number
  category: string
  kind?: 'product' | 'service'
  tax?: number
  minutes?: number
  stock?: number
  colour?: string
  /**
   * What it costs you, as a share of the net price.
   *
   * For goods this is what you paid for it. For a service it is the time it
   * occupies, which is a real cost even though it never appears on an invoice:
   * a salon with no cost on its treatments shows a 100% margin and learns
   * nothing from its own numbers.
   */
  costRatio?: number
}

const DEFAULT_COST_RATIO = { product: 0.42, service: 0.32 } as const

function buildItems(tenantId: string, specs: ItemSpec[]): CatalogItem[] {
  return specs.map((spec, index) => {
    const kind = spec.kind ?? 'product'
    const tax = spec.tax ?? 2700
    // Shelf prices are gross, so cost is taken against the net figure. Costing
    // against gross would build the tax into the margin and overstate it.
    const net = Math.round((spec.price * 10_000) / (10_000 + tax))
    const ratio = spec.costRatio ?? DEFAULT_COST_RATIO[kind]
    return {
    id: `${tenantId}-item-${index + 1}`,
    sku: spec.sku,
    name: spec.name,
    description: '',
    kind,
    unitPrice: huf(spec.price),
    costPrice: huf(Math.round(net * ratio)),
    taxBasisPoints: tax,
    // Hungarian shelf and menu prices are gross: the customer sees the figure
    // with VAT already inside it.
    taxIncluded: true,
    categoryId: spec.category,
    trackStock: spec.stock !== undefined,
    active: true,
    durationMinutes: spec.minutes ?? 0,
    colour: spec.colour ?? null,
    }
  })
}

export const SEED_STOCK: Readonly<Record<string, number>> = {}

function categories(tenantId: string, names: Array<[string, string]>): CatalogCategory[] {
  return names.map(([id, name], index) => ({ id: `${tenantId}-${id}`, name, position: index }))
}

function daysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString()
}

function staffFor(
  tenantId: string,
  people: Array<[string, string, StaffMember['role'], string, StaffMember['status']?]>,
): StaffMember[] {
  return people.map(([name, email, role, colour, status = 'active'], index) => ({
    id: `${tenantId}-staff-${index + 1}`,
    name,
    email,
    role,
    status,
    colour,
    invitedAt: status === 'invited' ? daysAgo(2) : daysAgo(90 - index * 7),
    lastActiveAt: status === 'active' ? daysAgo(index) : null,
    // Recomputed against the session when the list is served. The seed value
    // is a placeholder so the fixture type is complete.
    isSelf: index === 0,
  }))
}

function entitlementFor(tenantId: string, tier: TierId, industry: string, seatsUsed: number): EntitlementPayload {
  const record = resolveEntitlement({ tenantId, tier, industry, seatsUsed })
  return {
    tier: record.tier,
    modules: record.modules,
    capabilities: record.capabilities,
    seats: record.seats,
    pending: record.pending,
  }
}

function subscriptionFor(tier: TierId, amount: number): Subscription {
  return {
    tier,
    status: 'active',
    billingPeriod: 'monthly',
    amount: money(amount, 'EUR'),
    renewsAt: '2026-10-01T00:00:00.000Z',
    seats: { limit: null, used: 0 },
  }
}

function profileFor(
  tenantId: string,
  name: string,
  industry: string,
): BusinessProfile {
  return {
    tenantId,
    name,
    industry,
    locale: 'hu-HU',
    currency: HUF,
    timezone: 'Europe/Budapest',
    taxRates: TAX_RATES,
    openingHours: WEEK,
    pricesIncludeTax: true,
  }
}

/* ------------------------------------------------------------------ cafe */

const cafeId = 'cafe'
const cafeCategories = categories(cafeId, [
  ['coffee', 'Coffee'],
  ['food', 'Food'],
  ['cold', 'Cold drinks'],
  ['bakery', 'Bakery'],
])

const cafe: TenantSeed = {
  id: cafeId,
  label: 'Nyolcas Kávézó',
  proves: 'Kitchen display appears, from the profile and not from a picker. Menu vocabulary.',
  profile: profileFor(cafeId, 'Nyolcas Kávézó', 'cafe'),
  session: {
    userId: 'cafe-staff-1',
    email: 'anna@nyolcaskavezo.hu',
    name: 'Anna Kovács',
    role: 'owner',
    tenantId: cafeId,
  },
  entitlement: entitlementFor(cafeId, 'growth', 'cafe', 4),
  subscription: subscriptionFor('growth', 18900),
  categories: cafeCategories,
  items: buildItems(cafeId, [
    { sku: 'ESP', name: 'Espresso', price: 690, category: `${cafeId}-coffee`, colour: '#8a5a3b' , costRatio: 0.14 },
    { sku: 'CAP', name: 'Cappuccino', price: 990, category: `${cafeId}-coffee`, colour: '#a97155' , costRatio: 0.18 },
    { sku: 'FLW', name: 'Flat white', price: 1090, category: `${cafeId}-coffee`, colour: '#b98a6a' , costRatio: 0.19 },
    { sku: 'FIL', name: 'Filter coffee', price: 850, category: `${cafeId}-coffee`, colour: '#7a4a2b' , costRatio: 0.15 },
    { sku: 'TEA', name: 'Tea', price: 750, category: `${cafeId}-coffee`, colour: '#5f8a4a' , costRatio: 0.09 },
    { sku: 'AVO', name: 'Avocado toast', price: 2490, category: `${cafeId}-food`, tax: 2700 , costRatio: 0.44 },
    { sku: 'BRK', name: 'Breakfast plate', price: 3290, category: `${cafeId}-food` , costRatio: 0.47 },
    { sku: 'SOU', name: 'Soup of the day', price: 1890, category: `${cafeId}-food` , costRatio: 0.33 },
    { sku: 'SND', name: 'Grilled sandwich', price: 2190, category: `${cafeId}-food` , costRatio: 0.41 },
    { sku: 'LEM', name: 'Lemonade', price: 890, category: `${cafeId}-cold`, stock: 40, colour: '#c9a227' , costRatio: 0.26 },
    { sku: 'ICE', name: 'Iced latte', price: 1190, category: `${cafeId}-cold`, colour: '#9c7b5c' , costRatio: 0.22 },
    { sku: 'WAT', name: 'Sparkling water', price: 590, category: `${cafeId}-cold`, stock: 60, tax: 2700 , costRatio: 0.38 },
    { sku: 'CRO', name: 'Croissant', price: 790, category: `${cafeId}-bakery`, stock: 24, tax: 1800 , costRatio: 0.31 },
    { sku: 'CIN', name: 'Cinnamon roll', price: 990, category: `${cafeId}-bakery`, stock: 18, tax: 1800 , costRatio: 0.29 },
    { sku: 'CAK', name: 'Cake slice', price: 1190, category: `${cafeId}-bakery`, stock: 12, tax: 1800 , costRatio: 0.34 },
  ]),
  staff: staffFor(cafeId, [
    ['Anna Kovács', 'anna@nyolcaskavezo.hu', 'owner', '#2f5bff'],
    ['Bence Tóth', 'bence@nyolcaskavezo.hu', 'manager', '#00a96e'],
    ['Dóra Szabó', 'dora@nyolcaskavezo.hu', 'staff', '#f59e0b'],
    ['Máté Nagy', 'mate@nyolcaskavezo.hu', 'staff', '#8557a8', 'invited'],
  ]),
  bookings: [],
  tables: tablesFor(cafeId),
  onboarding: null,
}

/* ----------------------------------------------------------------- salon */

const salonId = 'salon'
const salonCategories = categories(salonId, [
  ['cut', 'Cutting'],
  ['colour', 'Colour'],
  ['care', 'Care'],
])

const salon: TenantSeed = {
  id: salonId,
  label: 'Aranyhíd Szalon',
  proves: 'Starter tier: a short sidebar, no Grow group, and the seat quota bites at three.',
  profile: profileFor(salonId, 'Aranyhíd Szalon', 'hair_salon'),
  session: {
    userId: 'salon-staff-1',
    email: 'eszter@aranyhid.hu',
    name: 'Eszter Balogh',
    role: 'owner',
    tenantId: salonId,
  },
  entitlement: entitlementFor(salonId, 'starter', 'hair_salon', 3),
  subscription: subscriptionFor('starter', 8900),
  categories: salonCategories,
  items: buildItems(salonId, [
    { sku: 'WCUT', name: 'Cut and finish', price: 9500, category: `${salonId}-cut`, kind: 'service', minutes: 60, colour: '#2f5bff' , costRatio: 0.3 },
    { sku: 'MCUT', name: 'Short cut', price: 5500, category: `${salonId}-cut`, kind: 'service', minutes: 30, colour: '#4a67ff' , costRatio: 0.28 },
    { sku: 'FRIN', name: 'Fringe trim', price: 2500, category: `${salonId}-cut`, kind: 'service', minutes: 15, colour: '#7189ff' , costRatio: 0.35 },
    { sku: 'COL', name: 'Full colour', price: 18000, category: `${salonId}-colour`, kind: 'service', minutes: 120, colour: '#8557a8' , costRatio: 0.42 },
    { sku: 'HIGH', name: 'Highlights', price: 22000, category: `${salonId}-colour`, kind: 'service', minutes: 150, colour: '#a06fc9' , costRatio: 0.45 },
    { sku: 'TONE', name: 'Toner', price: 7500, category: `${salonId}-colour`, kind: 'service', minutes: 45, colour: '#b98fd9' , costRatio: 0.33 },
    { sku: 'WASH', name: 'Wash and blow dry', price: 4500, category: `${salonId}-care`, kind: 'service', minutes: 30, colour: '#00a96e' , costRatio: 0.26 },
    { sku: 'TREA', name: 'Deep conditioning', price: 7500, category: `${salonId}-care`, kind: 'service', minutes: 45, colour: '#34d399' , costRatio: 0.31 },
    { sku: 'SHMP', name: 'Shampoo 300ml', price: 4900, category: `${salonId}-care`, stock: 22 , costRatio: 0.48 },
    { sku: 'MASK', name: 'Hair mask', price: 6900, category: `${salonId}-care`, stock: 14 , costRatio: 0.52 },
  ]),
  staff: staffFor(salonId, [
    ['Eszter Balogh', 'eszter@aranyhid.hu', 'owner', '#2f5bff'],
    ['Júlia Varga', 'julia@aranyhid.hu', 'staff', '#00a96e'],
    ['Réka Molnár', 'reka@aranyhid.hu', 'staff', '#f59e0b'],
  ]),
  bookings: [],
  tables: [],
  onboarding: null,
}

/* -------------------------------------------------------------- boutique */

const shopId = 'shop'
const shopCategories = categories(shopId, [
  ['tops', 'Tops'],
  ['bottoms', 'Bottoms'],
  ['outer', 'Outerwear'],
  ['acc', 'Accessories'],
])

const shop: TenantSeed = {
  id: shopId,
  label: 'Váci Butik',
  proves: 'Max tier: the full sidebar including the CRM link out. No kitchen anywhere.',
  profile: profileFor(shopId, 'Váci Butik', 'clothing'),
  session: {
    userId: 'shop-staff-1',
    email: 'gabor@vacibutik.hu',
    name: 'Gábor Fekete',
    role: 'owner',
    tenantId: shopId,
  },
  entitlement: entitlementFor(shopId, 'max', 'clothing', 6),
  subscription: subscriptionFor('max', 34900),
  categories: shopCategories,
  items: buildItems(shopId, [
    { sku: 'TSH', name: 'Cotton t-shirt', price: 8990, category: `${shopId}-tops`, stock: 34 , costRatio: 0.38 },
    { sku: 'SHT', name: 'Oxford shirt', price: 14990, category: `${shopId}-tops`, stock: 21 , costRatio: 0.44 },
    { sku: 'KNT', name: 'Merino knit', price: 24990, category: `${shopId}-tops`, stock: 12 , costRatio: 0.52 },
    { sku: 'JEA', name: 'Straight jeans', price: 22990, category: `${shopId}-bottoms`, stock: 18 , costRatio: 0.47 },
    { sku: 'CHI', name: 'Chinos', price: 18990, category: `${shopId}-bottoms`, stock: 15 , costRatio: 0.43 },
    { sku: 'SKR', name: 'Midi skirt', price: 16990, category: `${shopId}-bottoms`, stock: 9 , costRatio: 0.41 },
    { sku: 'COA', name: 'Wool coat', price: 45990, category: `${shopId}-outer`, stock: 6 , costRatio: 0.55 },
    { sku: 'JKT', name: 'Denim jacket', price: 29990, category: `${shopId}-outer`, stock: 11 , costRatio: 0.49 },
    { sku: 'SCA', name: 'Lambswool scarf', price: 6990, category: `${shopId}-acc`, stock: 27 , costRatio: 0.33 },
    { sku: 'BLT', name: 'Leather belt', price: 9990, category: `${shopId}-acc`, stock: 19 , costRatio: 0.36 },
    { sku: 'BAG', name: 'Canvas tote', price: 7990, category: `${shopId}-acc`, stock: 31 , costRatio: 0.29 },
    { sku: 'SOC', name: 'Wool socks', price: 3490, category: `${shopId}-acc`, stock: 48 , costRatio: 0.31 },
  ]),
  staff: staffFor(shopId, [
    ['Gábor Fekete', 'gabor@vacibutik.hu', 'owner', '#2f5bff'],
    ['Petra Horváth', 'petra@vacibutik.hu', 'manager', '#00a96e'],
    ['Zsolt Kiss', 'zsolt@vacibutik.hu', 'bookkeeper', '#f59e0b'],
    ['Lilla Papp', 'lilla@vacibutik.hu', 'staff', '#8557a8'],
    ['Ádám Simon', 'adam@vacibutik.hu', 'staff', '#ef4444'],
    ['Nóra Rácz', 'nora@vacibutik.hu', 'staff', '#0ea5e9', 'deactivated'],
  ]),
  bookings: [],
  tables: [],
  onboarding: null,
}

export const SEEDS: readonly TenantSeed[] = [cafe, salon, shop]

export const DEFAULT_TENANT = cafeId

export function seedFor(tenantId: string): TenantSeed {
  return SEEDS.find((seed) => seed.id === tenantId) ?? cafe
}
