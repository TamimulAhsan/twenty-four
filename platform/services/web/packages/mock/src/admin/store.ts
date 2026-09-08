/**
 * The admin plane's stateful store.
 *
 * Every mutation here writes an audit event in the same call that makes the
 * change. That is not decoration: the console's whole claim is that a
 * specialist can reach into a merchant's account and that the reach is
 * recorded, so a write that could succeed without leaving a trail would make
 * the audit log a summary of the honest half.
 *
 * The store is deliberately strict about the things the real services would
 * refuse. Withdrawing a module something else depends on, elevating a session
 * a role may not elevate, retrying a step that already finished: all of them
 * fail here, so a screen cannot quietly grow a dependence on the client being
 * the control.
 */
import {
  MODULES,
  TIERS,
  TIER_IDS,
  dependentsOf,
  requiresSpecialist,
  resolveDependencies,
  type ModuleId,
  type TierId,
} from '@twentyfour/entitlement'
import type {
  AdminOverview,
  AdminRole,
  AdminSession,
  AuditEvent,
  DunningEntry,
  ImpersonationMode,
  ModuleOverrideInput,
  OnboardingState,
  PlatformBilling,
  PlatformInvoice,
  ProvisioningRun,
  StartSupportSessionInput,
  SupportSession,
  TenantDetail,
  TenantOrder,
  TenantStatus,
  TenantSummary,
  TierMix,
  TierRegistryEntry,
} from '@twentyfour/api'
import { addMoney, money, zero, type Money } from '@twentyfour/money'
import { MockError } from '../store'
import {
  ADMIN_ROLES,
  CURRENCY,
  ENVIRONMENT,
  NOW,
  STAFF,
  autoProvisionable,
  buildAudit,
  buildGrants,
  buildTenants,
  huf,
  integrationsOf,
  invoicesOf,
  mrrOf,
  quotasOf,
  seatLimitOf,
  tenantModules,
  type PlatformTenant,
} from './platform'

/**
 * How long a support token lives.
 *
 * Read from the environment rather than declared here, so the console's
 * settings page and the token this store issues cannot disagree. Write is
 * shorter than read on purpose.
 */
const READ_TTL_MINUTES = ENVIRONMENT.readTokenMinutes
const WRITE_TTL_MINUTES = ENVIRONMENT.writeTokenMinutes

/**
 * Where a support session hands off to.
 *
 * The merchant dashboard, on the merchant origin. The console does not draw a
 * copy of it: a second implementation of a surface that already exists starts
 * drifting the day it ships, and the thing a specialist most needs to see is
 * exactly what the merchant is looking at.
 */
const MERCHANT_ORIGIN = 'http://app.twentyfour.localhost'

export class AdminStore {
  private signedIn = false
  /**
   * Codes handed out by the merchant gateway, waiting to be redeemed.
   *
   * Single use and short lived, like the real thing. Held in memory because
   * the whole point is that they live for seconds: a code that survived a
   * reload would be a code that survived longer than it should.
   */
  private handoffs = new Map<string, { role: AdminRole; expiresAt: number }>()
  private session: AdminSession
  private tenants: PlatformTenant[]
  private grants: Record<TierId, ModuleId[]>
  private audit: AuditEvent[]
  private sessions: SupportSession[]
  private sessionSeq = 0

  constructor() {
    const owner = STAFF[0]
    this.session = {
      staffId: owner?.staffId ?? 'st_adam',
      name: owner?.name ?? 'Ádám Bíró',
      email: owner?.email ?? 'adam@twentyfour.hu',
      role: owner?.role ?? 'platform_admin',
      mfa: owner?.mfa ?? 'Passkey and TOTP',
      sourceIp: '84.21.66.12',
      signedInAt: new Date(NOW.getTime() - 9 * 3_600_000).toISOString(),
    }
    this.tenants = buildTenants()
    this.grants = buildGrants()
    this.audit = buildAudit(this.tenants)
    this.sessions = this.pastSessions()
  }

  /* ------------------------------------------------------------- the door */

  isSignedIn(): boolean {
    return this.signedIn
  }

  currentSession(): AdminSession | null {
    return this.signedIn ? this.session : null
  }

