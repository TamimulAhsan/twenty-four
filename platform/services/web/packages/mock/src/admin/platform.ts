/**
 * The environment, as the admin plane sees it.
 *
 * One market, one legal entity, one currency, one set of books. Every figure
 * in this file belongs to that deployment and to nothing outside it, which is
 * why nothing here is keyed by market and no total is a sum across two.
 *
 * The three merchant fixtures appear here under their own names and tiers, so
 * a specialist who opens a support session on the cafe lands in the cafe the
 * merchant applications already show. A directory of twelve businesses that
 * shares nothing with the tenant fixtures would demo just as well and be
 * wrong in the one way that matters.
 */
import { money, type Money } from '@twentyfour/money'
import {
  MODULES,
  TIERS,
  TIER_IDS,
  industryProfile,
  resolveDependencies,
  type ModuleId,
  type TierId,
} from '@twentyfour/entitlement'
import type {
  AdminEnvironment,
  AdminRoleDefinition,
  AdminStaffMember,
  AuditEvent,
  OnboardingState,
  PlatformInvoice,
  TenantHealth,
  TenantIntegration,
  TenantOrder,
  TenantQuota,
  TenantStatus,
} from '@twentyfour/api'
import { createRandom } from '../random'
import { freshOnboarding } from '../onboarding'
import { SEEDS } from '../seed'

const CURRENCY = 'HUF'
const huf = (amount: number): Money => money(Math.round(amount), CURRENCY)

/**
 * Fixed, so the console is the same console on every reload.
 *
 * Every relative date in this fixture is measured from here rather than from
 * Date.now(). A directory whose SLA timers drift as the day passes cannot be
 * read twice and compared.
 */
export const NOW = new Date('2026-09-06T18:00:00.000Z')

export const ENVIRONMENT: AdminEnvironment = {
  market: 'Hungary',
  environment: 'production',
  currency: CURRENCY,
  locale: 'hu-HU',
  timezone: 'Europe/Budapest',
  release: '2026.09.3',
  // A label, not a branch. The market's own Invoicing service knows what it
  // submits to; the console only repeats the name back.
  fiscalAuthority: 'National tax authority',
  goLiveHours: 24,
  auditRetentionYears: 7,
  readTokenMinutes: 30,
  writeTokenMinutes: 15,
}

/* ------------------------------------------------------------------ staff */

export const ADMIN_ROLES: readonly AdminRoleDefinition[] = [
  {
    id: 'platform_admin',
    name: 'Platform Admin',
    summary: 'Full access to the admin console for this market, including the tier registry.',
    impersonation: 'write',
    impersonationNote: 'Read and write',
  },
  {
    id: 'specialist',
    name: 'Specialist',
    summary: 'Onboards and supports tenants. Can provision and impersonate, not change pricing.',
    impersonation: 'write',
    impersonationNote: 'Read and write, with a reason',
  },
  {
    id: 'support',
    name: 'Support',
    summary: 'Reads tenant state to answer questions. Cannot change entitlements.',
    // Support holds no write permission anywhere, so a write token would let
    // them do nothing they are allowed to do. Read only is not a restriction
    // added here; it is what their grants already come to.
    impersonation: 'read',
    impersonationNote: 'Read only',
  },
]

