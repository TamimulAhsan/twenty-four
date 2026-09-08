/**
 * The Admin Console surface, typed.
 *
 * A second plane, not a second view of the first. The merchant BFF answers
 * "what does this tenant hold"; this answers "what is happening across this
 * environment", and it is served by a different gateway behind staff SSO, MFA
 * and an IP allowlist.
 *
 * Three properties hold everywhere in this file, and each of them removes a
 * whole class of mistake:
 *
 *   One environment. There is one market per deployment, so nothing here takes
 *   a market parameter, and no figure is a sum across markets. Group
 *   consolidation is a separate reporting step, outside the product.
 *
 *   The registry is shared. Tiers, modules and dependency resolution come from
 *   @twentyfour/entitlement, which is the same registry the gateway enforces
 *   against. A console with its own module list is a console that lies.
 *
 *   Health is a value, not a sentence. The status a filter matches on is a
 *   field; the sentence a human reads is a different field. Deriving one from
 *   the other by searching for the word "failed" works until somebody writes
 *   "no failures".
 */
import { adminRequest, idempotencyKey } from './http'
import { parseMoney, type Money } from '@twentyfour/money'
import type { ModuleId, TierId } from '@twentyfour/entitlement'
import type { OnboardingState, OnboardingStep } from './types'

/* -------------------------------------------------------------- the staff */

/**
 * What a specialist may do.
 *
 * These are RBAC's admin-plane system role keys, not a vocabulary of this
 * console's own. An earlier draft had five roles invented alongside the design
 * import; RBAC ships three, with real permission grants behind them, and RBAC
 * is what the gateway actually enforces. A console with its own idea of what a
 * role is disagrees with the enforcement the first time somebody is refused
 * something the screen offered them.
 *
 * Distinct from the merchant's roles, which describe an owner, a manager and a
 * cashier inside one business. These describe people who can see every
 * business, which is why the set is small.
 */
export type AdminRole =
  /** Everything, including the tier registry and offboarding. */
  | 'platform_admin'
  /** Onboards and supports tenants. Can provision and impersonate, not price. */
  | 'specialist'
  /** Reads tenant state to answer questions. Cannot change entitlements. */
  | 'support'

export type ImpersonationMode = 'read' | 'write'

export interface AdminRoleDefinition {
  readonly id: AdminRole
  readonly name: string
  readonly summary: string
  /** null means this role may not impersonate at all. */
  readonly impersonation: ImpersonationMode | null
  readonly impersonationNote: string
}

export interface AdminSession {
  readonly staffId: string
  readonly name: string
  readonly email: string
  readonly role: AdminRole
  /** Which authenticator. Never a claim that MFA is merely "on". */
  readonly mfa: string
  readonly sourceIp: string
  readonly signedInAt: string
}

export interface AdminStaffMember {
  readonly staffId: string
  readonly name: string
  readonly email: string
  readonly role: AdminRole
  readonly mfa: string | null
  readonly lastSeenAt: string | null
  /** Impersonation sessions opened in the last 30 days. */
  readonly impersonations: number
}

/* --------------------------------------------------------- the deployment */

/**
 * What this deployment is.
 *
 * Read once and displayed, never branched on. If a screen ever asks whether
 * market is Hungary, the market-per-deployment rule has already been broken
 * and the answer is a different deployment, not a condition.
 */
export interface AdminEnvironment {
  readonly market: string
  readonly environment: string
  readonly currency: string
  readonly locale: string
  readonly timezone: string
  readonly release: string
  /**
   * What the market's Invoicing service submits documents to, in that market's
   * own words. A label, so no tax authority's name is compiled into the
   * console.
   */
  readonly fiscalAuthority: string
  /** Hours the go-live promise is measured against. */
  readonly goLiveHours: number
  readonly auditRetentionYears: number
  /**
   * How long a support token lives, in minutes.
   *
   * Policy of the deployment, so the console reads it rather than restating
   * it. A settings page that says thirty minutes while the gateway issues
   * fifteen is worse than one that says nothing.
   */
  readonly readTokenMinutes: number
  readonly writeTokenMinutes: number
}

