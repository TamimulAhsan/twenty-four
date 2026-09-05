import { describe, expect, it } from 'vitest'
import { containsTradeWord, createTerms, resolveTermSet } from './resolve'
import { BASE_TERMS } from './sets'
import { TERM_KEYS } from './keys'

describe('resolveTermSet', () => {
  it('falls back to base for a trade with no set', () => {
    const set = resolveTermSet({})
    expect(set.catalog_item.one).toBe('Item')
  })

  it('lets the industry override base', () => {
    expect(resolveTermSet({ family: 'food_service' }).catalog_item.one).toBe('Dish')
    expect(resolveTermSet({ family: 'salon' }).catalog_item.one).toBe('Treatment')
    expect(resolveTermSet({ family: 'accommodation' }).catalog_item.one).toBe('Room')
  })

  it('lets the tenant override the industry', () => {
    const set = resolveTermSet({
      family: 'accommodation',
      overrides: { catalog_item: { one: 'Suite', other: 'Suites' } },
    })
    expect(set.catalog_item.one).toBe('Suite')
    // A key the tenant did not touch still comes from the industry.
    expect(set.customer.one).toBe('Guest')
  })

  it('resolves every key, so no screen can render an empty label', () => {
    for (const industry of ['food_service', 'salon', 'retail', 'accommodation', 'trades']) {
      const set = resolveTermSet({ family: industry })
      for (const key of TERM_KEYS) {
        expect(set[key].one, `${industry}.${key}.one`).toBeTruthy()
        expect(set[key].other, `${industry}.${key}.other`).toBeTruthy()
      }
    }
  })

  it('has a complete base set', () => {
    for (const key of TERM_KEYS) {
      expect(BASE_TERMS[key], `base is missing ${key}`).toBeTruthy()
    }
  })
})

describe('createTerms', () => {
  const terms = createTerms(resolveTermSet({ family: 'food_service' }), 'en-GB')

  it('picks plural from a count', () => {
    expect(terms.t('catalog_item')).toBe('Dish')
    expect(terms.t('catalog_item', { count: 1 })).toBe('Dish')
    expect(terms.t('catalog_item', { count: 0 })).toBe('Dishes')
    expect(terms.t('catalog_item', { count: 4 })).toBe('Dishes')
    expect(terms.t('catalog_item', { plural: true })).toBe('Dishes')
  })

  it('lowercases for mid-sentence use', () => {
    expect(terms.t('catalog_item', { case: 'lower' })).toBe('dish')
  })
})

describe('containsTradeWord', () => {
  // This is the guard on the rule that keeps the whole scheme safe. Terms are
  // presentation: the moment one becomes a key, renaming it implies a
  // migration and changes what a report counts.
  it('accepts semantic identifiers', () => {
    expect(containsTradeWord('/catalog')).toBeUndefined()
    expect(containsTradeWord('/catalog/items')).toBeUndefined()
    expect(containsTradeWord('catalog_item')).toBeUndefined()
    expect(containsTradeWord('/api/bookings')).toBeUndefined()
    expect(containsTradeWord('order.placed')).toBeUndefined()
  })

  it('catches a trade word in a path', () => {
    expect(containsTradeWord('/api/rooms')).toBe('rooms')
    expect(containsTradeWord('/menu/dishes')).toBe('menu')
    expect(containsTradeWord('appointment_created')).toBe('appointment')
  })

  // "Ordered" is not "order"; "customer" is not "custom". Whole segments only,
  // or the guard cries wolf and gets switched off.
  it('matches whole segments, not substrings', () => {
    expect(containsTradeWord('/catalog/serverless')).toBeUndefined()
    expect(containsTradeWord('/roommate')).toBeUndefined()
  })
})

describe('what the trade word is for', () => {
  /**
   * The rule the vocabulary system actually needs, stated as a test.
   *
   * A term names the concept as it appears in the customer-facing workflow.
   * It does not rename administrative objects. "Who is doing this
   * appointment" is a Stylist; "who has a login" is not, because that list
   * holds the owner, the manager and the bookkeeper too.
   */
  it('gives the operational sense a trade word', () => {
    const salon = resolveTermSet({ family: 'salon', profile: 'hair_salon' })
    expect(salon.staff_member.one).toBe('Stylist')
    expect(salon.customer.one).toBe('Client')
    expect(salon.catalog_item.one).toBe('Treatment')
  })

  // Guarded here because the words are right and the place they were used was
  // not: the account screen read "Servers" for a team containing an owner and
  // a bookkeeper.
  it('is only correct where the concept really is the trade one', () => {
    const restaurant = resolveTermSet({ family: 'food_service', profile: 'restaurant' })
    expect(restaurant.staff_member.other).toBe('Servers')
    // Which is right for a rota and wrong for a list of logins. The account
    // screens use a fixed label and never call this function.
  })
})

describe('articles', () => {
  // "Tap a item to start" is what hardcoding the article produces the moment
  // a trade's word begins with a vowel, and every trade that says Item,
  // Order or Appointment hits it.
  it('agrees with the word it precedes', () => {
    const cafe = createTerms(resolveTermSet({ family: 'food_service', profile: 'cafe' }), 'en-GB')
    expect(cafe.a('catalog_item', { case: 'lower' })).toBe('an item')

    const restaurant = createTerms(
      resolveTermSet({ family: 'food_service', profile: 'restaurant' }),
      'en-GB',
    )
    expect(restaurant.a('catalog_item', { case: 'lower' })).toBe('a dish')

    const salon = createTerms(resolveTermSet({ family: 'salon', profile: 'hair_salon' }), 'en-GB')
    expect(salon.a('booking', { case: 'lower' })).toBe('an appointment')
    expect(salon.a('catalog_item', { case: 'lower' })).toBe('a treatment')
  })
})