export const STAFF: readonly AdminStaffMember[] = [
  {
    staffId: 'st_adam',
    name: 'Ádám Bíró',
    email: 'adam@twentyfour.hu',
    role: 'platform_admin',
    mfa: 'Passkey and TOTP',
    lastSeenAt: '2026-09-06T06:12:00.000Z',
    impersonations: 6,
  },
  {
    staffId: 'st_dora',
    name: 'Dóra Halász',
    email: 'dora@twentyfour.hu',
    role: 'specialist',
    mfa: 'TOTP',
    lastSeenAt: '2026-09-06T05:40:00.000Z',
    impersonations: 11,
  },
  {
    staffId: 'st_mark',
    name: 'Márk Szendrei',
    email: 'mark@twentyfour.hu',
    role: 'support',
    mfa: 'TOTP',
    lastSeenAt: '2026-09-05T16:22:00.000Z',
    impersonations: 19,
  },
  {
    staffId: 'st_judit',
    name: 'Judit Vas',
    email: 'judit@twentyfour.hu',
    role: 'specialist',
    mfa: 'Passkey and TOTP',
    lastSeenAt: '2026-09-05T14:05:00.000Z',
    impersonations: 4,
  },
  {
    staffId: 'st_bence',
    name: 'Bence Tímár',
    email: 'bence@twentyfour.hu',
    role: 'support',
    mfa: 'TOTP',
    lastSeenAt: '2026-09-02T07:31:00.000Z',
    impersonations: 0,
  },
  {
    // Enrolled but not yet holding a second factor. The gateway refuses this
    // account; the row is here so the gap is visible rather than implied by a
    // count that says "1 pending" somewhere else.
    staffId: 'st_zita',
    name: 'Zita Kelemen',
    email: 'zita@twentyfour.hu',
    role: 'support',
    mfa: null,
    lastSeenAt: null,
    impersonations: 0,
  },
]

export const SPECIALISTS = ['Dóra Halász', 'Márk Szendrei', 'Judit Vas'] as const

/* ---------------------------------------------------------------- tenants */

export interface PlatformTenant {
  tenantId: string
  name: string
  merchantCode: string
  industry: string
  tier: TierId
  status: TenantStatus
  health: TenantHealth
  healthNote: string
  city: string
  onboardedAt: string
  ownerName: string
  ownerEmail: string
  ownerPhone: string
  taxId: string
  address: string
  seatsUsed: number
  /** Granted against the tier by a specialist. Audited, and free. */
  overrides: ModuleId[]
  /** Withdrawn against the tier by a specialist. Same record, other direction. */
  withdrawn: ModuleId[]
  onboarding: OnboardingState | null
  specialist: string
  revenue: Array<{ day: string; grossMinor: number }>
  orders: TenantOrder[]
  gmvMinor: number
  refundedMinor: number
  paymentMethod: string
  dunningState: string | null
  integrationFault: string | null
}

interface TenantSpec {
  tenantId: string
  name: string
  merchantCode: string
  industry: string
  tier: TierId
  status: TenantStatus
  health: TenantHealth
  healthNote: string
  city: string
  address: string
  onboardedAt: string
  ownerName: string
  ownerEmail: string
  ownerPhone: string
  taxId: string
  seatsUsed: number
  paymentMethod: string
  dunningState?: string
  integrationFault?: string
  overrides?: ModuleId[]
  withdrawn?: ModuleId[]
  /** Hours remaining against the promise. Only for a run still in flight. */
  slaHoursLeft?: number
  /** Step id the saga is stuck on, if it is. */
  failedStep?: string
}

/**
 * The three merchant fixtures, first.
 *
 * Their ids, names, tiers and business types are read from the seeds rather
 * than restated, so the console and the merchant applications cannot disagree
 * about what the cafe is. Everything the merchant plane has no opinion about
 * (the tax number, the owner's phone, what a specialist wrote on the account)
 * is added here, because that is genuinely admin-plane data.
 */