/* ------------------------------------------------------------- the tenant */

export type TenantStatus = 'live' | 'provisioning' | 'suspended' | 'trial'

/**
 * How worried to be.
 *
 * Separate from status because they answer different questions: status is what
 * the tenant is, health is whether anybody needs to do something. A live
 * tenant whose card is about to expire is both live and failing.
 */
export type TenantHealth = 'ok' | 'attention' | 'failing'

export interface TenantSummary {
  readonly tenantId: string
  readonly name: string
  /** Six Crockford base32 characters, assigned at signup and never reissued. */
  readonly merchantCode: string
  /** Business type id from the registry, not a display word. */
  readonly industry: string
  readonly tier: TierId
  readonly status: TenantStatus
  readonly health: TenantHealth
  /** The sentence a person reads. Never parsed to recover the health. */
  readonly healthNote: string
  readonly city: string
  readonly onboardedAt: string
  /**
   * What this tenant pays us, or null.
   *
   * Null today, and honestly so: the tier registry carries seat counts and no
   * prices, so any figure here would be invented by the gateway. It lights up
   * when prices are set, and until then the console says so rather than
   * showing a number nobody agreed.
   */
  readonly mrr: Money | null
  /**
   * What this tenant sold, last 30 days. Not ours, and null in the directory.
   *
   * Reading it means asking POS once per tenant, which is the shape that stops
   * working somewhere past a hundred tenants. It is answered on a tenant's own
   * page, where it is one call, and stays absent from the list until the
   * analytics pipeline can answer a whole page at once.
   */
  readonly gmv30d: Money | null
  readonly orders30d: number | null
  /** Null when the seat count did not arrive in the directory's time budget. */
  readonly seatsUsed: number | null
  /** null means negotiated, which Enterprise uses. */
  readonly seatLimit: number | null
}

export interface TenantIntegration {
  readonly id: string
  readonly name: string
  readonly state: string
  readonly health: TenantHealth
}

export interface TenantQuota {
  readonly id: string
  readonly label: string
  readonly used: number
  /** null means no ceiling, which is not the same as a ceiling of zero. */
  readonly limit: number | null
  readonly unit: 'count' | 'bytes' | 'money'
  /** Set when unit is money, so the figure keeps its currency. */
  readonly amount: Money | null
  readonly ceiling: Money | null
}

export interface TenantDailyRevenue {
  readonly day: string
  readonly gross: Money
}

export interface TenantDetail extends TenantSummary {
  readonly ownerName: string
  readonly ownerEmail: string
  readonly ownerPhone: string
  readonly taxId: string
  readonly address: string
  readonly currency: string
  readonly locale: string
  readonly timezone: string
  /**
   * What they hold, and why they hold it.
   *
   * The source is the question a specialist is actually asking: not "do they
   * have the CRM" but "why do they have it". It comes from the entitlement
   * record, where every row already carries it.
   */
  readonly modules: readonly ModuleGrant[]
  /** Why the status was last changed. Empty for a tenant that has always been live. */
  readonly statusNote: string
  /**
   * Everything below is answered by a service that may not exist yet, so each
   * is empty or null rather than absent. A screen renders what it was given
   * and says nothing about the rest; a missing field would be a crash, and a
   * zero would be a claim.
   */
  readonly integrations: readonly TenantIntegration[]
  readonly quotas: readonly TenantQuota[]
  readonly revenue: readonly TenantDailyRevenue[]
  readonly refunded30d: Money | null
  /** Null until Invoicing exists. Nothing else knows what a tenant is billed. */
  readonly subscription: TenantSubscription | null
}

