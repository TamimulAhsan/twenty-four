import { describe, expect, it } from 'vitest'
import { containsTradeWord, INDUSTRY_TERMS, resolveTermSet } from '@twentyfour/terms'
import {
  allNavRoutes,
  autoEnabledBy,
  buildNav,
  launchableApps,
  CAPABILITIES,
  dependentsOf,
  INDUSTRY_PROFILES,
  MODULE_IDS,
  MODULES,
  planDowngrade,
  planUpgrade,
  profileCapabilities,
  resolveDependencies,
  resolveEntitlement,
  tierAutoEnabled,
  tierModules,
  TIER_IDS,
  TIERS,
} from './index'

const tenant = (tier: Parameters<typeof resolveEntitlement>[0]['tier'], industry: string) =>
  resolveEntitlement({ tenantId: 't1', tier, industry })

describe('module dependency graph', () => {
  it('pulls in what POS needs to work', () => {
    // An order needs something to price it, something to decrement, and
    // something to charge it to.
    expect(resolveDependencies(['pos_orders'])).toEqual(
      expect.arrayContaining(['catalog', 'inventory', 'payments', 'pos_orders']),
    )
  })

  it('reports what a selection pulled in that nobody asked for', () => {
    expect(autoEnabledBy(['pos_orders']).sort()).toEqual(['catalog', 'inventory', 'payments'])
  })

  it('resolves transitively', () => {
    // AI Creative requires Marketing, which requires Analytics.
    expect(resolveDependencies(['ai_creative'])).toEqual(
      expect.arrayContaining(['advanced_analytics', 'marketing_ads', 'ai_creative']),
    )
  })

  it('has no cycles and no dangling requirement', () => {
    for (const id of MODULE_IDS) {
      for (const required of MODULES[id].requires) {
        expect(MODULE_IDS, `${id} requires unknown ${required}`).toContain(required)
        expect(MODULES[required].requires, `${id} and ${required} require each other`).not.toContain(id)
      }
      expect(() => resolveDependencies([id])).not.toThrow()
    }
  })

  it('knows what breaks if a module is switched off', () => {
    expect(dependentsOf('catalog').sort()).toEqual([
      'bookings',
      'inventory',
      'pos_orders',
      'website_storefront',
    ])
  })

  // Marketing reads booked revenue from the analytics store. It never needed
  // CRM records, and an earlier draft that coupled them forced the wrong tier.
  it('does not couple marketing to CRM', () => {
    expect(MODULES.marketing_ads.requires).not.toContain('crm')
    expect(resolveDependencies(['marketing_ads'])).not.toContain('crm')
  })
})

describe('tiers', () => {
  it('grants the sets the pricing page sells', () => {
    expect(tierModules('starter')).toEqual(
      expect.arrayContaining(['pos_orders', 'bookings', 'payments', 'catalog', 'inventory', 'staff_rota']),
    )
    expect(tierAutoEnabled('starter').sort()).toEqual(['catalog', 'inventory', 'staff_rota'])
    expect(tierAutoEnabled('growth')).toContain('advanced_analytics')
  })

  it('nests, so each tier contains the one below it', () => {
    for (let index = 1; index < TIER_IDS.length; index++) {
      const lower = new Set(tierModules(TIER_IDS[index - 1]!))
      const higher = new Set(tierModules(TIER_IDS[index]!))
      for (const id of lower) {
        expect(higher, `${TIER_IDS[index]} is missing ${id} from ${TIER_IDS[index - 1]}`).toContain(id)
      }
    }
  })

  it('quotes Enterprise rather than listing a price', () => {
    expect(TIERS.enterprise.monthlyMinor).toBeNull()
    expect(TIERS.enterprise.seats).toBeNull()
  })

  it('advertises the unbuilt perks as coming soon rather than hiding them', () => {
    const comingSoon = [...TIERS.max.perks, ...TIERS.enterprise.perks]
      .filter((perk) => perk.comingSoon)
      .map((perk) => perk.label)
    expect(comingSoon).toContain('Custom domain')
    expect(comingSoon).toContain('API access')
  })
})