const SEEDED: TenantSpec[] = [
  {
    tenantId: SEEDS[0]?.id ?? 'cafe',
    name: SEEDS[0]?.profile.name ?? 'Nyolcas Kávézó',
    merchantCode: '7QK3M9',
    industry: SEEDS[0]?.profile.industry ?? 'cafe',
    tier: SEEDS[0]?.entitlement.tier ?? 'growth',
    status: 'live',
    health: 'ok',
    healthNote: 'Nothing outstanding.',
    city: 'Budapest VIII.',
    address: 'Nyolcas utca 12',
    onboardedAt: '2025-03-14T09:00:00.000Z',
    ownerName: SEEDS[0]?.session.name ?? 'Anna Kovács',
    ownerEmail: SEEDS[0]?.session.email ?? 'anna@nyolcaskavezo.hu',
    ownerPhone: '+36 1 318 4420',
    taxId: 'HU24418890',
    seatsUsed: 4,
    paymentMethod: 'Card ending 4417',
  },
  {
    tenantId: SEEDS[1]?.id ?? 'salon',
    name: SEEDS[1]?.profile.name ?? 'Aranyhíd Szalon',
    merchantCode: 'H4T2XB',
    industry: SEEDS[1]?.profile.industry ?? 'hair_salon',
    tier: SEEDS[1]?.entitlement.tier ?? 'starter',
    status: 'provisioning',
    health: 'attention',
    healthNote: 'Card processing account is with the provider. Four steps left.',
    city: 'Budapest II.',
    address: 'Margit körút 44',
    onboardedAt: '2026-09-06T13:00:00.000Z',
    ownerName: SEEDS[1]?.session.name ?? 'Eszter Balogh',
    ownerEmail: SEEDS[1]?.session.email ?? 'eszter@aranyhid.hu',
    ownerPhone: '+36 1 402 1180',
    taxId: 'HU26610042',
    seatsUsed: 3,
    paymentMethod: 'Card ending 2201',
    slaHoursLeft: 19,
  },
  {
    tenantId: SEEDS[2]?.id ?? 'shop',
    name: SEEDS[2]?.profile.name ?? 'Váci Butik',
    merchantCode: 'M8RD4C',
    industry: SEEDS[2]?.profile.industry ?? 'clothing',
    tier: SEEDS[2]?.entitlement.tier ?? 'max',
    status: 'live',
    health: 'ok',
    healthNote: 'Nothing outstanding.',
    city: 'Budapest V.',
    address: 'Váci utca 31',
    onboardedAt: '2024-11-05T09:00:00.000Z',
    ownerName: SEEDS[2]?.session.name ?? 'Gábor Fekete',
    ownerEmail: SEEDS[2]?.session.email ?? 'gabor@vacibutik.hu',
    ownerPhone: '+36 1 266 1042',
    taxId: 'HU22015583',
    seatsUsed: 6,
    paymentMethod: 'Card ending 9930',
    // The one tenant carrying a specialist's override, so the entitlement tab
    // has something to show that no tier put there.
    overrides: ['advanced_analytics'],
  },
]