/** One module a tenant holds, and where it came from. */
export interface ModuleGrant {
  readonly moduleId: ModuleId
  readonly source: 'tier' | 'profile' | 'override'
  /** Paid for, but a provisioning step still needs a person. */
  readonly pending: boolean
}

export interface TenantSubscription {
  readonly tier: TierId
  readonly amount: Money
  readonly cycle: string
  readonly nextChargeAt: string | null
  readonly paymentMethod: string
  /** null when nothing is being chased. */
  readonly dunningState: string | null
  readonly lifetimeBilled: Money
}

/** A document we issued to the merchant, for their subscription. */
export interface PlatformInvoice {
  readonly number: string
  readonly issuedAt: string
  readonly period: string
  readonly status: 'paid' | 'failed' | 'open'
  /** What the market's Invoicing service reports back from the authority. */
  readonly fiscalState: string
  readonly gross: Money
}

/** One of the merchant's own sales, seen from the support side. */
export interface TenantOrder {
  readonly orderId: string
  readonly placedAt: string
  readonly channel: string
  readonly tender: string
  readonly lineSummary: string
  readonly status: string
  readonly invoiceNumber: string | null
  readonly fiscalState: string
  readonly total: Money
}

/* ------------------------------------------------------- provisioning saga */

/**
 * A provisioning run.
 *
 * The steps are the merchant's own onboarding checklist. They are not a
 * parallel model: onboarding lives inside Provisioning and these are literally
 * the saga's rows, so a step the specialist retries here is the step the
 * merchant watches turn green on their dashboard.
 */
export interface ProvisioningRun {
  readonly tenantId: string
  readonly tenantName: string
  readonly tier: TierId
  readonly sagaId: string
  /** Who ran the intake call. */
  readonly specialist: string
  readonly state: OnboardingState
}

/* ------------------------------------------------------------- audit trail */

export interface AuditEvent {
  readonly eventId: string
  readonly at: string
  readonly actor: string
  readonly event: string
  readonly tenantId: string | null
  readonly tenantName: string | null
  readonly detail: string
  readonly sourceIp: string
  readonly result: 'ok' | 'denied'
  /** Present on impersonation events: what the token was allowed to do. */
  readonly scope: string | null
}

/* -------------------------------------------------------- support sessions */

export interface SupportSession {
  readonly sessionId: string
  readonly tenantId: string
  readonly tenantName: string
  readonly staffName: string
  readonly mode: ImpersonationMode
  readonly reason: string
  readonly startedAt: string
  readonly expiresAt: string
  readonly endedAt: string | null
  /** Where to send the specialist. The merchant dashboard, not a copy of it. */
  readonly handoffUrl: string
}

/* --------------------------------------------------------- money and tiers */

export interface TierMix {
  readonly tier: TierId
  readonly tenants: number
  readonly mrr: Money
}

export interface DunningEntry {
  readonly tenantId: string
  readonly tenantName: string
  readonly reason: string
  readonly attempt: string
  readonly amount: Money
  readonly health: TenantHealth
}

export interface PlatformBilling {
  readonly mrr: Money
  readonly arrRunRate: Money
  readonly netNewMrr: Money
  readonly failedCharges: number
  readonly atRisk: Money
  readonly mix: readonly TierMix[]
  readonly dunning: readonly DunningEntry[]
}

/**
 * A tier as the Registry holds it.
 *
 * grants is what the tier sells; modules is what that resolves to once
 * dependencies are pulled in. Keeping both is the point: a specialist editing
 * the tier edits grants, and needs to see what it drags along before applying.
 */
export interface TierRegistryEntry {
  readonly tier: TierId
  readonly grants: readonly ModuleId[]
  readonly modules: readonly ModuleId[]
  readonly seats: number | null
  readonly monthly: Money | null
  readonly tenants: number
  /**
   * Whether a self-serve signup on this tier can go live unattended.
   *
   * Derived from the module set, never stored and never toggled: it is false
   * exactly when some module the tier resolves to cannot finish without a
   * person, which is a fact about the modules rather than a policy about the
   * tier. Adding one that needs KYC flips this, and nobody has to remember to.
   */
  readonly autoProvision: boolean
  /** The modules that make autoProvision false. Empty when it is true. */
  readonly needsSpecialist: readonly ModuleId[]
}

