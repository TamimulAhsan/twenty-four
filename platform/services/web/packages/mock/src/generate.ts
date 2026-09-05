/**
 * Ninety days of trade, generated so the analytics screens have something true
 * to say.
 *
 * The shape matters more than the volume. Real trade is lumpy: a handful of
 * customers are worth more than the bottom half put together, most sales are
 * walk-ins nobody named, mornings are not like evenings, and a proportion of
 * regulars quietly stop coming. A fixture with a uniform spread makes every
 * segmentation screen look broken, because nothing separates.
 */
import type {
  CatalogItem,
  Customer,
  Discount,
  LoyaltyMember,
  LoyaltyProgramme,
  StaffMember,
  TenderMethod,
} from '@twentyfour/api'
import { money } from '@twentyfour/money'
import { createRandom, type Random } from './random'
import { emailFor, FAMILY_NAMES, GIVEN_NAMES, phoneFor } from './people'

export const HISTORY_DAYS = 90

export interface OrderIntent {
  readonly placedAt: Date
  readonly customerId: string | null
  readonly discountCode: string | null
  readonly method: TenderMethod
  readonly staffId: string | null
  readonly lines: ReadonlyArray<{ itemId: string; quantity: number }>
}

export interface TradeShape {
  /** How many customers ever give a name. The rest are walk-ins, and in most
   *  trades that is most of them. */
  readonly attributionRate: number
  /** Orders on an average day. */
  readonly ordersPerDay: number
  /** Relative weight per hour of the day, index 0 is midnight. */
  readonly hourWeights: readonly number[]
  /** Relative weight per weekday, index 0 is Sunday. */
  readonly weekdayWeights: readonly number[]
  /** Typical line count per order, as weights over 1, 2, 3, 4 lines. */
  readonly basketWeights: readonly number[]
  readonly customerCount: number
}

const NIGHT = 0
const w = (...values: number[]) => values

/** Hour and weekday curves are the difference between a heatmap that teaches a
 *  rota and one that is just noise. */
export const TRADE_SHAPES: Readonly<Record<string, TradeShape>> = {
  food_service: {
    attributionRate: 0.34,
    ordersPerDay: 52,
    // Two peaks: the morning rush and lunch, with a long quiet afternoon.
    hourWeights: w(
      NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, 2, 9, 18, 14, 8, 11,
      16, 13, 6, 5, 5, 6, 4, 2, 1, NIGHT, NIGHT, NIGHT,
    ),
    weekdayWeights: w(6, 10, 10, 10, 11, 13, 11),
    basketWeights: w(38, 34, 19, 9),
    customerCount: 260,
  },
  salon: {
    // Almost everything is booked, so almost everything has a name on it.
    attributionRate: 0.88,
    ordersPerDay: 14,
    hourWeights: w(
      NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, 1, 6, 10, 11, 10,
      8, 9, 11, 11, 10, 9, 6, 3, 1, NIGHT, NIGHT, NIGHT,
    ),
    weekdayWeights: w(1, 9, 10, 11, 12, 14, 12),
    basketWeights: w(52, 31, 13, 4),
    customerCount: 190,
  },
  retail: {
    attributionRate: 0.46,
    ordersPerDay: 31,
    hourWeights: w(
      NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, 2, 6, 9, 11,
      12, 11, 11, 12, 12, 10, 7, 3, 1, NIGHT, NIGHT, NIGHT,
    ),
    weekdayWeights: w(7, 9, 9, 10, 11, 14, 15),
    basketWeights: w(44, 30, 17, 9),
    customerCount: 340,
  },
  accommodation: {
    attributionRate: 0.96,
    ordersPerDay: 9,
    hourWeights: w(
      NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, 3, 8, 10, 6, 4, 3,
      3, 4, 8, 12, 11, 9, 7, 5, 3, 2, 1, NIGHT,
    ),
    weekdayWeights: w(11, 8, 8, 9, 12, 15, 14),
    basketWeights: w(60, 26, 10, 4),
    customerCount: 150,
  },
  trades: {
    attributionRate: 0.94,
    ordersPerDay: 7,
    hourWeights: w(
      NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT, 2, 8, 12, 12, 11, 8,
      6, 9, 11, 10, 7, 3, 1, NIGHT, NIGHT, NIGHT, NIGHT, NIGHT,
    ),
    weekdayWeights: w(2, 12, 12, 12, 12, 12, 6),
    basketWeights: w(64, 24, 9, 3),
    customerCount: 120,
  },
}