const GENERATED: TenantSpec[] = [
  {
    tenantId: 'tn_pekseg',
    name: 'Bodnár Pékség',
    merchantCode: 'P2WJ6K',
    industry: 'bakery',
    tier: 'starter',
    status: 'live',
    health: 'attention',
    healthNote: 'Card on file expires next month. Dunning starts on the next cycle.',
    city: 'Budapest IX.',
    address: 'Ráday utca 8',
    onboardedAt: '2025-06-21T09:00:00.000Z',
    ownerName: 'Ferenc Bodnár',
    ownerEmail: 'ferenc@bodnarpekseg.hu',
    ownerPhone: '+36 1 210 9955',
    taxId: 'HU28114507',
    seatsUsed: 3,
    paymentMethod: 'Card ending 3388',
    dunningState: 'Pre-dunning notice sent',
  },
  {
    tenantId: 'tn_fitness',
    name: 'Váci Fitness Stúdió',
    merchantCode: 'R5NB8T',
    industry: 'gym',
    tier: 'growth',
    status: 'provisioning',
    health: 'failing',
    healthNote: 'Card processing account was refused by the provider. Retryable.',
    city: 'Budapest XIII.',
    address: 'Váci út 118',
    onboardedAt: '2026-09-06T04:00:00.000Z',
    ownerName: 'Tamás Simon',
    ownerEmail: 'tamas@vacifitness.hu',
    ownerPhone: '+36 1 555 3311',
    taxId: 'HU31220984',
    seatsUsed: 1,
    paymentMethod: 'Card ending 6612',
    integrationFault: 'payments',
    slaHoursLeft: 14,
    failedStep: 'processor_account',
  },
  {
    tenantId: 'tn_virag',
    name: 'Zöld Kert Virágüzlet',
    merchantCode: 'V9CD3F',
    industry: 'florist',
    tier: 'starter',
    status: 'live',
    health: 'ok',
    healthNote: 'Nothing outstanding.',
    city: 'Budapest XI.',
    address: 'Bartók Béla út 61',
    onboardedAt: '2025-08-09T09:00:00.000Z',
    ownerName: 'Júlia Papp',
    ownerEmail: 'julia@zoldkert.hu',
    ownerPhone: '+36 1 344 0072',
    taxId: 'HU29907711',
    seatsUsed: 2,
    paymentMethod: 'Card ending 1174',
  },
  {
    tenantId: 'tn_szerviz',
    name: 'Móra Autószerviz',
    merchantCode: 'K3ZH7Q',
    industry: 'garage',
    tier: 'max',
    status: 'suspended',
    health: 'failing',
    healthNote: 'Third failed charge. Access was suspended and staff logins are refused.',
    city: 'Budapest XIX.',
    address: 'Kisfaludy utca 3',
    onboardedAt: '2025-01-27T09:00:00.000Z',
    ownerName: 'Zoltán Móra',
    ownerEmail: 'zoltan@moraszerviz.hu',
    ownerPhone: '+36 1 288 6644',
    taxId: 'HU23880156',
    seatsUsed: 9,
    paymentMethod: 'Card ending 5520',
    dunningState: 'Attempt 3 of 4, access suspended',
  },
  {
    tenantId: 'tn_fogaszat',
    name: 'Pesti Fogászat',
    merchantCode: 'D6YT2N',
    industry: 'dental_clinic',
    tier: 'enterprise',
    status: 'live',
    health: 'ok',
    healthNote: 'Nothing outstanding.',
    city: 'Budapest VI.',
    address: 'Andrássy út 39',
    onboardedAt: '2024-08-05T09:00:00.000Z',
    ownerName: 'Katalin Fekete',
    ownerEmail: 'katalin@pestifogaszat.hu',
    ownerPhone: '+36 1 461 7700',
    taxId: 'HU22015584',
    seatsUsed: 26,
    paymentMethod: 'Bank transfer, 14 days',
  },
  {
    tenantId: 'tn_bike',
    name: 'Buda Bike Műhely',
    merchantCode: 'B7FG5W',
    industry: 'sports_shop',
    tier: 'growth',
    status: 'live',
    health: 'attention',
    healthNote: 'All five seats are taken. The next invite will be refused at the gateway.',
    city: 'Budapest XII.',
    address: 'Böszörményi út 22',
    onboardedAt: '2025-09-30T09:00:00.000Z',
    ownerName: 'Márton Juhász',
    ownerEmail: 'marton@budabike.hu',
    ownerPhone: '+36 1 375 2280',
    taxId: 'HU30554417',
    seatsUsed: 5,
    paymentMethod: 'Card ending 8841',
  },
  {
    tenantId: 'tn_etterem',
    name: 'Corvin Étterem',
    merchantCode: 'C4XM9J',
    industry: 'restaurant',
    tier: 'max',
    status: 'live',
    health: 'ok',
    healthNote: 'Nothing outstanding.',
    city: 'Budapest VIII.',
    address: 'Blaha Lujza tér 2',
    onboardedAt: '2025-02-18T09:00:00.000Z',
    ownerName: 'Péter Rácz',
    ownerEmail: 'peter@corvinetterem.hu',
    ownerPhone: '+36 1 266 1043',
    taxId: 'HU24771203',
    seatsUsed: 14,
    paymentMethod: 'Card ending 7712',
  },
  {
    tenantId: 'tn_joga',
    name: 'Hegyvidék Jógastúdió',
    merchantCode: 'J2QP8H',
    industry: 'yoga_studio',
    tier: 'starter',
    status: 'trial',
    health: 'attention',
    healthNote: 'Trial ends in six days and no payment method has been captured.',
    city: 'Budapest XII.',
    address: 'Csaba utca 7',
    onboardedAt: '2026-08-29T09:00:00.000Z',
    ownerName: 'Réka Takács',
    ownerEmail: 'reka@hegyvidekjoga.hu',
    ownerPhone: '+36 1 319 8866',
    taxId: 'HU32109874',
    seatsUsed: 2,
    paymentMethod: 'None on file',
    dunningState: 'Awaiting a payment method',
  },
  {
    tenantId: 'tn_kutya',
    name: 'Óbuda Kutyakozmetika',
    merchantCode: 'G8SN4V',
    industry: 'veterinary',
    tier: 'starter',
    status: 'provisioning',
    health: 'ok',
    healthNote: 'On track. Three steps left.',
    city: 'Budapest III.',
    address: 'Bécsi út 90',
    onboardedAt: '2026-09-06T09:00:00.000Z',
    ownerName: 'Orsolya Németh',
    ownerEmail: 'orsolya@obudakutya.hu',
    ownerPhone: '+36 1 439 5521',
    taxId: 'HU32441098',
    seatsUsed: 1,
    paymentMethod: 'Card ending 4409',
    slaHoursLeft: 21,
  },
  {
    tenantId: 'tn_konyv',
    name: 'Margit Könyvesbolt',
    merchantCode: 'N5WK7R',
    industry: 'bookshop',
    tier: 'growth',
    status: 'provisioning',
    health: 'failing',
    healthNote: 'Six hours left on the promise with the data import still waiting on the owner.',
    city: 'Budapest II.',
    address: 'Margit utca 15',
    onboardedAt: '2026-09-06T00:00:00.000Z',
    ownerName: 'László Balogh',
    ownerEmail: 'laszlo@margitkonyv.hu',
    ownerPhone: '+36 1 212 7743',
    taxId: 'HU32550119',
    seatsUsed: 1,
    paymentMethod: 'Card ending 3067',
    slaHoursLeft: 6,
  },
]

