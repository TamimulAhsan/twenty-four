/**
 * What the gateway will accept from the signup form.
 *
 * Every rule here is also checked in the form, which is the point: the form
 * exists so nobody makes a round trip to find out their password is short, and
 * this exists because the form is not the control. Errors come back per field
 * so they land under the input that caused them rather than in a banner above
 * all of them.
 */
import { industryProfile, TIER_IDS, type TierId } from '@twentyfour/entitlement'
import { MockError, availableTenants, storeFor } from './store'

/**
 * The shortest password this stand-in gateway accepts.
 *
 * Held here rather than imported from the client, because the client is what
 * this is standing in judgement over. It is served from `/api/auth/policy` so
 * the form asks for it the same way it asks the real gateway, which is the
 * only way that path gets exercised in development.
 */
export const MOCK_MIN_PASSWORD_LENGTH = 10

export interface SignupBody {
  email: string
  password: string
  displayName: string
  businessName: string
  industry: string
  tier: TierId
}

/**
 * Validates a signup the way the gateway will.
 *
 * Every rule here is also enforced in the form, which is the point: the form
 * exists so nobody has to make a round trip to find out their password is
 * short, and this exists because the form is not the control. The errors come
 * back per field so they land under the input that caused them.
 */
export function readSignup(raw: unknown): SignupBody {
  const body = (raw ?? {}) as Record<string, unknown>
  const text = (key: string): string => (typeof body[key] === 'string' ? body[key].trim() : '')

  const email = text('email').toLowerCase()
  const password = typeof body['password'] === 'string' ? body['password'] : ''
  const displayName = text('displayName')
  const businessName = text('businessName')
  const industry = text('industry')
  const tier = text('tier')

  const fieldErrors: Array<{ field: string; message: string }> = []
  // Deliberately loose. Anything stricter rejects addresses that work, and the
  // only real proof an address exists is sending something to it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fieldErrors.push({ field: 'email', message: 'Enter an email address we can reach you on.' })
  }
  if (password.length < MOCK_MIN_PASSWORD_LENGTH) {
    fieldErrors.push({
      field: 'password',
      message: `Use at least ${MOCK_MIN_PASSWORD_LENGTH} characters.`,
    })
  }
  if (!displayName) fieldErrors.push({ field: 'displayName', message: 'Tell us your name.' })
  if (!businessName) {
    fieldErrors.push({ field: 'businessName', message: 'What is the business called?' })
  }
  if (!industryProfile(industry)) {
    fieldErrors.push({ field: 'industry', message: 'Pick the kind of business this is.' })
  }
  if (!TIER_IDS.includes(tier as TierId)) {
    fieldErrors.push({ field: 'tier', message: 'Pick a plan.' })
  }

  if (fieldErrors.length > 0) {
    throw new MockError(422, 'invalid', 'Some of that needs another look.', fieldErrors)
  }

  // Checked after the shape, so somebody who mistyped their address is told
  // that before being told it is taken.
  const taken = availableTenants().some(
    (tenant) => storeFor(tenant.id).session.email.toLowerCase() === email,
  )
  if (taken) {
    throw new MockError(409, 'email_taken', 'That email already has an account.', [
      { field: 'email', message: 'This address already has an account. Sign in instead.' },
    ])
  }

  return { email, password, displayName, businessName, industry, tier: tier as TierId }
}

/**
 * Which fixture a new signup lands on.
 *
 * By vocabulary family rather than by trade, so all forty-three business types
 * resolve to something. A hotel landing on the shop fixture is a fixture
 * limitation and a visible one: the terms say Room over a shelf of products,
 * which is the term cascade working, not failing.
 */
export function fixtureForIndustry(industry: string): string {
  switch (industryProfile(industry)?.family) {
    case 'food_service':
      return 'cafe'
    case 'salon':
      return 'salon'
    default:
      return 'shop'
  }
}