export function tradeShape(family: string): TradeShape {
  return TRADE_SHAPES[family] ?? (TRADE_SHAPES['retail'] as TradeShape)
}

/* ---------------------------------------------------------------- customers */

interface Persona {
  readonly customer: Customer
  /** Mean days between visits. */
  readonly cadenceDays: number
  /** Baskets bigger or smaller than the house average. */
  readonly basketFactor: number
  /** The day they stopped coming, as a day index, or null for still active.
   *  Some regulars quietly lapse, which is the entire point of a win-back
   *  screen and cannot be shown without them. */
  readonly lapsedAfterDay: number | null
  /** The day they first appeared. */
  readonly joinedDay: number
}

function buildPersonas(random: Random, shape: TradeShape, tenantId: string): Persona[] {
  return Array.from({ length: shape.customerCount }, (_, index) => {
    const given = random.pick(GIVEN_NAMES)
    const family = random.pick(FAMILY_NAMES)

    // A long tail on visit frequency: a few come weekly, most come once or
    // twice. Inverting a Pareto draw gives that shape directly.
    const heaviness = Math.min(random.pareto(1.25), 26)
    const cadenceDays = Math.max(3, Math.round(70 / (1 + heaviness)))

    // Most customers were already customers before the window opens; some
    // arrive during it, which is what gives the cohort chart anything to show.
    const joinedDay = random.chance(0.42) ? random.int(0, HISTORY_DAYS - 4) : 0

    // Roughly one in five regulars drifts away inside the window.
    const lapses = cadenceDays < 30 && random.chance(0.21)

    return {
      customer: {
        id: `${tenantId}-cust-${index + 1}`,
        name: `${family} ${given}`,
        email: random.chance(0.82) ? emailFor(given, family, index) : null,
        phone: random.chance(0.7) ? phoneFor(index) : null,
        firstSeenAt: '',
        lastSeenAt: '',
        marketingConsent: random.chance(0.62),
        note: '',
        loyaltyMemberId: null,
      },
      cadenceDays,
      basketFactor: 0.55 + random.next() * 1.3,
      lapsedAfterDay: lapses ? random.int(20, HISTORY_DAYS - 15) : null,
      joinedDay,
    }
  })
}

/* ---------------------------------------------------------------- discounts */

export function buildDiscounts(tenantId: string, currency: string, now: Date): Discount[] {
  const iso = (offsetDays: number): string => {
    const date = new Date(now)
    date.setDate(date.getDate() + offsetDays)
    return date.toISOString()
  }

  return [
    {
      id: `${tenantId}-disc-1`,
      code: 'WELCOME10',
      name: 'First visit, ten percent off',
      kind: 'percent',
      value: 1000,
      scope: 'order',
      appliesTo: [],
      status: 'live',
      startsAt: iso(-HISTORY_DAYS),
      endsAt: null,
      usageLimit: null,
      perCustomerLimit: 1,
      minimumBasket: null,
      redemptions: 0,
      stackable: false,
    },
    {
      id: `${tenantId}-disc-2`,
      code: 'REGULAR15',
      name: 'Thank you, regulars',
      kind: 'percent',
      value: 1500,
      scope: 'order',
      appliesTo: [],
      status: 'live',
      startsAt: iso(-60),
      endsAt: iso(30),
      usageLimit: 500,
      perCustomerLimit: 4,
      minimumBasket: money(3000, currency),
      redemptions: 0,
      stackable: false,
    },
    {
      id: `${tenantId}-disc-3`,
      code: 'QUIETHOURS',
      name: 'Afternoon lull',
      kind: 'fixed',
      value: 500,
      scope: 'order',
      appliesTo: [],
      status: 'paused',
      startsAt: iso(-45),
      endsAt: iso(-5),
      usageLimit: 200,
      perCustomerLimit: null,
      minimumBasket: money(2000, currency),
      redemptions: 0,
      stackable: false,
    },
    {
      id: `${tenantId}-disc-4`,
      code: 'COMEBACK20',
      name: 'Win back, twenty percent',
      kind: 'percent',
      value: 2000,
      scope: 'order',
      appliesTo: [],
      status: 'scheduled',
      startsAt: iso(3),
      endsAt: iso(33),
      usageLimit: 300,
      perCustomerLimit: 1,
      minimumBasket: null,
      redemptions: 0,
      stackable: false,
    },
  ]
}

/* ------------------------------------------------------------------ loyalty */