const CHANNELS = ['Till', 'Online', 'Booking', 'Phone']
const TENDERS = ['Card', 'Cash', 'Bank transfer', 'Voucher']
const ORDER_STATES: ReadonlyArray<readonly [string, number]> = [
  ['completed', 88],
  ['open', 4],
  ['refunded', 4],
  ['partly_refunded', 2],
  ['void', 2],
]

function dayKeys(count: number): string[] {
  const days: string[] = []
  for (let index = count - 1; index >= 0; index--) {
    const day = new Date(NOW.getTime() - index * 86_400_000)
    days.push(day.toISOString().slice(0, 10))
  }
  return days
}

/**
 * Trading history for one tenant.
 *
 * Seeded from the tenant id, so the figures are stable across reloads and a
 * screen can be compared with itself. A tenant that is not trading gets
 * nothing rather than a small number: provisioning has made no sales, and a
 * fixture that gives it three is a fixture that hides the empty state.
 */
function buildTrading(spec: TenantSpec): {
  revenue: Array<{ day: string; grossMinor: number }>
  orders: TenantOrder[]
  gmvMinor: number
  refundedMinor: number
} {
  const days = dayKeys(30)
  if (spec.status === 'provisioning') {
    return {
      revenue: days.map((day) => ({ day, grossMinor: 0 })),
      orders: [],
      gmvMinor: 0,
      refundedMinor: 0,
    }
  }

  const random = createRandom(`admin:${spec.tenantId}`)
  const scale = spec.tier === 'enterprise' ? 4 : spec.tier === 'max' ? 2.4 : spec.tier === 'growth' ? 1.5 : 1
  const basket = Math.round(2400 * scale)
  const orders: TenantOrder[] = []
  const byDay = new Map<string, number>(days.map((day) => [day, 0]))
  let refundedMinor = 0

  const count = spec.status === 'trial' ? 11 : Math.round(38 * scale)
  for (let index = 0; index < count; index++) {
    const day = days[random.int(0, days.length - 1)] as string
    const hour = random.int(8, 19)
    const minute = random.int(0, 59)
    const status = random.weighted(ORDER_STATES)
    const total = Math.max(500, Math.round(basket * (0.4 + random.pareto(2.4))))
    const items = random.int(1, 3)
    const placedAt = `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

    if (status !== 'void') byDay.set(day, (byDay.get(day) ?? 0) + total)
    if (status === 'refunded') refundedMinor += total
    if (status === 'partly_refunded') refundedMinor += Math.round(total / 2)

    orders.push({
      orderId: `${spec.merchantCode}-${41000 + index}`,
      placedAt,
      channel: random.pick(CHANNELS),
      tender: random.pick(TENDERS),
      lineSummary: `${items} ${items === 1 ? 'line' : 'lines'}`,
      status,
      // One format in every market: year, merchant code, sequence. Void orders
      // never got one, which is why this is nullable rather than a dash.
      invoiceNumber: status === 'void' ? null : `2026-${spec.merchantCode}-${110 + index}`,
      fiscalState: status === 'void' ? 'not issued' : random.chance(0.06) ? 'queued' : 'accepted',
      total: huf(total),
    })
  }

  orders.sort((left, right) => right.placedAt.localeCompare(left.placedAt))
  const revenue = days.map((day) => ({ day, grossMinor: byDay.get(day) ?? 0 }))
  const gmvMinor = revenue.reduce((sum, entry) => sum + entry.grossMinor, 0)
  return { revenue, orders, gmvMinor, refundedMinor }
}

/**
 * The provisioning run behind a tenant, if there is one.
 *
 * A live tenant has none: its run finished and was archived, and showing a
 * completed twelve-step checklist on a business that has been trading for a
 * year is how the merchant dashboard used to imply that every tenant was
 * still being set up.
 */
function buildRun(spec: TenantSpec): OnboardingState | null {
  if (spec.status !== 'provisioning') return null

  const hoursLeft = spec.slaHoursLeft ?? 20
  const startedAt = new Date(NOW.getTime() - (24 - hoursLeft) * 3_600_000)
  const state = freshOnboarding(startedAt)
  const elapsed = 24 - hoursLeft

  const steps = state.steps.map((step) => {
    if (step.id === spec.failedStep) {
      return { ...step, status: 'failed' as const, completedAt: null }
    }
    // A step is done once its hour has passed, except the ones that need a
    // person: those wait however long the person takes.
    if (step.owner === 'platform' && step.hour <= elapsed) {
      return {
        ...step,
        status: 'done' as const,
        completedAt: new Date(startedAt.getTime() + step.hour * 3_600_000).toISOString(),
      }
    }
    return step
  })

  const running = steps.findIndex((step) => step.status === 'pending' && step.owner === 'platform')
  return {
    ...state,
    steps: steps.map((step, index) =>
      index === running ? { ...step, status: 'in_progress' as const } : step,
    ),
  }
}

function toTenant(spec: TenantSpec): PlatformTenant {
  const trading = buildTrading(spec)
  return {
    tenantId: spec.tenantId,
    name: spec.name,
    merchantCode: spec.merchantCode,
    industry: spec.industry,
    tier: spec.tier,
    status: spec.status,
    health: spec.health,
    healthNote: spec.healthNote,
    city: spec.city,
    onboardedAt: spec.onboardedAt,
    ownerName: spec.ownerName,
    ownerEmail: spec.ownerEmail,
    ownerPhone: spec.ownerPhone,
    taxId: spec.taxId,
    address: spec.address,
    seatsUsed: spec.seatsUsed,
    overrides: spec.overrides ? [...spec.overrides] : [],
    withdrawn: spec.withdrawn ? [...spec.withdrawn] : [],
    onboarding: buildRun(spec),
    specialist: SPECIALISTS[Math.abs(spec.tenantId.length * 7) % SPECIALISTS.length] as string,
    paymentMethod: spec.paymentMethod,
    dunningState: spec.dunningState ?? null,
    integrationFault: spec.integrationFault ?? null,
    ...trading,
  }
}

export function buildTenants(): PlatformTenant[] {
  return [...SEEDED, ...GENERATED].map(toTenant)
}

/* ------------------------------------------------------- derived per tenant */

/** What a tenant holds once tier, dependencies and overrides resolve. */
export function tenantModules(tenant: PlatformTenant, grants: readonly ModuleId[]): ModuleId[] {
  const withdrawn = new Set(tenant.withdrawn)
  const selected = [...grants, ...tenant.overrides].filter((id) => !withdrawn.has(id))
  return resolveDependencies(selected).filter((id) => !withdrawn.has(id))
}

export function seatLimitOf(tenant: PlatformTenant): number | null {
  return TIERS[tenant.tier].seats
}

export function mrrOf(tenant: PlatformTenant): Money {
  // Enterprise is quoted per customer, so the registry carries no list price.
  // The figure here is what this contract is worth, which is a tenant fact
  // rather than a tier fact.
  if (tenant.tier === 'enterprise') return huf(249_000)
  const monthly = TIERS[tenant.tier].monthlyMinor
  if (monthly === null) return huf(0)
  // Registry prices are in EUR placeholders; this environment bills in its own
  // currency. One conversion, in one place, rather than a currency check at
  // every call site.
  return huf(monthly * 4)
}

export function integrationsOf(
  tenant: PlatformTenant,
  modules: readonly ModuleId[],
): TenantIntegration[] {
  const held = new Set(modules)
  const faulted = tenant.integrationFault === 'payments'
  const rows: TenantIntegration[] = [
    {
      id: 'payments',
      name: 'Card processing',
      state: faulted ? 'Refused by the provider' : 'Connected',
      health: faulted ? 'failing' : 'ok',
    },
    {
      id: 'invoicing',
      name: `Invoicing to the ${ENVIRONMENT.fiscalAuthority.toLowerCase()}`,
      state: tenant.status === 'live' ? 'Accepted, nothing queued' : 'Not registered yet',
      health: tenant.status === 'live' ? 'ok' : 'attention',
    },
    {
      id: 'notifications',
      name: 'Email and SMS',
      state: 'Delivering',
      health: 'ok',
    },
  ]
  if (held.has('crm')) {
    rows.push({ id: 'crm', name: 'CRM workspace', state: 'Synced', health: 'ok' })
  }
  if (held.has('marketing_ads')) {
    rows.push({ id: 'ads', name: 'Ad accounts', state: 'Two accounts, spend synced', health: 'ok' })
  }
  if (held.has('website_storefront')) {
    rows.push({
      id: 'domain',
      name: 'Custom domain',
      state: 'Not built yet',
      health: 'attention',
    })
  }
  return rows
}

export function quotasOf(tenant: PlatformTenant, modules: readonly ModuleId[]): TenantQuota[] {
  const limit = seatLimitOf(tenant)
  const rows: TenantQuota[] = [
    {
      id: 'seats',
      label: 'Staff seats',
      used: tenant.seatsUsed,
      limit,
      unit: 'count',
      amount: null,
      ceiling: null,
    },
    {
      id: 'storage',
      label: 'Stored files',
      used: 2_400_000_000 + tenant.seatsUsed * 120_000_000,
      limit: 20_000_000_000,
      unit: 'bytes',
      amount: null,
      ceiling: null,
    },
  ]
  if (modules.includes('marketing_ads')) {
    rows.push({
      id: 'ad_budget',
      label: 'Ad budget this cycle',
      used: 0,
      limit: null,
      unit: 'money',
      amount: huf(38_400),
      ceiling: huf(60_000),
    })
  }
  return rows
}

export function invoicesOf(tenant: PlatformTenant): PlatformInvoice[] {
  const amount = mrrOf(tenant)
  return [0, 1, 2, 3, 4, 5].map((offset) => {
    const month = 9 - offset
    const failed = tenant.dunningState !== null && offset === 0
    return {
      number: `2026-${tenant.merchantCode}-S${20 + offset}`,
      issuedAt: `2026-${String(month).padStart(2, '0')}-01T08:00:00.000Z`,
      period: `2026-${String(month).padStart(2, '0')}`,
      status: failed ? ('failed' as const) : ('paid' as const),
      fiscalState: failed ? 'not issued' : 'accepted',
      gross: amount,
    }
  })
}

/* ------------------------------------------------------------ audit trail */

const EVENT_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['impersonation.started', 'read-only support token issued'],
  ['impersonation.ended', 'session closed by the specialist'],
  ['entitlement.changed', 'a module was granted against the tier'],
  ['tenant.tier.changed', 'tier changed, dependencies resolved'],
  ['provisioning.step.retried', 'a saga step was re-run'],
  ['invoice.corrected', 'a correction document was issued'],
  ['tenant.suspended', 'third failed charge on the billing cycle'],
  ['staff.mfa.reset', 'authenticator re-enrolled'],
  ['refund.issued', 'order refunded from the admin plane'],
  ['tenant.created', 'self-serve signup, industry profile resolved'],
  ['module.enabled', 'gateway policy cache invalidated'],
]

export function buildAudit(tenants: readonly PlatformTenant[]): AuditEvent[] {
  const random = createRandom('admin:audit')
  const events: AuditEvent[] = []
  for (let index = 0; index < 56; index++) {
    const kind = EVENT_KINDS[index % EVENT_KINDS.length] as readonly [string, string]
    const tenant = tenants[(index * 5) % tenants.length] as PlatformTenant
    const actor = STAFF[index % STAFF.length] as AdminStaffMember
    const at = new Date(NOW.getTime() - index * 41 * 60_000)
    const denied = index % 13 === 7
    events.push({
      eventId: `ev_${90_210 + index}`,
      at: at.toISOString(),
      actor: index % 7 === 6 ? 'platform automation' : actor.name,
      event: kind[0],
      tenantId: tenant.tenantId,
      tenantName: tenant.name,
      detail: kind[1],
      sourceIp: index % 7 === 6 ? 'internal' : `84.21.66.${10 + random.int(0, 40)}`,
      result: denied ? 'denied' : 'ok',
      scope: kind[0].startsWith('impersonation') ? 'orders:read, customers:read' : null,
    })
  }
  return events
}

/* --------------------------------------------------------------- registry */

/** The tier grant lists, as mutable Registry rows rather than constants. */
export function buildGrants(): Record<TierId, ModuleId[]> {
  const rows = {} as Record<TierId, ModuleId[]>
  for (const tier of TIER_IDS) rows[tier] = [...TIERS[tier].grants]
  return rows
}

/**
 * Whether a tier can go live without a specialist.
 *
 * Derived, not stored. A tier is self-serve capable when every module it
 * resolves to can provision unattended, so adding a module that needs KYC
 * flips it, and nobody has to remember to.
 */
export function autoProvisionable(grants: readonly ModuleId[]): boolean {
  return resolveDependencies(grants).every((id) => MODULES[id].selfServeCapable)
}

export function industryLabel(id: string): string {
  return industryProfile(id)?.name ?? id
}

export { huf, CURRENCY }