describe('resolveEntitlement', () => {
  it('is the union of tier modules, profile capabilities and overrides', () => {
    const record = resolveEntitlement({
      tenantId: 't1',
      tier: 'starter',
      industry: 'restaurant',
      overrides: [{ moduleId: 'crm', grantedBy: 'specialist@twentyfour', reason: 'pilot', at: '2026-09-01' }],
    })
    expect(record.modules).toContain('pos_orders')
    expect(record.modules).toContain('crm')
    expect(record.capabilities).toContain('kitchen_display')
  })

  // The profile is not a picker. A restaurant on Starter gets prep screens; a
  // boutique on Max does not, because POS means "register a sale" in both.
  it('switches on a trade capability from the profile, never from the tier', () => {
    expect(tenant('starter', 'restaurant').capabilities).toContain('kitchen_display')
    expect(tenant('max', 'clothing').capabilities).not.toContain('kitchen_display')
  })

  // Prep screens are for anywhere food is made to order. Tables are for
  // anywhere customers sit down, which is a shorter list: a food truck and a
  // caterer both cook, and neither has a floor to manage.
  it('switches on tables only where customers sit down', () => {
    expect(profileCapabilities('restaurant')).toContain('table_management')
    expect(profileCapabilities('bar_pub')).toContain('table_management')
    expect(profileCapabilities('food_truck')).toContain('kitchen_display')
    expect(profileCapabilities('food_truck')).not.toContain('table_management')
    expect(profileCapabilities('catering')).not.toContain('table_management')
    expect(profileCapabilities('clothing')).toEqual([])
  })

  // The registry can carry a capability the product has not shipped. When it
  // does, the profile must not put an empty screen in front of a merchant.
  it('hides any capability this build has not shipped', () => {
    const unshipped = Object.values(CAPABILITIES).filter((entry) => !entry.implemented)
    for (const profile of INDUSTRY_PROFILES) {
      const resolved = profileCapabilities(profile.id)
      for (const entry of unshipped) {
        expect(resolved, `${profile.id} exposes unshipped ${entry.id}`).not.toContain(entry.id)
      }
    }
  })

  it('carries the seat quota from the tier', () => {
    expect(tenant('starter', 'hair_salon').seats.limit).toBe(3)
    expect(tenant('max', 'hair_salon').seats.limit).toBe(15)
    expect(tenant('enterprise', 'hair_salon').seats.limit).toBeNull()
  })
})

describe('planUpgrade', () => {
  it('splits an upgrade into what is granted now and what a specialist must finish', () => {
    const plan = planUpgrade(tenant('starter', 'hair_salon'), 'growth')
    expect(plan.adds).toContain('marketing_ads')
    // Linking an ad account is an OAuth consent screen only the owner can pass.
    expect(plan.queuedToSpecialist).toContain('marketing_ads')
    expect(plan.grantedImmediately).toContain('website_storefront')
    expect(plan.grantedImmediately).not.toContain('marketing_ads')
  })

  it('raises the seat quota', () => {
    const plan = planUpgrade(tenant('starter', 'hair_salon'), 'max')
    expect(plan.seatsBefore).toBe(3)
    expect(plan.seatsAfter).toBe(15)
  })

  it('warns what a downgrade takes away', () => {
    expect(planDowngrade(tenant('max', 'hair_salon'), 'starter')).toEqual(
      expect.arrayContaining(['crm', 'ai_creative', 'marketing_ads', 'website_storefront']),
    )
  })
})