export interface AdminOverview {
  readonly environment: AdminEnvironment
  readonly session: AdminSession
  readonly tenants: number
  readonly live: number
  readonly provisioning: number
}

/* ------------------------------------------------------------------ input */

export interface ModuleOverrideInput {
  readonly moduleId: ModuleId
  readonly entitled: boolean
  readonly reason: string
}

export interface StartSupportSessionInput {
  readonly tenantId: string
  readonly mode: ImpersonationMode
  readonly reason: string
}

/* ------------------------------------------------------------ the parsers */

type Raw = Record<string, unknown>

const asRecord = (value: unknown, what: string): Raw => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${what} was not an object`)
  return value as Raw
}

const asArray = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what} was not an array`)
  return value
}

const optionalMoney = (value: unknown): Money | null =>
  value === null || value === undefined ? null : parseMoney(value)

/** A figure the wire may omit entirely. Absent and null mean the same here. */
const optionalNumber = (value: unknown): number | null =>
  typeof value === 'number' ? value : null

/**
 * Normalises every nullable figure, including the ones the wire leaves out.
 *
 * A field a gateway does not send arrives as undefined, and undefined is the
 * one thing a `=== null` check in a component does not catch. Coercing here is
 * the boundary doing its job: past this point a screen sees a number or a null
 * and never a third thing.
 */
function parseSummary(value: unknown): TenantSummary {
  const raw = asRecord(value, 'tenant')
  return {
    ...(raw as unknown as TenantSummary),
    mrr: optionalMoney(raw['mrr']),
    gmv30d: optionalMoney(raw['gmv30d']),
    orders30d: optionalNumber(raw['orders30d']),
    seatsUsed: optionalNumber(raw['seatsUsed']),
    seatLimit: optionalNumber(raw['seatLimit']),
  }
}

function parseQuota(value: unknown): TenantQuota {
  const raw = asRecord(value, 'quota')
  return {
    ...(raw as unknown as TenantQuota),
    amount: optionalMoney(raw['amount']),
    ceiling: optionalMoney(raw['ceiling']),
  }
}

function parseSubscription(value: unknown): TenantSubscription {
  const raw = asRecord(value, 'tenant subscription')
  return {
    ...(raw as unknown as TenantSubscription),
    amount: parseMoney(raw['amount']),
    lifetimeBilled: parseMoney(raw['lifetimeBilled']),
  }
}

function parseDetail(value: unknown): TenantDetail {
  const raw = asRecord(value, 'tenant detail')
  // Absent and empty are the same answer here, and neither is an error. These
  // fields are filled by services that land one at a time, so a parser that
  // insisted on them would make every screen fail until the last one shipped.
  const list = (key: string): unknown[] => (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [])
  return {
    ...parseSummary(raw),
    ...(raw as unknown as TenantDetail),
    mrr: optionalMoney(raw['mrr']),
    gmv30d: optionalMoney(raw['gmv30d']),
    refunded30d: optionalMoney(raw['refunded30d']),
    modules: list('modules') as TenantDetail['modules'],
    integrations: list('integrations') as TenantDetail['integrations'],
    quotas: list('quotas').map(parseQuota),
    revenue: list('revenue').map((entry) => {
      const row = asRecord(entry, 'revenue day')
      return { ...(row as unknown as TenantDailyRevenue), gross: parseMoney(row['gross']) }
    }),
    subscription: raw['subscription'] ? parseSubscription(raw['subscription']) : null,
  }
}

function parseInvoice(value: unknown): PlatformInvoice {
  const raw = asRecord(value, 'platform invoice')
  return { ...(raw as unknown as PlatformInvoice), gross: parseMoney(raw['gross']) }
}

