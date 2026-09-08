import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockError, resetStore, storeFor, type TenantStore } from './store'
import { fixtureForIndustry, readSignup } from './signup'
import { freshOnboarding } from './onboarding'
import { profileCapabilities, tierModules } from '@twentyfour/entitlement'

/**
 * Signing up, and the twenty-four hours that follow.
 *
 * The signup form asks four questions and every one of them changes something
 * downstream, which is the part worth asserting: a trade that does not reach
 * the profile means the wrong vocabulary and the wrong capabilities, and a tier
 * that does not reach the entitlement record means the merchant paid for
 * modules the gateway will then refuse.
 *
 * The checklist is asserted for what it refuses to do. Two of its steps cannot
 * complete without a person, and a mock that ticked them off on a timer would
 * demonstrate the opposite of the design.
 */
describe('signing up', () => {
  let store: TenantStore

  const signup = (overrides: Partial<Parameters<TenantStore['applySignup']>[0]> = {}) =>
    store.applySignup({
      email: 'ilona@feketemacska.hu',
      displayName: 'Ilona Fekete',
      businessName: 'Fekete Macska Bisztró',
      industry: 'restaurant',
      tier: 'growth',
      ...overrides,
    })

  beforeEach(() => {
    store = resetStore('cafe')
  })

  it('puts the business name and the trade on the profile', () => {
    signup()
    expect(store.profile.name).toBe('Fekete Macska Bisztró')
    expect(store.profile.industry).toBe('restaurant')
  })

  it('signs the owner in under their own name and email', () => {
    const session = signup()
    expect(session.name).toBe('Ilona Fekete')
    expect(session.email).toBe('ilona@feketemacska.hu')
    expect(session.role).toBe('owner')
  })

  it('renames the staff record the owner holds, not just the session', () => {
    const session = signup()
    const owner = store.staff.find((member) => member.id === session.userId)
    // Two names on one person puts a different name on their sales depending on
    // which surface rendered them.
    expect(owner?.name).toBe('Ilona Fekete')
    expect(owner?.email).toBe('ilona@feketemacska.hu')
  })

  it('grants exactly what the chosen tier resolves to', () => {
    signup({ tier: 'starter' })
    expect([...store.entitlement.modules].sort()).toEqual([...tierModules('starter')].sort())
    expect(store.entitlement.tier).toBe('starter')
  })

  it('switches on the trade capabilities nobody chose', () => {
    signup({ industry: 'restaurant' })
    // Bought nothing extra: a restaurant buying POS gets a till and prep
    // screens, a candy shop buying the same POS gets a till.
    expect([...store.entitlement.capabilities].sort()).toEqual(
      [...profileCapabilities('restaurant')].sort(),
    )
  })

  it('gives a trade with no capabilities none of them', () => {
    signup({ industry: 'bookshop' })
    expect(store.entitlement.capabilities).toEqual([])
  })

  it('bills the tier that was picked', () => {
    signup({ tier: 'max' })
    expect(store.subscription.tier).toBe('max')
    expect(store.subscription.amount.minor).toBe(34900)
  })

  it('charges nothing for Enterprise, which is quoted rather than listed', () => {
    signup({ tier: 'enterprise' })
    expect(store.subscription.amount.minor).toBe(0)
  })

  it('starts a checklist whose clock runs from now', () => {
    const before = Date.now()
    signup()
    const state = store.onboarding
    expect(state).not.toBeNull()
    const started = new Date(state!.startedAt).getTime()
    const due = new Date(state!.dueAt).getTime()
    expect(started).toBeGreaterThanOrEqual(before)
    expect(due - started).toBe(24 * 60 * 60 * 1000)
    expect(state!.completedAt).toBeNull()
  })

  it('has only the intake steps done, because that is all the form did', () => {
    signup()
    const done = store.onboarding!.steps.filter((step) => step.status === 'done')
    expect(done.map((step) => step.id)).toEqual(['intake', 'plan'])
  })
})