describe('buildNav', () => {
  it('omits a module the tenant does not hold', () => {
    const ids = buildNav(tenant('starter', 'clothing'))
      .flatMap((group) => group.items)
      .map((item) => item.id)
    expect(ids).toContain('pos')
    expect(ids).toContain('inventory')
    expect(ids).not.toContain('crm')
    expect(ids).not.toContain('marketing')
  })

  // The catalog is edited on the device that sells from it, so it belongs to
  // the till and the calendar rather than to the back office.
  it('does not put the catalog in the dashboard', () => {
    const ids = buildNav(tenant('max', 'restaurant'))
      .flatMap((group) => group.items)
      .map((item) => item.id)
    expect(ids).not.toContain('catalog')
  })

  it('shows a pending module as present but not yet usable', () => {
    const record = resolveEntitlement({
      tenantId: 't1',
      tier: 'growth',
      industry: 'hair_salon',
      pending: ['marketing_ads'],
    })
    const marketing = buildNav(record)
      .flatMap((group) => group.items)
      .find((item) => item.id === 'marketing')
    expect(marketing?.pending).toBe(true)
  })

  it('drops an empty group instead of rendering a heading over nothing', () => {
    // A tenant holding nothing but the always-on modules. Every labelled group
    // is gated, so only the unlabelled overview survives.
    const bare = {
      ...tenant('starter', 'clothing'),
      modules: ['identity_tenancy', 'notifications', 'audit_documents'] as const,
    }
    const groups = buildNav(bare as never)
    expect(groups.map((group) => group.id)).toEqual(['insight'])
  })

  it('gates the deeper reporting behind the module that sells it', () => {
    const ids = (tier: 'starter' | 'growth') =>
      buildNav(tenant(tier, 'clothing'))
        .flatMap((group) => group.items)
        .map((item) => item.id)

    // Financials is the trading position, which anyone taking money needs.
    expect(ids('starter')).toContain('financials')
    // Product and customer analysis is what Advanced Analytics is sold for.
    expect(ids('starter')).not.toContain('products')
    expect(ids('starter')).not.toContain('customers')
    expect(ids('growth')).toContain('products')
    expect(ids('growth')).toContain('customers')
  })

  it('gives every tier its discounts and loyalty', () => {
    for (const tier of ['starter', 'growth', 'max'] as const) {
      const ids = buildNav(tenant(tier, 'clothing'))
        .flatMap((group) => group.items)
        .map((item) => item.id)
      expect(ids, tier).toContain('discounts')
      expect(ids, tier).toContain('loyalty')
    }
  })
})

describe('launchable applications', () => {
  // POS and Bookings are separate applications on separate devices, not
  // sections of the back office. The dashboard launches them; it does not
  // contain them.
  it('launches POS and Bookings into their own tab', () => {
    const apps = launchableApps(tenant('starter', 'hair_salon'), {
      pos: 'http://pos.test',
      bookings: 'http://bookings.test',
      crm: 'http://crm.test',
    })
    expect(apps.map((app) => app.id)).toEqual(['pos', 'bookings'])
    expect(apps.find((app) => app.id === 'pos')?.launch).toBe('http://pos.test')
    // A launcher has no internal route: there is nothing to render in place.
    expect(apps.every((app) => app.to === undefined)).toBe(true)
  })

  it('sends CRM out of the app rather than embedding it', () => {
    const crm = launchableApps(tenant('max', 'hair_salon')).find((app) => app.id === 'crm')
    expect(crm?.launch).toBeDefined()
  })

  it('offers no launcher for an application the tenant did not buy', () => {
    const record = resolveEntitlement({ tenantId: 't1', tier: 'starter', industry: 'clothing' })
    const ids = launchableApps(record).map((app) => app.id)
    expect(ids).toContain('pos')
    expect(ids).not.toContain('crm')
  })
})

describe('route vocabulary', () => {
  it('keeps every route semantic', () => {
    for (const route of allNavRoutes()) {
      expect(containsTradeWord(route), `route ${route} carries a trade word`).toBeUndefined()
    }
  })

  it('keeps every module id semantic', () => {
    for (const id of MODULE_IDS) {
      expect(containsTradeWord(id), `module id ${id} carries a trade word`).toBeUndefined()
    }
  })
})

describe('module descriptions', () => {
  // If a description of a core module names a trade, that is the bug. An
  // earlier draft described POS as including a kitchen display and tickets.
  const TRADE_NAMES = ['kitchen', 'restaurant', 'salon', 'hotel', 'menu', 'dish', 'treatment', 'room']

  it('never names a trade in a sold module', () => {
    for (const id of MODULE_IDS) {
      const definition = MODULES[id]
      if (definition.kind !== 'sold') continue
      const text = `${definition.name} ${definition.summary}`.toLowerCase()
      for (const word of TRADE_NAMES) {
        expect(text, `${id} names the trade "${word}"`).not.toMatch(new RegExp(`\\b${word}s?\\b`))
      }
    }
  })
})