function parseOrder(value: unknown): TenantOrder {
  const raw = asRecord(value, 'tenant order')
  return { ...(raw as unknown as TenantOrder), total: parseMoney(raw['total']) }
}

function parseBilling(value: unknown): PlatformBilling {
  const raw = asRecord(value, 'platform billing')
  return {
    ...(raw as unknown as PlatformBilling),
    mrr: parseMoney(raw['mrr']),
    arrRunRate: parseMoney(raw['arrRunRate']),
    netNewMrr: parseMoney(raw['netNewMrr']),
    atRisk: parseMoney(raw['atRisk']),
    mix: asArray(raw['mix'], 'tier mix').map((entry) => {
      const row = asRecord(entry, 'tier mix row')
      return { ...(row as unknown as TierMix), mrr: parseMoney(row['mrr']) }
    }),
    dunning: asArray(raw['dunning'], 'dunning').map((entry) => {
      const row = asRecord(entry, 'dunning row')
      return { ...(row as unknown as DunningEntry), amount: parseMoney(row['amount']) }
    }),
  }
}

function parseTier(value: unknown): TierRegistryEntry {
  const raw = asRecord(value, 'tier')
  return { ...(raw as unknown as TierRegistryEntry), monthly: optionalMoney(raw['monthly']) }
}

/* --------------------------------------------------------------- the calls */

/**
 * Opening a session on this plane.
 *
 * There is no sign-in call here, because there is no sign-in form here. One
 * form serves both planes and lives on the merchant origin; a specialist
 * arrives holding a one-time code, and this is what turns it into a session.
 */
export const adminSession = {
  exchange: async (code: string): Promise<void> => {
    await adminRequest<void>('/session/exchange', { method: 'POST', body: { code } })
  },
}

export const adminAuth = {
  /**
   * Who is signed in, if anyone.
   *
   * Returns null rather than throwing on 401. Arriving signed out is the
   * ordinary case for a console behind SSO, not an error to report.
   */
  session: async (): Promise<AdminSession | null> =>
    adminRequest<AdminSession | null>('/auth/session'),

  signOut: async (): Promise<void> => {
    await adminRequest<void>('/auth/session', { method: 'DELETE' })
  },
}

export const adminPlatform = {
  overview: (): Promise<AdminOverview> => adminRequest<AdminOverview>('/overview'),

  environment: (): Promise<AdminEnvironment> => adminRequest<AdminEnvironment>('/environment'),

  billing: async (): Promise<PlatformBilling> => parseBilling(await adminRequest('/billing')),

  tiers: async (): Promise<TierRegistryEntry[]> =>
    asArray(await adminRequest('/registry/tiers'), 'tiers').map(parseTier),

  /**
   * Changes what a tier grants.
   *
   * This rewrites the entitlement record of every tenant on the tier and
   * invalidates the gateway's policy cache. It is the most destructive call in
   * the console, which is why it takes the whole grant list rather than a
   * delta: a caller that has to send the full set has to have looked at it.
   */
  setTierGrants: (tier: TierId, grants: readonly ModuleId[]): Promise<TierRegistryEntry[]> =>
    adminRequest<unknown>(`/registry/tiers/${tier}/grants`, {
      method: 'PUT',
      body: { grants },
      idempotencyKey: idempotencyKey(),
    }).then((value) => asArray(value, 'tiers').map(parseTier)),

  staff: (): Promise<AdminStaffMember[]> => adminRequest<AdminStaffMember[]>('/staff'),

  roles: (): Promise<AdminRoleDefinition[]> => adminRequest<AdminRoleDefinition[]>('/roles'),
}

export interface TenantPage {
  readonly tenants: readonly TenantSummary[]
  /** Every tenant in the environment, whatever the filter matched. */
  readonly total: number
  /** Empty when this was the last page. */
  readonly nextCursor: string
}