  /**
   * Mints a handoff code for an address that turns out to be a specialist.
   *
   * Called by the merchant gateway's login handler, which is where a
   * specialist's sign-in actually happens: one form, and the account decides
   * which plane answers.
   */
  issueHandoff(email: string): string | null {
    const member = STAFF.find(
      (entry) => entry.email.toLowerCase() === email.trim().toLowerCase(),
    )
    if (!member) return null
    const code = `hc_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    this.handoffs.set(code, { role: member.role, expiresAt: Date.now() + 30_000 })
    return code
  }

  /**
   * Redeems a code and opens the session.
   *
   * Deleted on the way past, whatever the outcome, so a replay finds nothing.
   * Expired, replayed and never-existed all answer the same way: telling them
   * apart would say something about a code the caller does not hold.
   */
  redeemHandoff(code: string): AdminSession {
    const entry = this.handoffs.get(code)
    this.handoffs.delete(code)
    if (!entry || entry.expiresAt < Date.now()) {
      throw new MockError(401, 'unauthenticated', 'That sign-in link has expired. Sign in again.')
    }
    return this.signIn(entry.role)
  }

  /**
   * Signs a specialist in.
   *
   * Takes a role, or a staff id, because the roles are the interesting part of
   * this plane and a console that can only ever be a platform owner cannot
   * demonstrate them. In production the identity provider decides who this is;
   * here it is the same choice, made earlier.
   */
  signIn(who?: string): AdminSession {
    const member =
      STAFF.find((entry) => entry.staffId === who) ??
      // By role, the first account holding it that could actually sign in. An
      // account with no second factor is refused by the gateway, so picking
      // one here would be demonstrating the wrong thing.
      STAFF.find((entry) => entry.role === who && entry.mfa !== null) ??
      STAFF.find((entry) => entry.role === who) ??
      STAFF[0]
    if (!member) throw new MockError(404, 'not_found', 'No staff account matches that.')
    if (member.mfa === null) {
      throw new MockError(
        403,
        'mfa_required',
        `${member.name} has no second factor enrolled. The gateway refuses the sign-in.`,
      )
    }
    this.signedIn = true
    this.session = {
      staffId: member.staffId,
      name: member.name,
      email: member.email,
      role: member.role,
      mfa: member.mfa,
      sourceIp: '84.21.66.12',
      signedInAt: new Date().toISOString(),
    }
    return this.session
  }

  /**
   * Ends the admin session.
   *
   * Every support token it holds dies with it. A specialist who signs out and
   * leaves a write token alive behind them is the exact failure the time box
   * exists to prevent.
   */
  signOut(): void {
    for (const open of this.sessions.filter((entry) => entry.endedAt === null)) {
      this.closeSession(open.sessionId, 'admin session ended')
    }
    this.signedIn = false
  }

  private require(): void {
    if (!this.signedIn) throw new MockError(401, 'unauthenticated', 'Sign in to continue.')
  }

  /**
   * Refuses a mutation to a role that may only read.
   *
   * Support holds tenant:*:read and entitlement:*:read and nothing else, so
   * every write in this console is beyond it. Refused here the same way the
   * admin gateway refuses it, so a screen cannot grow a dependence on the
   * client being the control.
   */
  private requireWrite(): void {
    this.require()
    if (this.session.role === 'support') {
      throw new MockError(403, 'forbidden', 'Support can read every tenant and change none.')
    }
  }

  /* ------------------------------------------------------------ the trail */

  private record(
    event: string,
    detail: string,
    tenant: PlatformTenant | null,
    scope: string | null = null,
  ): void {
    this.audit.unshift({
      eventId: `ev_${Date.now().toString(36)}${this.audit.length}`,
      at: new Date().toISOString(),
      actor: this.session.name,
      event,
      tenantId: tenant?.tenantId ?? null,
      tenantName: tenant?.name ?? null,
      detail,
      sourceIp: this.session.sourceIp,
      result: 'ok',
      scope,
    })
  }

  listAudit(filter?: string): AuditEvent[] {
    this.require()
    if (!filter || filter === 'all') return this.audit
    if (filter === 'denied') return this.audit.filter((entry) => entry.result === 'denied')
    return this.audit.filter((entry) => entry.event.startsWith(filter))
  }

  tenantAudit(tenantId: string): AuditEvent[] {
    this.require()
    return this.audit.filter((entry) => entry.tenantId === tenantId)
  }

  /* ------------------------------------------------------------- tenants */

  private find(tenantId: string): PlatformTenant {
    const found = this.tenants.find((tenant) => tenant.tenantId === tenantId)
    if (!found) throw new MockError(404, 'not_found', 'No tenant with that id.')
    return found
  }

  private summarise(tenant: PlatformTenant): TenantSummary {
    return {
      tenantId: tenant.tenantId,
      name: tenant.name,
      merchantCode: tenant.merchantCode,
      industry: tenant.industry,
      tier: tenant.tier,
      status: tenant.status,
      health: tenant.health,
      healthNote: tenant.healthNote,
      city: tenant.city,
      onboardedAt: tenant.onboardedAt,
      mrr: mrrOf(tenant),
      gmv30d: huf(tenant.gmvMinor),
      orders30d: tenant.orders.length,
      seatsUsed: tenant.seatsUsed,
      seatLimit: seatLimitOf(tenant),
    }
  }

  listTenants(): TenantSummary[] {
    this.require()
    return this.tenants.map((tenant) => this.summarise(tenant))
  }

  private modulesOf(tenant: PlatformTenant): ModuleId[] {
    return tenantModules(tenant, this.grants[tenant.tier])
  }

  getTenant(tenantId: string): TenantDetail {
    this.require()
    const tenant = this.find(tenantId)
    const modules = this.modulesOf(tenant)
    return {
      ...this.summarise(tenant),
      ownerName: tenant.ownerName,
      ownerEmail: tenant.ownerEmail,
      ownerPhone: tenant.ownerPhone,
      taxId: tenant.taxId,
      address: `${tenant.city} ${tenant.address}`,
      currency: ENVIRONMENT.currency,
      locale: ENVIRONMENT.locale,
      timezone: ENVIRONMENT.timezone,
      // Every row carries why it is held, which is the question a specialist is
      // actually asking of this list.
      modules: modules.map((moduleId) => ({
        moduleId,
        source: tenant.overrides.includes(moduleId)
          ? ('override' as const)
          : MODULES[moduleId].kind === 'always_on'
            ? ('profile' as const)
            : ('tier' as const),
        pending: false,
      })),
      statusNote: tenant.status === 'suspended' ? tenant.healthNote : '',
      integrations: integrationsOf(tenant, modules),
      quotas: quotasOf(tenant, modules),
      revenue: tenant.revenue.map((entry) => ({ day: entry.day, gross: huf(entry.grossMinor) })),
      refunded30d: huf(tenant.refundedMinor),
      subscription: {
        tier: tenant.tier,
        amount: mrrOf(tenant),
        cycle: 'Monthly, on the first',
        nextChargeAt: tenant.status === 'trial' ? null : '2026-10-01T00:00:00.000Z',
        paymentMethod: tenant.paymentMethod,
        dunningState: tenant.dunningState,
        lifetimeBilled: money(mrrOf(tenant).minor * 11, CURRENCY),
      },
    }
  }

  tenantOrders(tenantId: string): TenantOrder[] {
    this.require()
    return this.find(tenantId).orders
  }

  tenantInvoices(tenantId: string): PlatformInvoice[] {
    this.require()
    return invoicesOf(this.find(tenantId))
  }

  /**
   * Suspends or reinstates a tenant.
   *
   * A reason is required and is not decorative: it is the only part of the
   * audit record a person could not have derived from the change itself.
   */
  setStatus(tenantId: string, status: TenantStatus, reason: string): TenantDetail {
    this.requireWrite()
    const tenant = this.find(tenantId)
    if (!reason.trim()) {
      throw new MockError(422, 'invalid', 'Say why. It goes on the audit record.', [
        { field: 'reason', message: 'A reason is required.' },
      ])
    }
    if (tenant.status === status) {
      throw new MockError(409, 'no_change', `This tenant is already ${status}.`)
    }
    if (tenant.status === 'provisioning') {
      throw new MockError(
        409,
        'still_provisioning',
        'This tenant is still being set up. Finish or cancel the run first.',
      )
    }
    tenant.status = status
    tenant.health = status === 'suspended' ? 'failing' : 'ok'
    tenant.healthNote =
      status === 'suspended' ? `Suspended by a specialist: ${reason}` : 'Nothing outstanding.'
    this.record(
      status === 'suspended' ? 'tenant.suspended' : 'tenant.reinstated',
      reason,
      tenant,
    )
    return this.getTenant(tenantId)
  }

  /**
   * Moves a tenant between tiers.
   *
   * The modules follow from the tier, so nothing is written here except the
   * tier itself. An override the specialist recorded earlier survives, which
   * is the point of recording it against the tenant rather than the tier.
   */
  setTier(tenantId: string, tier: TierId, reason: string): TenantDetail {
    this.requireWrite()
    const tenant = this.find(tenantId)
    if (tenant.tier === tier) {
      throw new MockError(409, 'no_change', `This tenant is already on ${TIERS[tier].name}.`)
    }
    const limit = TIERS[tier].seats
    if (limit !== null && tenant.seatsUsed > limit) {
      throw new MockError(
        409,
        'seats_exceeded',
        `${TIERS[tier].name} allows ${limit} seats and this tenant is using ${tenant.seatsUsed}. Remove staff first.`,
      )
    }
    const from = tenant.tier
    tenant.tier = tier
    this.record(
      'tenant.tier.changed',
      `${TIERS[from].name} to ${TIERS[tier].name}. ${reason}`.trim(),
      tenant,
    )
    return this.getTenant(tenantId)
  }

  /**
   * Grants or withdraws one module against the tier.
   *
   * Withdrawing is refused when something the tenant holds depends on it. The
   * gateway would enforce the dependency anyway, so allowing it here would
   * only produce a record whose modules do not resolve.
   */
  overrideModule(tenantId: string, input: ModuleOverrideInput): TenantDetail {
    this.requireWrite()
    const tenant = this.find(tenantId)
    const { moduleId, entitled, reason } = input
    if (!reason.trim()) {
      throw new MockError(422, 'invalid', 'Say why. Overrides are audited.', [
        { field: 'reason', message: 'A reason is required.' },
      ])
    }
    if (MODULES[moduleId].kind === 'always_on') {
      throw new MockError(
        409,
        'always_on',
        `${MODULES[moduleId].name} ships with every tenant and is not switched on or off.`,
      )
    }

    if (entitled) {
      tenant.withdrawn = tenant.withdrawn.filter((id) => id !== moduleId)
      if (!tenant.overrides.includes(moduleId)) tenant.overrides.push(moduleId)
    } else {
      const held = new Set(this.modulesOf(tenant))
      const blocking = dependentsOf(moduleId).filter((id) => held.has(id))
      if (blocking.length > 0) {
        const names = blocking.map((id) => MODULES[id].name).join(' and ')
        throw new MockError(
          409,
          'dependency',
          `${names} needs ${MODULES[moduleId].name}. Withdraw that first.`,
        )
      }
      tenant.overrides = tenant.overrides.filter((id) => id !== moduleId)
      if (!tenant.withdrawn.includes(moduleId)) tenant.withdrawn.push(moduleId)
    }

    this.record(
      'entitlement.changed',
      `${MODULES[moduleId].name} ${entitled ? 'granted' : 'withdrawn'}. ${reason}`,
      tenant,
    )
    // What the gateway does next, said out loud, because the merchant sees the
    // change on their next request rather than when a cache expires.
    this.record(
      entitled ? 'module.enabled' : 'module.disabled',
      'Gateway policy cache invalidated.',
      tenant,
    )
    return this.getTenant(tenantId)
  }

  /* -------------------------------------------------------- provisioning */

  private runOf(tenant: PlatformTenant): ProvisioningRun | null {
    if (!tenant.onboarding) return null
    return {
      tenantId: tenant.tenantId,
      tenantName: tenant.name,
      tier: tenant.tier,
      sagaId: `sg_${tenant.merchantCode.toLowerCase()}`,
      specialist: tenant.specialist,
      state: tenant.onboarding,
    }
  }

  provisioningQueue(): ProvisioningRun[] {
    this.require()
    return this.tenants
      .map((tenant) => this.runOf(tenant))
      .filter((run): run is ProvisioningRun => run !== null)
      .sort((left, right) => left.state.dueAt.localeCompare(right.state.dueAt))
  }

  provisioningRun(tenantId: string): ProvisioningRun {
    this.require()
    const run = this.runOf(this.find(tenantId))
    if (!run) {
      throw new MockError(404, 'not_found', 'This tenant is live. Its run was archived.')
    }
    return run
  }

  retryStep(tenantId: string, stepId: string): ProvisioningRun {
    this.requireWrite()
    const tenant = this.find(tenantId)
    const state: OnboardingState | null = tenant.onboarding
    if (!state) throw new MockError(404, 'not_found', 'This tenant has no run in flight.')
    const step = state.steps.find((entry) => entry.id === stepId)
    if (!step) throw new MockError(404, 'not_found', 'No step with that id.')
    if (step.status === 'done') {
      throw new MockError(409, 'already_done', 'That step already finished.')
    }

    tenant.onboarding = {
      ...state,
      steps: state.steps.map((entry) =>
        entry.id === stepId ? { ...entry, status: 'in_progress' as const } : entry,
      ),
    }
    this.record('provisioning.step.retried', `${step.title} re-run.`, tenant)
    return this.provisioningRun(tenantId)
  }

  /* ----------------------------------------------------- support sessions */

  private pastSessions(): SupportSession[] {
    const rows: Array<[string, string, string, ImpersonationMode, number, string]> = [
      ['tn_etterem', 'Corvin Étterem', 'Dóra Halász', 'read', 12, 'Ticket 4790, receipt footer wrong'],
      ['tn_szerviz', 'Móra Autószerviz', 'Ádám Bíró', 'write', 7, 'Ticket 4781, reinstate after payment'],
      ['tn_pekseg', 'Bodnár Pékség', 'Judit Vas', 'read', 4, 'Ticket 4776, invoice stuck in the queue'],
      ['tn_fogaszat', 'Pesti Fogászat', 'Márk Szendrei', 'write', 21, 'Ticket 4769, booking buffer wrong'],
      ['tn_bike', 'Buda Bike Műhely', 'Judit Vas', 'read', 15, 'Ticket 4744, refund stuck in pending'],
    ]
    return rows.map(([tenantId, tenantName, staffName, mode, minutes, reason], index) => {
      const startedAt = new Date(NOW.getTime() - (index + 1) * 7 * 3_600_000)
      const endedAt = new Date(startedAt.getTime() + minutes * 60_000)
      return {
        sessionId: `ss_past_${index}`,
        tenantId,
        tenantName,
        staffName,
        mode,
        reason,
        startedAt: startedAt.toISOString(),
        expiresAt: endedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        handoffUrl: `${MERCHANT_ORIGIN}/`,
      }
    })
  }

  listSessions(): SupportSession[] {
    this.require()
    return this.sessions
  }

  private roleMode(): ImpersonationMode | null {
    return ADMIN_ROLES.find((role) => role.id === this.session.role)?.impersonation ?? null
  }

  /**
   * Opens a support session.
   *
   * One at a time per specialist. Two open tokens mean the audit log cannot
   * say which tenant an action belonged to without guessing from the payload,
   * and the whole value of the record is that it does not have to guess.
   */
  startSession(input: StartSupportSessionInput): SupportSession {
    this.require()
    const tenant = this.find(input.tenantId)
    const allowed = this.roleMode()
    if (allowed === null) {
      throw new MockError(403, 'forbidden', 'Your role may not impersonate a merchant.')
    }
    if (input.mode === 'write' && allowed !== 'write') {
      throw new MockError(403, 'forbidden', 'Your role may only open a read-only session.')
    }
    if (this.sessions.some((entry) => entry.endedAt === null)) {
      throw new MockError(409, 'session_open', 'Close your open session first.')
    }
    if (!input.reason.trim()) {
      throw new MockError(422, 'invalid', 'Say why you are going in.', [
        { field: 'reason', message: 'A reason is required.' },
      ])
    }

    const minutes = input.mode === 'write' ? WRITE_TTL_MINUTES : READ_TTL_MINUTES
    const now = new Date()
    const session: SupportSession = {
      sessionId: `ss_${this.sessionSeq++}_${now.getTime().toString(36)}`,
      tenantId: tenant.tenantId,
      tenantName: tenant.name,
      staffName: this.session.name,
      mode: input.mode,
      reason: input.reason.trim(),
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      endedAt: null,
      // The tenant travels in the token, not the URL. A tenant id in a query
      // string is a tenant id somebody can edit.
      handoffUrl: `${MERCHANT_ORIGIN}/`,
    }
    this.sessions.unshift(session)
    this.record(
      'impersonation.started',
      `${input.mode === 'write' ? 'Read and write' : 'Read-only'} token for ${minutes} minutes. ${session.reason}`,
      tenant,
      input.mode === 'write' ? 'tenant:read, tenant:write' : 'tenant:read',
    )
    return session
  }

  /**
   * Raises a read-only token to write.
   *
   * A new token at a new scope, not a flag flipped on the old one, so
   * impersonation.started is emitted again and the audit log carries two
   * records with two reasons rather than one record whose scope changed.
   */
  elevateSession(sessionId: string, reason: string): SupportSession {
    this.require()
    const index = this.sessions.findIndex((entry) => entry.sessionId === sessionId)
    const session = this.sessions[index]
    if (index < 0 || !session) throw new MockError(404, 'not_found', 'No such session.')
    if (session.endedAt !== null) {
      throw new MockError(409, 'ended', 'That session has already ended.')
    }
    if (session.mode === 'write') {
      throw new MockError(409, 'already_write', 'That session already has write access.')
    }
    if (this.roleMode() !== 'write') {
      throw new MockError(403, 'forbidden', 'Your role may not elevate to write.')
    }
    if (!reason.trim()) {
      throw new MockError(422, 'invalid', 'Write access needs a reason.', [
        { field: 'reason', message: 'A reason is required.' },
      ])
    }

    const now = new Date()
    const raised: SupportSession = {
      ...session,
      mode: 'write',
      reason: reason.trim(),
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WRITE_TTL_MINUTES * 60_000).toISOString(),
    }
    this.sessions[index] = raised
    this.record(
      'impersonation.started',
      `Elevated to write for ${WRITE_TTL_MINUTES} minutes. ${raised.reason}`,
      this.find(session.tenantId),
      'tenant:read, tenant:write',
    )
    return raised
  }

  /** Buys ten more minutes on the same scope. Never a fresh full window. */
  extendSession(sessionId: string): SupportSession {
    this.require()
    const index = this.sessions.findIndex((entry) => entry.sessionId === sessionId)
    const session = this.sessions[index]
    if (index < 0 || !session) throw new MockError(404, 'not_found', 'No such session.')
    if (session.endedAt !== null) {
      throw new MockError(409, 'ended', 'That session has already ended.')
    }
    const extended: SupportSession = {
      ...session,
      expiresAt: new Date(new Date(session.expiresAt).getTime() + 10 * 60_000).toISOString(),
    }
    this.sessions[index] = extended
    this.record('impersonation.extended', 'Ten more minutes.', this.find(session.tenantId))
    return extended
  }

  revokeSession(sessionId: string): void {
    this.require()
    this.closeSession(sessionId, 'closed by the specialist')
  }

  private closeSession(sessionId: string, why: string): void {
    const index = this.sessions.findIndex((entry) => entry.sessionId === sessionId)
    const session = this.sessions[index]
    if (index < 0 || !session) throw new MockError(404, 'not_found', 'No such session.')
    if (session.endedAt !== null) return
    this.sessions[index] = { ...session, endedAt: new Date().toISOString() }
    const tenant = this.tenants.find((entry) => entry.tenantId === session.tenantId)
    this.record('impersonation.ended', why, tenant ?? null)
  }

  /* ------------------------------------------------------------- registry */

  listTiers(): TierRegistryEntry[] {
    this.require()
    return TIER_IDS.map((tier) => {
      const grants = this.grants[tier]
      const modules = resolveDependencies(grants)
      const monthly = TIERS[tier].monthlyMinor
      return {
        tier,
        grants,
        modules,
        seats: TIERS[tier].seats,
        // Enterprise is quoted, so the registry carries no list price and the
        // console must show that rather than a zero.
        monthly: monthly === null ? null : huf(monthly * 4),
        tenants: this.tenants.filter((tenant) => tenant.tier === tier).length,
        autoProvision: autoProvisionable(grants),
        needsSpecialist: requiresSpecialist(modules),
      }
    })
  }

  /**
   * Rewrites what a tier grants.
   *
   * The blast radius is every tenant on the tier, so the refusals here are the
   * ones a registry would make: a tier cannot drop a module another module in
   * the same tier needs, and Starter cannot end up granting more than Growth,
   * which would make an upgrade a downgrade.
   */
  setTierGrants(tier: TierId, grants: readonly ModuleId[]): TierRegistryEntry[] {
    this.requireWrite()
    // Specialist holds entitlement:*:* and still cannot do this. That is what
    // "can provision, not change pricing" comes to: an entitlement change
    // touches one tenant, and this rewrites every tenant on the tier.
    if (this.session.role !== 'platform_admin') {
      throw new MockError(403, 'forbidden', 'Only a platform admin edits the tier registry.')
    }
    const unknown = grants.filter((id) => !(id in MODULES))
    if (unknown.length > 0) {
      throw new MockError(422, 'invalid', `Not a module: ${unknown.join(', ')}.`)
    }

    const previous = this.grants[tier]
    this.grants[tier] = [...grants]

    // Tiers are a ladder. If a higher tier ends up granting less than a lower
    // one, an upgrade takes something away, and the tenant it happens to finds
    // out when a screen disappears.
    const ladder = TIER_IDS.map((id) => new Set(resolveDependencies(this.grants[id])))
    for (let index = 1; index < TIER_IDS.length; index++) {
      const lower = ladder[index - 1]
      const higher = ladder[index]
      if (!lower || !higher) continue
      const lost = [...lower].filter((id) => !higher.has(id))
      if (lost.length > 0) {
        this.grants[tier] = previous
        const names = lost.map((id) => MODULES[id].name).join(', ')
        throw new MockError(
          409,
          'ladder',
          `${TIERS[TIER_IDS[index] as TierId].name} would grant less than ${TIERS[TIER_IDS[index - 1] as TierId].name}: ${names}.`,
        )
      }
    }

    const affected = this.tenants.filter((tenant) => tenant.tier === tier)
    this.record(
      'registry.tier.changed',
      `${TIERS[tier].name} now grants ${grants.length} modules. ${affected.length} tenants rewritten, gateway cache invalidated.`,
      null,
    )
    return this.listTiers()
  }

  /* -------------------------------------------------------------- money */

  billing(): PlatformBilling {
    this.require()
    const billable = this.tenants.filter((tenant) => tenant.status !== 'trial')
    const mrr = billable.reduce<Money>((sum, tenant) => addMoney(sum, mrrOf(tenant)), zero(CURRENCY))

    const mix: TierMix[] = TIER_IDS.map((tier) => {
      const rows = this.tenants.filter((tenant) => tenant.tier === tier)
      return {
        tier,
        tenants: rows.length,
        mrr: rows
          .filter((tenant) => tenant.status !== 'trial')
          .reduce<Money>((sum, tenant) => addMoney(sum, mrrOf(tenant)), zero(CURRENCY)),
      }
    })

    const chased = this.tenants.filter((tenant) => tenant.dunningState !== null)
    const dunning: DunningEntry[] = chased.map((tenant) => ({
      tenantId: tenant.tenantId,
      tenantName: tenant.name,
      reason: tenant.healthNote,
      attempt: tenant.dunningState ?? '',
      amount: mrrOf(tenant),
      health: tenant.health,
    }))

    const recent = this.tenants.filter(
      (tenant) => new Date(tenant.onboardedAt).getTime() > NOW.getTime() - 30 * 86_400_000,
    )

    return {
      mrr,
      arrRunRate: money(mrr.minor * 12, CURRENCY),
      netNewMrr: recent.reduce<Money>((sum, tenant) => addMoney(sum, mrrOf(tenant)), zero(CURRENCY)),
      failedCharges: chased.length,
      atRisk: dunning.reduce<Money>((sum, entry) => addMoney(sum, entry.amount), zero(CURRENCY)),
      mix,
      dunning,
    }
  }

  overview(): AdminOverview {
    this.require()
    return {
      environment: ENVIRONMENT,
      session: this.session,
      tenants: this.tenants.length,
      live: this.tenants.filter((tenant) => tenant.status === 'live').length,
      provisioning: this.tenants.filter((tenant) => tenant.status === 'provisioning').length,
    }
  }
}

let current: AdminStore | null = null

export function adminStore(): AdminStore {
  if (!current) current = new AdminStore()
  return current
}

/** Throws the fixture away. Used by tests, never by the console. */
export function resetAdminStore(): AdminStore {
  current = new AdminStore()
  return current
}
