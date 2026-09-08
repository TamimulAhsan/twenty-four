import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MODULES, TIERS, tierModules, type ModuleId } from '@twentyfour/entitlement'
import { MockError } from '../store'
import { AdminStore, resetAdminStore } from './store'

/**
 * The admin plane, tested at its refusals.
 *
 * Almost every screen in the console is a read, and a read that is wrong is
 * visibly wrong. What is not visible is the set of things the console must not
 * let a specialist do, and those are what this file is about: acting signed
 * out, acting beyond a role, withdrawing a module something else needs,
 * suspending without a reason, holding two support tokens at once.
 *
 * Each of them would look like a working console right up until it was used.
 */
const OWNER = 'st_adam'
const SUPPORT = 'st_mark'
const NO_MFA = 'st_zita'

/** The cafe fixture, which the merchant applications also run on. */
const CAFE = 'cafe'
/** Still being set up, with a failed step. */
const STUCK = 'tn_fitness'
/** Suspended for non-payment. */
const SUSPENDED = 'tn_szerviz'

/** The module ids a tenant holds, whatever the reason. */
const held = (detail: { modules: readonly { moduleId: string }[] }): string[] =>
  detail.modules.map((m) => m.moduleId)

/** The ones a specialist granted against the tier. */
const overrides = (detail: { modules: readonly { moduleId: string; source: string }[] }): string[] =>
  detail.modules.filter((m) => m.source === 'override').map((m) => m.moduleId)

function thrown(work: () => unknown): MockError {
  try {
    work()
  } catch (error) {
    if (error instanceof MockError) return error
    throw error
  }
  throw new Error('expected the call to be refused, and it was not')
}

let store: AdminStore

beforeEach(() => {
  store = resetAdminStore()
})