export function buildLoyaltyProgramme(currency: string): LoyaltyProgramme {
  return {
    enabled: true,
    kind: 'points',
    name: 'The house card',
    // Basis points of a point per minor unit: 100 is one point per hundred,
    // which on the forint is a point per 100 Ft. Integers throughout, because
    // a points balance is a liability on the books and a fractional one
    // cannot be reconciled.
    earnBasisPoints: 100,
    pointValue: money(1, currency),
    stampsPerReward: 10,
    tiers: [
      {
        id: 'bronze',
        name: 'Bronze',
        threshold: 0,
        earnMultiplier: 1,
        perks: ['Points on everything you spend'],
      },
      {
        // Thresholds are in points, so they have to be set against what the
        // earn rate actually produces. At a point per 100 Ft these are
        // roughly 40,000 and 110,000 Ft of lifetime spend, which puts a
        // realistic share of a customer book above each line. Set them
        // against a different earn rate and every member sits in Bronze,
        // which makes the tiers decorative.
        id: 'silver',
        name: 'Silver',
        threshold: 400,
        earnMultiplier: 1.25,
        perks: ['A quarter more points', 'First to hear about anything new'],
      },
      {
        id: 'gold',
        name: 'Gold',
        threshold: 1_100,
        earnMultiplier: 1.5,
        perks: ['Half again on points', 'Priority booking', 'A birthday treat'],
      },
    ],
  }
}

/* ------------------------------------------------------------------ history */

export interface GeneratedHistory {
  readonly customers: Customer[]
  readonly intents: OrderIntent[]
  readonly discounts: Discount[]
  readonly loyaltyMembers: LoyaltyMember[]
}

function pickHour(random: Random, shape: TradeShape): number {
  return random.weighted(shape.hourWeights.map((weight, hour) => [hour, weight] as const))
}