export const adminTenants = {
  list: async (cursor?: string): Promise<TenantPage> => {
    const raw = asRecord(await adminRequest('/tenants', { query: { cursor } }), 'tenant page')
    return {
      tenants: asArray(raw['tenants'] ?? [], 'tenants').map(parseSummary),
      total: typeof raw['total'] === 'number' ? raw['total'] : 0,
      nextCursor: typeof raw['nextCursor'] === 'string' ? raw['nextCursor'] : '',
    }
  },

  get: async (tenantId: string): Promise<TenantDetail> =>
    parseDetail(await adminRequest(`/tenants/${tenantId}`)),

  orders: async (tenantId: string): Promise<TenantOrder[]> =>
    asArray(await adminRequest(`/tenants/${tenantId}/orders`), 'orders').map(parseOrder),

  invoices: async (tenantId: string): Promise<PlatformInvoice[]> =>
    asArray(await adminRequest(`/tenants/${tenantId}/invoices`), 'invoices').map(parseInvoice),

  audit: (tenantId: string): Promise<AuditEvent[]> =>
    adminRequest<AuditEvent[]>(`/tenants/${tenantId}/audit`),

  setStatus: async (tenantId: string, status: TenantStatus, reason: string): Promise<TenantDetail> =>
    parseDetail(
      await adminRequest(`/tenants/${tenantId}/status`, {
        method: 'PUT',
        body: { status, reason },
        idempotencyKey: idempotencyKey(),
      }),
    ),

  setTier: async (tenantId: string, tier: TierId, reason: string): Promise<TenantDetail> =>
    parseDetail(
      await adminRequest(`/tenants/${tenantId}/tier`, {
        method: 'PUT',
        body: { tier, reason },
        idempotencyKey: idempotencyKey(),
      }),
    ),

  /** Grants or withdraws one module against the tier. Audited, and free. */
  overrideModule: async (
    tenantId: string,
    input: ModuleOverrideInput,
  ): Promise<TenantDetail> =>
    parseDetail(
      await adminRequest(`/tenants/${tenantId}/modules`, { method: 'PUT', body: input }),
    ),
}

export const adminProvisioning = {
  queue: (): Promise<ProvisioningRun[]> => adminRequest<ProvisioningRun[]>('/provisioning'),

  get: (tenantId: string): Promise<ProvisioningRun> =>
    adminRequest<ProvisioningRun>(`/provisioning/${tenantId}`),

  /**
   * Re-runs one step.
   *
   * Idempotent by contract, because the saga is: a step that already completed
   * is a no-op, and a step that half-completed compensates before it retries.
   */
  retryStep: (tenantId: string, stepId: string): Promise<ProvisioningRun> =>
    adminRequest<ProvisioningRun>(`/provisioning/${tenantId}/steps/${stepId}/retry`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(),
    }),
}

export const adminAudit = {
  list: (filter?: string): Promise<AuditEvent[]> =>
    adminRequest<AuditEvent[]>('/audit', { query: { filter } }),
}

export const adminSessions = {
  list: (): Promise<SupportSession[]> => adminRequest<SupportSession[]>('/support-sessions'),

  start: (input: StartSupportSessionInput): Promise<SupportSession> =>
    adminRequest<SupportSession>('/support-sessions', { method: 'POST', body: input }),

  /** Raises a read-only token to write. The reason is the audit record. */
  elevate: (sessionId: string, reason: string): Promise<SupportSession> =>
    adminRequest<SupportSession>(`/support-sessions/${sessionId}/elevate`, {
      method: 'POST',
      body: { reason },
    }),

  extend: (sessionId: string): Promise<SupportSession> =>
    adminRequest<SupportSession>(`/support-sessions/${sessionId}/extend`, { method: 'POST' }),

  revoke: async (sessionId: string): Promise<void> => {
    await adminRequest<void>(`/support-sessions/${sessionId}`, { method: 'DELETE' })
  },
}

export type { OnboardingState, OnboardingStep }
