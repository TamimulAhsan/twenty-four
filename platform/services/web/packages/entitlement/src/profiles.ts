/**
 * Industry profiles.
 *
 * One input decides everything trade-specific: business type. A specialist
 * records it at intake; a self-serve merchant picks it from the selector on the
 * onboarding form. It resolves to a profile carrying four things: trade
 * capabilities, a term set, a catalog template, and document and tax
 * categories.
 *
 * The profile costs nothing and is not chosen from a picker of features. A
 * candy shop buying POS gets a till; a restaurant buying the same POS gets a
 * till and prep screens. POS still means "register a sale" in both.
 */

export const CAPABILITY_IDS = ['kitchen_display', 'table_management'] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export interface CapabilityDefinition {
  readonly id: CapabilityId
  readonly name: string
  readonly summary: string
  /** The module it lives inside. It is never sold separately from this. */
  readonly partOf: string
  /**
   * Whether this build implements it. A capability the profile switches on but
   * the product has not shipped must not put an empty screen in the navigation.
   */
  readonly implemented: boolean
  readonly icon: string
}

export const CAPABILITIES: Readonly<Record<CapabilityId, CapabilityDefinition>> = {
  kitchen_display: {
    id: 'kitchen_display',
    name: 'Kitchen display',
    summary: 'Order lines on prep screens, course timing, and bump when done.',
    partOf: 'pos_orders',
    implemented: true,
    icon: 'ChefHat',
  },
  table_management: {
    id: 'table_management',
    name: 'Tables and floor plan',
    summary: 'Table state, party size, and moving a check between tables.',
    partOf: 'pos_orders',
    implemented: true,
    icon: 'Grid3x3',
  },
}

/** The vocabulary family a profile draws its term set from. */
export type TermFamily = 'food_service' | 'salon' | 'retail' | 'accommodation' | 'trades'

export interface IndustryProfile {
  readonly id: string
  readonly name: string
  /** Groups the selector. Presentation only. */
  readonly family: TermFamily
  /** Switched on by the profile. Nobody chooses these. */
  readonly capabilities: readonly CapabilityId[]
  /** Seeds the catalog at provisioning. */
  readonly catalogTemplate: string
}

function profile(
  id: string,
  name: string,
  family: TermFamily,
  capabilities: CapabilityId[] = [],
): IndustryProfile {
  return { id, name, family, capabilities, catalogTemplate: id }
}

const KITCHEN: CapabilityId[] = ['kitchen_display']
const KITCHEN_AND_TABLES: CapabilityId[] = ['kitchen_display', 'table_management']

/**
 * The business type selector.
 *
 * Adding trade 41 is an entry here plus a term set. No release, no new service,
 * no code path.
 */
export const INDUSTRY_PROFILES: readonly IndustryProfile[] = [
  profile('restaurant', 'Restaurant', 'food_service', KITCHEN_AND_TABLES),
  profile('cafe', 'Cafe or coffee shop', 'food_service', KITCHEN_AND_TABLES),
  profile('bakery', 'Bakery', 'food_service', KITCHEN),
  profile('pizzeria', 'Pizzeria', 'food_service', KITCHEN_AND_TABLES),
  profile('bar_pub', 'Bar or pub', 'food_service', KITCHEN_AND_TABLES),
  profile('food_truck', 'Food truck', 'food_service', KITCHEN),
  profile('catering', 'Catering', 'food_service', KITCHEN),
  profile('ice_cream', 'Ice cream or dessert shop', 'food_service'),

  profile('hair_salon', 'Hair salon', 'salon'),
  profile('barbershop', 'Barbershop', 'salon'),
  profile('nail_salon', 'Nail salon', 'salon'),
  profile('beauty_salon', 'Beauty salon', 'salon'),
  profile('spa', 'Spa', 'salon'),
  profile('massage', 'Massage therapy', 'salon'),
  profile('tattoo_studio', 'Tattoo or piercing studio', 'salon'),
  profile('barber_academy', 'Training academy', 'salon'),

  profile('clothing', 'Clothing and fashion', 'retail'),
  profile('grocery', 'Grocery', 'retail'),
  profile('convenience', 'Convenience store', 'retail'),
  profile('bookshop', 'Bookshop', 'retail'),
  profile('florist', 'Florist', 'retail'),
  profile('pharmacy', 'Pharmacy', 'retail'),
  profile('electronics', 'Electronics', 'retail'),
  profile('pet_shop', 'Pet shop', 'retail'),
  profile('gift_shop', 'Gift shop', 'retail'),
  profile('jewellery', 'Jewellery', 'retail'),
  profile('sports_shop', 'Sports and outdoor', 'retail'),
  profile('hardware', 'Hardware and DIY', 'retail'),

  profile('hotel', 'Hotel', 'accommodation'),
  profile('guesthouse', 'Guesthouse or B&B', 'accommodation'),
  profile('hostel', 'Hostel', 'accommodation'),
  profile('apartment_rental', 'Short-stay apartments', 'accommodation'),

  profile('plumber', 'Plumbing', 'trades'),
  profile('electrician', 'Electrical', 'trades'),
  profile('cleaning', 'Cleaning services', 'trades'),
  profile('garage', 'Garage and auto repair', 'trades'),
  profile('landscaping', 'Landscaping and garden', 'trades'),
  profile('photographer', 'Photography', 'trades'),
  profile('gym', 'Gym or fitness studio', 'salon'),
  profile('yoga_studio', 'Yoga or pilates studio', 'salon'),
  profile('dental_clinic', 'Dental clinic', 'salon'),
  profile('veterinary', 'Veterinary clinic', 'salon'),
  profile('physiotherapy', 'Physiotherapy', 'salon'),
]

const BY_ID = new Map(INDUSTRY_PROFILES.map((entry) => [entry.id, entry]))

export function industryProfile(id: string | undefined): IndustryProfile | undefined {
  return id ? BY_ID.get(id) : undefined
}

/** Capabilities a profile switches on, filtered to what this build ships. */
export function profileCapabilities(id: string | undefined): CapabilityId[] {
  const found = industryProfile(id)
  if (!found) return []
  return found.capabilities.filter((capability) => CAPABILITIES[capability].implemented)
}

export const FAMILY_LABELS: Readonly<Record<TermFamily, string>> = {
  food_service: 'Food and drink',
  salon: 'Health, beauty and wellbeing',
  retail: 'Retail',
  accommodation: 'Accommodation',
  trades: 'Trades and services',
}

/** Grouped for the business type selector on the onboarding form. */
export function profilesByFamily(): Array<{
  family: TermFamily
  label: string
  profiles: IndustryProfile[]
}> {
  const families: TermFamily[] = ['food_service', 'salon', 'retail', 'accommodation', 'trades']
  return families.map((family) => ({
    family,
    label: FAMILY_LABELS[family],
    profiles: INDUSTRY_PROFILES.filter((entry) => entry.family === family),
  }))
}

export function searchProfiles(query: string): IndustryProfile[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...INDUSTRY_PROFILES]
  return INDUSTRY_PROFILES.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) || entry.id.replace(/_/g, ' ').includes(needle),
  )
}