export function generateHistory(input: {
  tenantId: string
  family: string
  items: readonly CatalogItem[]
  staff: readonly StaffMember[]
  currency: string
  now?: Date
}): GeneratedHistory {
  const now = input.now ?? new Date()
  const random = createRandom(input.tenantId)
  const shape = tradeShape(input.family)
  const personas = buildPersonas(random, shape, input.tenantId)
  const discounts = buildDiscounts(input.tenantId, input.currency, now)
  const sellable = input.items.filter((item) => item.active)
  const servers = input.staff.filter((member) => member.status === 'active')

  if (sellable.length === 0) {
    return { customers: [], intents: [], discounts, loyaltyMembers: [] }
  }

  // Popularity is not uniform either: a menu has three things that carry it
  // and a long tail that barely moves, which is what makes a Pareto chart
  // worth drawing.
  const popularity = sellable.map((item, index) => {
    const rank = index + 1
    return [item, 1 / Math.pow(rank, 0.85)] as const
  })

  const intents: OrderIntent[] = []
  const firstSeen = new Map<string, Date>()
  const lastSeen = new Map<string, Date>()
  const redeemedByCustomer = new Map<string, number>()

  for (let dayOffset = HISTORY_DAYS - 1; dayOffset >= 0; dayOffset--) {
    const date = new Date(now)
    date.setDate(date.getDate() - dayOffset)
    const dayIndex = HISTORY_DAYS - 1 - dayOffset
    const weekday = date.getDay()

    const weekdayWeight = shape.weekdayWeights[weekday] ?? 10
    const averageWeekday =
      shape.weekdayWeights.reduce((sum, value) => sum + value, 0) / shape.weekdayWeights.length
    // Trade grows gently across the window, so a period comparison has
    // something to find beyond noise.
    const growth = 0.82 + (dayIndex / HISTORY_DAYS) * 0.36
    const jitter = 0.78 + random.next() * 0.44
    let orderCount = Math.round(
      shape.ordersPerDay * (weekdayWeight / averageWeekday) * growth * jitter,
    )

    // Today is only as long as it has been so far.
    const isToday = dayOffset === 0
    if (isToday) {
      orderCount = Math.max(1, Math.round((orderCount * now.getHours()) / 20))
    }

    for (let index = 0; index < orderCount; index++) {
      const hour = isToday
        ? random.int(Math.min(7, Math.max(0, now.getHours() - 1)), Math.max(7, now.getHours()))
        : pickHour(random, shape)
      const placedAt = new Date(date)
      placedAt.setHours(hour, random.int(0, 59), random.int(0, 59), 0)
      if (placedAt > now) continue

      // Who is buying. Attribution is the exception in most trades, and a
      // named customer is drawn from the ones who are actually around today.
      let customerId: string | null = null
      if (random.chance(shape.attributionRate)) {
        const eligible = personas.filter(
          (persona) =>
            persona.joinedDay <= dayIndex &&
            (persona.lapsedAfterDay === null || dayIndex <= persona.lapsedAfterDay) &&
            random.next() < 1 / persona.cadenceDays,
        )
        const chosen = eligible.length > 0 ? random.pick(eligible) : null
        customerId = chosen?.customer.id ?? null
        if (chosen) {
          if (!firstSeen.has(customerId as string)) firstSeen.set(customerId as string, placedAt)
          lastSeen.set(customerId as string, placedAt)
        }
      }

      const lineCount = random.weighted(
        shape.basketWeights.map((weight, position) => [position + 1, weight] as const),
      )
      const chosenItems = new Set<string>()
      const lines: Array<{ itemId: string; quantity: number }> = []
      for (let position = 0; position < lineCount; position++) {
        const item = random.weighted(popularity)
        if (chosenItems.has(item.id)) continue
        chosenItems.add(item.id)
        lines.push({ itemId: item.id, quantity: random.weighted([[1, 70], [2, 22], [3, 8]]) })
      }
      if (lines.length === 0) continue

      // Roughly one order in eight carries a code, and only codes that were
      // live on the day, so the discount screens are not reporting redemptions
      // from before a campaign started.
      let discountCode: string | null = null
      const live = discounts.filter(
        (discount) =>
          discount.status !== 'draft' &&
          discount.status !== 'scheduled' &&
          new Date(discount.startsAt) <= placedAt &&
          (discount.endsAt === null || new Date(discount.endsAt) >= placedAt),
      )
      if (live.length > 0 && random.chance(0.13)) {
        const candidate = random.pick(live)
        const used = customerId ? (redeemedByCustomer.get(`${customerId}:${candidate.code}`) ?? 0) : 0
        if (candidate.perCustomerLimit === null || used < candidate.perCustomerLimit) {
          discountCode = candidate.code
          if (customerId) {
            redeemedByCustomer.set(`${customerId}:${candidate.code}`, used + 1)
          }
        }
      }

      intents.push({
        placedAt,
        customerId,
        discountCode,
        method: random.weighted([
          ['card', 62],
          ['cash', 26],
          ['wallet', 12],
        ] as ReadonlyArray<readonly [TenderMethod, number]>),
        staffId: servers.length > 0 ? random.pick(servers).id : null,
        lines,
      })
    }
  }

  intents.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())

  // Only customers who actually turned up exist. A directory full of people
  // with no orders makes every average wrong.
  const customers: Customer[] = personas
    .filter((persona) => firstSeen.has(persona.customer.id))
    .map((persona) => ({
      ...persona.customer,
      firstSeenAt: (firstSeen.get(persona.customer.id) as Date).toISOString(),
      lastSeenAt: (lastSeen.get(persona.customer.id) as Date).toISOString(),
    }))

  const programme = buildLoyaltyProgramme(input.currency)
  const spendByCustomer = new Map<string, number>()
  for (const intent of intents) {
    if (!intent.customerId) continue
    const basket = intent.lines.reduce((sum, line) => {
      const item = input.items.find((entry) => entry.id === line.itemId)
      return sum + (item ? item.unitPrice.minor * line.quantity : 0)
    }, 0)
    spendByCustomer.set(intent.customerId, (spendByCustomer.get(intent.customerId) ?? 0) + basket)
  }

  // Not everyone joins. An enrolment rate of 100% would hide the single most
  // useful number on a loyalty screen.
  const loyaltyMembers: LoyaltyMember[] = customers
    .filter(() => random.chance(0.45))
    .map((customer, index) => {
      const spend = spendByCustomer.get(customer.id) ?? 0
      const lifetimePoints = Math.round((spend * programme.earnBasisPoints) / 10_000)
      const redeemed = random.chance(0.35) ? Math.round(lifetimePoints * (0.2 + random.next() * 0.5)) : 0
      const tier = [...programme.tiers]
        .reverse()
        .find((entry) => lifetimePoints >= entry.threshold)
      return {
        id: `${input.tenantId}-loy-${index + 1}`,
        customerId: customer.id,
        customerName: customer.name,
        joinedAt: customer.firstSeenAt,
        points: Math.max(0, lifetimePoints - redeemed),
        lifetimePoints,
        redeemedPoints: redeemed,
        stamps: lifetimePoints % programme.stampsPerReward,
        tierId: tier?.id ?? null,
        lastEarnedAt: customer.lastSeenAt,
      }
    })

  return { customers, intents, discounts, loyaltyMembers }
}