describe('the door', () => {
  it('answers null rather than throwing before anyone signs in', () => {
    expect(store.currentSession()).toBeNull()
  })

  it('has no sign-in of its own: a specialist arrives holding a code', () => {
    // One form, on the merchant origin. The address is what resolves the
    // plane, so an address that is not a specialist gets no code at all.
    expect(store.issueHandoff('anna@nyolcaskavezo.hu')).toBeNull()
    expect(store.issueHandoff('nobody@example.com')).toBeNull()

    const code = store.issueHandoff('mark@twentyfour.hu')
    expect(code).toBeTruthy()
    expect(store.currentSession()).toBeNull()

    const session = store.redeemHandoff(code ?? '')
    expect(session.role).toBe('support')
    expect(store.currentSession()?.email).toBe('mark@twentyfour.hu')
  })

  it('spends a code on first use', () => {
    const code = store.issueHandoff('adam@twentyfour.hu') ?? ''
    store.redeemHandoff(code)
    store.signOut()
    // A replay is the case this exists to stop: the code travelled in a URL,
    // so anything holding that URL must not be able to sign in with it.
    expect(thrown(() => store.redeemHandoff(code)).status).toBe(401)
    expect(store.currentSession()).toBeNull()
  })

  it('refuses a code it never issued, the same way it refuses a spent one', () => {
    const spent = store.issueHandoff('adam@twentyfour.hu') ?? ''
    store.redeemHandoff(spent)
    store.signOut()
    const replayed = thrown(() => store.redeemHandoff(spent))
    const invented = thrown(() => store.redeemHandoff('hc_never_existed'))
    // Identical answers. Telling them apart would say something about a code
    // the caller does not hold.
    expect(invented.status).toBe(replayed.status)
    expect(invented.message).toBe(replayed.message)
  })

  it('refuses a code that has expired', () => {
    vi.useFakeTimers()
    try {
      const code = store.issueHandoff('adam@twentyfour.hu') ?? ''
      // The window is thirty seconds because the browser follows the redirect
      // immediately. A minute later is long past useful.
      vi.advanceTimersByTime(60_000)
      expect(thrown(() => store.redeemHandoff(code)).status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses every read until somebody signs in', () => {
    expect(thrown(() => store.listTenants()).status).toBe(401)
    expect(thrown(() => store.billing()).status).toBe(401)
    expect(thrown(() => store.listAudit()).status).toBe(401)
  })

  it('refuses an account with no second factor', () => {
    const error = thrown(() => store.signIn(NO_MFA))
    expect(error.status).toBe(403)
    expect(error.code).toBe('mfa_required')
    expect(store.currentSession()).toBeNull()
  })

  it('signs in as the named specialist, with their role', () => {
    const session = store.signIn(SUPPORT)
    expect(session.role).toBe('support')
    expect(store.currentSession()?.staffId).toBe(SUPPORT)
  })

  it('signs in by role, skipping an account the gateway would refuse', () => {
    // Three people hold support; one has no second factor. Asking for the role
    // must land on somebody who could actually get through the door.
    const session = store.signIn('support')
    expect(session.role).toBe('support')
    expect(session.staffId).not.toBe(NO_MFA)
    expect(session.mfa).toBeTruthy()
  })
})

describe('the tenant directory', () => {
  beforeEach(() => store.signIn(OWNER))

  it('carries the merchant fixtures under their own names and tiers', () => {
    const cafe = store.listTenants().find((tenant) => tenant.tenantId === CAFE)
    expect(cafe).toBeDefined()
    // Read from the seed rather than restated, so the console and the till
    // cannot disagree about what this business is called or is paying for.
    expect(cafe?.name).toBe('Nyolcas Kávézó')
    expect(cafe?.industry).toBe('cafe')
  })

  it('keeps health as a value, not something parsed out of the sentence', () => {
    const stuck = store.listTenants().find((tenant) => tenant.tenantId === STUCK)
    expect(stuck?.health).toBe('failing')
    // The sentence happens to contain "refused" and not "failed". A console
    // that recovered the level by searching the prose would get this wrong.
    expect(stuck?.healthNote).not.toContain('failing')
  })

  it('gives a merchant code, not a database id, as the thing people quote', () => {
    for (const tenant of store.listTenants()) {
      // Crockford base32 with I, L, O and U excluded.
      expect(tenant.merchantCode).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/)
    }
  })

  it('never repeats a merchant code', () => {
    const codes = store.listTenants().map((tenant) => tenant.merchantCode)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('changing what a tenant holds', () => {
  beforeEach(() => store.signIn(OWNER))

  it('grants a module against the tier without moving the price', () => {
    const before = store.getTenant(CAFE)
    const after = store.overrideModule(CAFE, {
      moduleId: 'crm',
      entitled: true,
      reason: 'Ticket 4801, goodwill after the outage',
    })
    expect(held(after)).toContain('crm')
    expect(overrides(after)).toContain('crm')
    expect(after.tier).toBe(before.tier)
    expect(after.subscription?.amount.minor).toBe(before.subscription?.amount.minor)
  })

  it('pulls in what the granted module needs', () => {
    const after = store.overrideModule(CAFE, {
      moduleId: 'ai_creative',
      entitled: true,
      reason: 'Ticket 4802, trialling creative for a month',
    })
    // ai_creative requires marketing_ads, which requires advanced_analytics.
    for (const required of MODULES.ai_creative.requires) {
      expect(held(after)).toContain(required)
    }
    expect(held(after)).toContain('advanced_analytics')
  })

  it('refuses to withdraw a module something they hold depends on', () => {
    const modules = held(store.getTenant(CAFE))
    expect(modules).toContain('catalog')
    expect(modules).toContain('pos_orders')
    const error = thrown(() =>
      store.overrideModule(CAFE, { moduleId: 'catalog', entitled: false, reason: 'tidying up' }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('dependency')
    expect(error.message).toContain('POS and orders')
  })

  it('refuses to switch off something that ships with every tenant', () => {
    const error = thrown(() =>
      store.overrideModule(CAFE, {
        moduleId: 'notifications',
        entitled: false,
        reason: 'they asked',
      }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('always_on')
  })

  it('will not change anything without a reason', () => {
    const error = thrown(() =>
      store.overrideModule(CAFE, { moduleId: 'crm', entitled: true, reason: '   ' }),
    )
    expect(error.status).toBe(422)
    expect(error.fieldErrors[0]?.field).toBe('reason')
  })

  it('records the change and the cache invalidation that follows it', () => {
    store.overrideModule(CAFE, {
      moduleId: 'crm',
      entitled: true,
      reason: 'Ticket 4801, goodwill',
    })
    const trail = store.tenantAudit(CAFE).map((entry) => entry.event)
    expect(trail).toContain('entitlement.changed')
    expect(trail).toContain('module.enabled')
    expect(store.tenantAudit(CAFE)[0]?.actor).toBe('Ádám Bíró')
  })
})

describe('moving a tenant between tiers', () => {
  beforeEach(() => store.signIn(OWNER))

  it('refuses a downgrade that would leave more staff than the tier allows', () => {
    // The clothing fixture runs six seats; Starter allows three.
    const shop = store.listTenants().find((tenant) => tenant.tenantId === 'shop')
    expect(shop?.seatsUsed).toBeGreaterThan(TIERS.starter.seats ?? 0)
    const error = thrown(() => store.setTier('shop', 'starter', 'cost saving'))
    expect(error.status).toBe(409)
    expect(error.code).toBe('seats_exceeded')
  })

  it('refuses a move to the tier they are already on', () => {
    const current = store.getTenant(CAFE).tier
    expect(thrown(() => store.setTier(CAFE, current, 'no reason')).code).toBe('no_change')
  })

  it('keeps an override across a tier change', () => {
    store.overrideModule(CAFE, { moduleId: 'crm', entitled: true, reason: 'goodwill' })
    const after = store.setTier(CAFE, 'max', 'upgrade agreed on the call')
    expect(after.tier).toBe('max')
    expect(overrides(after)).toContain('crm')
  })
})

describe('suspending a tenant', () => {
  beforeEach(() => store.signIn(OWNER))

  it('will not suspend without a reason', () => {
    const error = thrown(() => store.setStatus(CAFE, 'suspended', ''))
    expect(error.status).toBe(422)
  })

  it('will not suspend a tenant that is still being set up', () => {
    const error = thrown(() => store.setStatus(STUCK, 'suspended', 'not paying'))
    expect(error.code).toBe('still_provisioning')
  })

  it('reinstates and clears the health note', () => {
    const after = store.setStatus(SUSPENDED, 'live', 'Ticket 4781, paid in full')
    expect(after.status).toBe('live')
    expect(after.health).toBe('ok')
    expect(store.tenantAudit(SUSPENDED)[0]?.event).toBe('tenant.reinstated')
  })
})

describe('roles', () => {
  it('lets support read everything and change nothing', () => {
    // Support holds tenant:*:read and entitlement:*:read in RBAC, and no write
    // grant anywhere. The console refuses the same set the gateway would.
    store.signIn(SUPPORT)
    expect(store.listTenants().length).toBeGreaterThan(0)
    expect(store.listAudit().length).toBeGreaterThan(0)
    expect(thrown(() => store.setStatus(CAFE, 'suspended', 'because')).status).toBe(403)
    expect(
      thrown(() => store.overrideModule(CAFE, { moduleId: 'crm', entitled: true, reason: 'x' }))
        .status,
    ).toBe(403)
  })

  it('lets support open a read-only session but not a write one', () => {
    store.signIn(SUPPORT)
    const error = thrown(() =>
      store.startSession({ tenantId: CAFE, mode: 'write', reason: 'fixing a refund' }),
    )
    expect(error.status).toBe(403)
    const session = store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    expect(session.mode).toBe('read')
  })

  it('keeps the tier registry to the platform owner', () => {
    store.signIn(SUPPORT)
    const error = thrown(() => store.setTierGrants('starter', ['pos_orders']))
    expect(error.status).toBe(403)
  })
})

describe('support sessions', () => {
  beforeEach(() => store.signIn(OWNER))

  it('starts read-only, scoped to one tenant, with an expiry', () => {
    const session = store.startSession({
      tenantId: CAFE,
      mode: 'read',
      reason: 'Ticket 4820, receipt footer',
    })
    expect(session.tenantId).toBe(CAFE)
    expect(session.mode).toBe('read')
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(
      new Date(session.startedAt).getTime(),
    )
    expect(session.endedAt).toBeNull()
  })

  it('hands off to the merchant application rather than a copy of it', () => {
    const session = store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    // The tenant travels in the token. A tenant id in the URL is a tenant id
    // somebody can edit.
    expect(session.handoffUrl).not.toContain(CAFE)
    expect(session.handoffUrl).toContain('app.')
  })

  it('refuses a second open session', () => {
    store.startSession({ tenantId: CAFE, mode: 'read', reason: 'first' })
    const error = thrown(() =>
      store.startSession({ tenantId: 'shop', mode: 'read', reason: 'second' }),
    )
    expect(error.code).toBe('session_open')
  })

  it('will not start one without a reason', () => {
    expect(thrown(() => store.startSession({ tenantId: CAFE, mode: 'read', reason: '' })).status)
      .toBe(422)
  })

  it('emits impersonation.started again when a session is raised to write', () => {
    const session = store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    const before = store.tenantAudit(CAFE).filter((e) => e.event === 'impersonation.started').length
    const raised = store.elevateSession(session.sessionId, 'Ticket 4820, refund stuck in pending')
    expect(raised.mode).toBe('write')
    const after = store.tenantAudit(CAFE).filter((e) => e.event === 'impersonation.started')
    expect(after.length).toBe(before + 1)
    expect(after[0]?.scope).toContain('tenant:write')
  })

  it('will not raise to write without a reason', () => {
    const session = store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    expect(thrown(() => store.elevateSession(session.sessionId, ' ')).status).toBe(422)
  })

  it('shortens the window when the scope widens', () => {
    const session = store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    const readWindow = new Date(session.expiresAt).getTime() - new Date(session.startedAt).getTime()
    const raised = store.elevateSession(session.sessionId, 'Ticket 4820')
    const writeWindow = new Date(raised.expiresAt).getTime() - new Date(raised.startedAt).getTime()
    expect(writeWindow).toBeLessThan(readWindow)
  })

  it('closes every open token when the specialist signs out', () => {
    store.startSession({ tenantId: CAFE, mode: 'read', reason: 'looking' })
    store.signOut()
    store.signIn(OWNER)
    expect(store.listSessions().every((entry) => entry.endedAt !== null)).toBe(true)
  })
})

describe('the provisioning queue', () => {
  beforeEach(() => store.signIn(OWNER))

  it('holds only tenants still being set up', () => {
    const queue = store.provisioningQueue()
    expect(queue.length).toBeGreaterThan(0)
    const setting = store.listTenants().filter((tenant) => tenant.status === 'provisioning')
    expect(queue.length).toBe(setting.length)
  })

  it('orders by deadline, so the promise closest to breaking is first', () => {
    const due = store.provisioningQueue().map((run) => run.state.dueAt)
    expect(due).toEqual([...due].sort())
  })

  it('has no run for a tenant that already went live', () => {
    expect(thrown(() => store.provisioningRun(CAFE)).status).toBe(404)
  })

  it('uses the merchant’s own checklist rows rather than a second model', () => {
    const run = store.provisioningRun(STUCK)
    // The same twelve steps the dashboard renders, with the same ids.
    expect(run.state.steps.map((step) => step.id)).toContain('first_sale')
    expect(run.state.steps.every((step) => [0, 4, 12, 24].includes(step.hour))).toBe(true)
  })

  it('re-runs a failed step and records it', () => {
    const before = store.provisioningRun(STUCK)
    const failed = before.state.steps.find((step) => step.status === 'failed')
    expect(failed).toBeDefined()
    const after = store.retryStep(STUCK, failed?.id ?? '')
    const step = after.state.steps.find((entry) => entry.id === failed?.id)
    expect(step?.status).toBe('in_progress')
    expect(store.tenantAudit(STUCK)[0]?.event).toBe('provisioning.step.retried')
  })

  it('refuses to re-run a step that already finished', () => {
    const run = store.provisioningRun(STUCK)
    const done = run.state.steps.find((step) => step.status === 'done')
    expect(done).toBeDefined()
    expect(thrown(() => store.retryStep(STUCK, done?.id ?? '')).code).toBe('already_done')
  })
})

describe('the tier registry', () => {
  beforeEach(() => store.signIn(OWNER))

  it('reports what each tier grants and what that resolves to', () => {
    for (const row of store.listTiers()) {
      expect(row.grants).toEqual([...TIERS[row.tier].grants])
      expect(row.modules).toEqual(tierModules(row.tier))
    }
  })

  it('derives whether a tier goes live unattended from its modules', () => {
    const rows = store.listTiers()
    // Growth grants marketing, whose ad-account consent only the owner can
    // give, so it cannot complete on its own.
    const growth = rows.find((row) => row.tier === 'growth')
    expect(growth?.autoProvision).toBe(false)
    expect(growth?.needsSpecialist).toContain('marketing_ads')
    for (const row of rows) {
      expect(row.autoProvision).toBe(row.needsSpecialist.length === 0)
    }
  })

  it('carries no list price for the tier that is quoted', () => {
    expect(store.listTiers().find((row) => row.tier === 'enterprise')?.monthly).toBeNull()
  })

  it('refuses a change that would make an upgrade take something away', () => {
    // Starter granting the CRM would leave Growth, which does not, below it.
    const grants: ModuleId[] = [...TIERS.starter.grants, 'crm']
    const error = thrown(() => store.setTierGrants('starter', grants))
    expect(error.status).toBe(409)
    expect(error.code).toBe('ladder')
    // And it left the registry as it found it.
    expect(store.listTiers().find((row) => row.tier === 'starter')?.grants).not.toContain('crm')
  })

  it('rewrites every tenant on the tier when it does apply', () => {
    const before = store.getTenant(CAFE)
    expect(before.tier).toBe('growth')
    expect(held(before)).not.toContain('crm')
    store.setTierGrants('growth', [...TIERS.growth.grants, 'crm'])
    expect(held(store.getTenant(CAFE))).toContain('crm')
    // And it arrives as a tier grant, not an override: nobody recorded it
    // against this tenant, and the source is what says so.
    expect(overrides(store.getTenant(CAFE))).not.toContain('crm')
  })

  it('records the blast radius, not just the change', () => {
    store.setTierGrants('growth', [...TIERS.growth.grants, 'crm'])
    const entry = store.listAudit().find((row) => row.event === 'registry.tier.changed')
    expect(entry?.detail).toMatch(/tenants rewritten/)
  })
})

describe('the books', () => {
  beforeEach(() => store.signIn(OWNER))

  it('leaves trials out of recurring revenue', () => {
    const trial = store.listTenants().find((tenant) => tenant.status === 'trial')
    expect(trial).toBeDefined()
    const billing = store.billing()
    const everyone = store
      .listTenants()
      .reduce((sum, tenant) => sum + (tenant.mrr?.minor ?? 0), 0)
    expect(billing.mrr.minor).toBeLessThan(everyone)
    expect(billing.mrr.minor).toBe(everyone - (trial?.mrr?.minor ?? 0))
  })

  it('reports in this environment’s currency and nothing else', () => {
    const billing = store.billing()
    const currencies = new Set([
      billing.mrr.currency,
      billing.arrRunRate.currency,
      ...billing.mix.map((row) => row.mrr.currency),
    ])
    expect(currencies.size).toBe(1)
  })

  it('counts every tenant in the tier mix, paying or not', () => {
    const billing = store.billing()
    const counted = billing.mix.reduce((sum, row) => sum + row.tenants, 0)
    expect(counted).toBe(store.listTenants().length)
  })
})