describe('profile to vocabulary family', () => {
  // The bug this catches: term sets are keyed by vocabulary family
  // (food_service) and profiles by business type (cafe). Passing a business
  // type straight to the term resolver returns nothing and every tenant
  // silently falls back to the base vocabulary, which reads as "Item" and
  // "Catalog" in a restaurant.
  it('gives every profile a family a term set exists for', () => {
    const families = new Set(Object.keys(INDUSTRY_TERMS))
    for (const profile of INDUSTRY_PROFILES) {
      expect(families, `${profile.id} has family ${profile.family} with no term set`).toContain(
        profile.family,
      )
    }
  })

  const resolveFor = (id: string) => {
    const profile = INDUSTRY_PROFILES.find((entry) => entry.id === id)
    return resolveTermSet({ family: profile?.family, profile: id })
  }

  it('resolves a real business type to its trade vocabulary', () => {
    expect(resolveFor('restaurant').catalog_item.one).toBe('Dish')
    expect(resolveFor('hair_salon').catalog_item.one).toBe('Treatment')
    expect(resolveFor('clothing').catalog_item.one).toBe('Product')
    expect(resolveFor('hotel').catalog_item.one).toBe('Room')
  })

  // A family is a useful approximation and a bad final answer. One
  // food_service set covers restaurants, cafes, bakeries and food trucks, and
  // only the restaurant says Dish, Guest and Server. A bakery inheriting the
  // restaurant's words reads like software that has never seen a bakery.
  it('lets a business type correct a family that is too coarse', () => {
    expect(resolveFor('restaurant').staff_member.other).toBe('Servers')
    expect(resolveFor('cafe').staff_member.other).toBe('Baristas')
    expect(resolveFor('bakery').staff_member.other).toBe('Team')
    expect(resolveFor('bar_pub').staff_member.other).toBe('Bartenders')

    expect(resolveFor('cafe').catalog_item.other).toBe('Items')
    expect(resolveFor('bakery').catalog_item.other).toBe('Products')
    expect(resolveFor('pizzeria').catalog_item.other).toBe('Pizzas')

    // The family is still doing its job where it is right.
    expect(resolveFor('cafe').catalog.one).toBe('Menu')
  })

  it('does not call a bakery customer a guest', () => {
    expect(resolveFor('restaurant').customer.other).toBe('Guests')
    expect(resolveFor('cafe').customer.other).toBe('Customers')
    expect(resolveFor('bakery').customer.other).toBe('Customers')
    expect(resolveFor('gym').customer.other).toBe('Members')
    expect(resolveFor('dental_clinic').customer.other).toBe('Patients')
  })

  it('keeps a tenant override above everything', () => {
    const set = resolveTermSet({
      family: 'food_service',
      profile: 'restaurant',
      overrides: { catalog_item: { one: 'Small plate', other: 'Small plates' } },
    })
    expect(set.catalog_item.other).toBe('Small plates')
    // Untouched keys still come from the profile and the family.
    expect(set.staff_member.other).toBe('Servers')
  })
})

describe('a nav item that needs a permission', () => {
  it('carries it through so the sidebar can filter on it', () => {
    // Entitlement answers what the tenant bought; it cannot answer who is
    // looking. The books are the case that needs both: every tenant taking
    // payments has a ledger, and only an owner or their accountant may read it.
    const money = buildNav(tenant('growth', 'restaurant')).find((group) => group.id === 'money')
    const books = money?.items.find((item) => item.id === 'books')
    expect(books).toBeDefined()
    expect(books?.permission).toBe('reports.financial')
  })

  it('leaves every other item ungated, because the module is the answer there', () => {
    // A tenant that bought POS shows the till to everyone who works there, and
    // the screen decides what they may do on it. Gating more than necessary
    // would hide screens from the people who need them.
    const gated = buildNav(tenant('growth', 'restaurant'))
      .flatMap((group) => group.items)
      .filter((item) => item.permission)
      .map((item) => item.id)
    expect(gated).toEqual(['books'])
  })
})