describe('the 24-hour checklist', () => {
  let store: TenantStore

  beforeEach(() => {
    vi.useFakeTimers()
    store = resetStore('shop')
    store.onboarding = freshOnboarding()
  })

  const stepById = (id: string) => store.onboarding!.steps.find((step) => step.id === id)

  it('does not move before a step has had time to run', () => {
    const before = JSON.stringify(store.onboarding)
    store.advanceOnboarding()
    expect(JSON.stringify(store.onboarding)).toBe(before)
  })

  it('starts the next step that runs itself', () => {
    vi.advanceTimersByTime(9_000)
    store.advanceOnboarding()
    expect(stepById('entitlement')?.status).toBe('in_progress')
  })

  it('finishes a running step and records when', () => {
    vi.advanceTimersByTime(9_000)
    store.advanceOnboarding()
    vi.advanceTimersByTime(9_000)
    store.advanceOnboarding()
    expect(stepById('entitlement')?.status).toBe('done')
    expect(stepById('entitlement')?.completedAt).not.toBeNull()
  })

  it('never completes a step that is waiting on the merchant', () => {
    // Far longer than the whole checklist would take to run itself.
    for (let tick = 0; tick < 40; tick += 1) {
      vi.advanceTimersByTime(9_000)
      store.advanceOnboarding()
    }
    expect(stepById('staff_accounts')?.status).not.toBe('done')
    expect(stepById('data_import')?.status).not.toBe('done')
    expect(stepById('first_sale')?.status).not.toBe('done')
  })

  it('leaves the two steps that need a person sitting with a specialist', () => {
    for (let tick = 0; tick < 40; tick += 1) {
      vi.advanceTimersByTime(9_000)
      store.advanceOnboarding()
    }
    expect(stepById('processor_account')?.status).toBe('awaiting_specialist')
    expect(stepById('hardware')?.status).toBe('awaiting_specialist')
  })

  it('stays incomplete while anything is outstanding', () => {
    for (let tick = 0; tick < 40; tick += 1) {
      vi.advanceTimersByTime(9_000)
      store.advanceOnboarding()
    }
    expect(store.onboarding!.completedAt).toBeNull()
  })

  it('picks a specialist step back up when somebody asks for an update', () => {
    store.retryOnboardingStep('processor_account')
    expect(stepById('processor_account')?.status).toBe('in_progress')
    vi.advanceTimersByTime(9_000)
    store.advanceOnboarding()
    expect(stepById('processor_account')?.status).toBe('done')
  })

  it('does not restart a step that is already finished', () => {
    expect(() => store.retryOnboardingStep('intake')).toThrow(/already finished/i)
  })

  it('refuses a step it has never heard of', () => {
    expect(() => store.retryOnboardingStep('not_a_step')).toThrow(/no such step/i)
  })
})

describe('what the gateway refuses', () => {
  // Deliberately not the address the signup tests above used. The stores are
  // module state: one of them now has that email on it, and reseeding all
  // three per assertion costs more than picking a different address.
  const valid = {
    email: 'zsofi@harmatpatika.hu',
    password: 'a-long-enough-one',
    displayName: 'Ilona Fekete',
    businessName: 'Fekete Macska Bisztró',
    industry: 'restaurant',
    tier: 'growth',
  }

  const reject = (body: unknown): MockError => {
    try {
      readSignup(body)
    } catch (error) {
      if (error instanceof MockError) return error
      throw error
    }
    throw new Error('expected the signup to be refused')
  }

  it('accepts a complete one and normalises the email', () => {
    const parsed = readSignup({ ...valid, email: '  Zsofi@HarmatPatika.hu ' })
    expect(parsed.email).toBe('zsofi@harmatpatika.hu')
    expect(parsed.tier).toBe('growth')
  })

  it('names every field that is wrong, not just the first', () => {
    const error = reject({})
    expect(error.status).toBe(422)
    expect(error.fieldErrors.map((entry) => entry.field).sort()).toEqual(
      ['businessName', 'displayName', 'email', 'industry', 'password', 'tier'].sort(),
    )
  })

  it('refuses a password shorter than the contract allows', () => {
    const error = reject({ ...valid, password: 'short' })
    expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['password'])
  })

  it('refuses a trade that is not in the registry', () => {
    const error = reject({ ...valid, industry: 'submarine_repair' })
    expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['industry'])
  })

  it('refuses a tier nobody sells', () => {
    const error = reject({ ...valid, tier: 'platinum' })
    expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['tier'])
  })

  it('refuses an email that already has an account', () => {
    const taken = storeFor('shop').session.email
    const error = reject({ ...valid, email: taken.toUpperCase() })
    expect(error.status).toBe(409)
    expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['email'])
  })

  it('tells somebody their address is malformed before telling them it is taken', () => {
    // Both would be true of an address that is neither. Reporting "taken" for
    // a typo sends people to the sign-in form to guess at a password they
    // never set.
    const error = reject({ ...valid, email: 'not-an-address' })
    expect(error.status).toBe(422)
  })

  it('lands every trade on a fixture, whatever family it belongs to', () => {
    expect(fixtureForIndustry('pizzeria')).toBe('cafe')
    expect(fixtureForIndustry('barbershop')).toBe('salon')
    expect(fixtureForIndustry('hotel')).toBe('shop')
    expect(fixtureForIndustry('plumber')).toBe('shop')
  })
})
