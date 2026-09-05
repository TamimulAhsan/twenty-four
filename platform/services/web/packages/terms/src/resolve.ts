import { TERM_KEYS, type PartialTermSet, type Term, type TermKey, type TermSet } from './keys'
import { BASE_TERMS, industryTerms, profileTerms } from './sets'

export interface TermResolution {
  /** The vocabulary family, e.g. food_service. */
  readonly family?: string | undefined
  /** The business type, e.g. cafe. Corrects the family where it is too
   *  coarse, which is most of the time. */
  readonly profile?: string | undefined
  readonly overrides?: PartialTermSet
  readonly base?: TermSet
}

/**
 * Resolves the cascade, most specific wins:
 *
 *   base  ->  family  ->  business type  ->  tenant override
 *  "Items"   "Dishes"      "Items"           "Small plates"
 *
 * The business type layer exists because a family is a useful approximation
 * and a bad final answer. One food_service set covers restaurants, cafes,
 * bakeries and food trucks, and only the restaurant says Dish and Server. A
 * bakery inheriting the restaurant's words reads like software that has never
 * seen a bakery.
 *
 * Resolution happens once, at bootstrap, and the result is held for the
 * session. Rendering a word must never cost a network hop.
 */
export function resolveTermSet(input: TermResolution = {}): TermSet {
  const base = input.base ?? BASE_TERMS
  const familySet = input.family ? industryTerms(input.family) : {}
  const profileSet = input.profile ? profileTerms(input.profile) : {}
  const overrides = input.overrides ?? {}

  const resolved = {} as Record<TermKey, Term>
  for (const key of TERM_KEYS) {
    resolved[key] = overrides[key] ?? profileSet[key] ?? familySet[key] ?? base[key]
  }
  return resolved
}

export type TermCase = 'as-written' | 'lower' | 'upper'

export interface TermOptions {
  /** Chooses singular or plural. 1 is singular, anything else is plural. */
  count?: number
  /** Force plural without supplying a count. */
  plural?: boolean
  case?: TermCase
}

export interface Terms {
  /** The word for a key. `t('catalog_item', { count: 2 })` gives "Dishes". */
  t(key: TermKey, options?: TermOptions): string
  /**
   * The singular word with the right indefinite article in front of it.
   *
   * Hardcoding "a" before a word that varies by trade produces "a item" and
   * "a order" the moment a term starts with a vowel. The article is part of
   * the vocabulary, so it is resolved with it.
   *
   * Singular only: "an items" is not a phrase, so a sentence about several of
   * something is written without an article rather than asking for one here.
   */
  a(key: TermKey, options?: Omit<TermOptions, 'count' | 'plural'>): string
  /** The resolved set, for callers that need to inspect it. */
  readonly set: TermSet
  /** BCP 47 tag, used for case transforms that are locale sensitive. */
  readonly locale: string
}

/**
 * a or an.
 *
 * Spelling, not phonetics: this is the rule that holds for the words a term
 * set actually contains. English has real exceptions (an hour, a European)
 * and a trade that hits one supplies its own copy rather than teaching this
 * function to guess.
 */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

export function createTerms(set: TermSet, locale: string): Terms {
  return {
    set,
    locale,
    a(key, options = {}) {
      const word = this.t(key, options)
      return `${indefiniteArticle(word)} ${word}`
    },
    t(key, options = {}) {
      const term = set[key]
      const plural = options.plural ?? (options.count !== undefined && options.count !== 1)
      const word = plural ? term.other : term.one
      switch (options.case) {
        // Locale-aware on purpose: Turkish lowercases I to a dotless i, and a
        // naive toLowerCase would produce a word no Turkish reader recognises.
        case 'lower':
          return word.toLocaleLowerCase(locale)
        case 'upper':
          return word.toLocaleUpperCase(locale)
        default:
          return word
      }
    },
  }
}

/**
 * Words that would weld one trade's vocabulary into the platform if they
 * appeared in a route, an API path, a query key or an analytics dimension.
 */
const TRADE_WORDS = new Set([
  'room', 'rooms',
  'dish', 'dishes',
  'menu', 'menus',
  'treatment', 'treatments',
  'appointment', 'appointments',
  'guest', 'guests',
  'client', 'clients',
  'stylist', 'stylists',
  'server', 'servers',
  'table', 'tables',
  'course', 'courses',
  'reservation', 'reservations',
  'bill', 'bills',
  'chair', 'chairs',
  'technician', 'technicians',
])

/**
 * True if an identifier has a trade word in it.
 *
 * Used by the test that walks every route and every request path. A term is
 * presentation: renaming one must never imply a migration or change what a
 * report counts, and that only holds while no key is ever a word.
 */
export function containsTradeWord(identifier: string): string | undefined {
  // Scans in the order the identifier reads, not in the order the word list
  // happens to be written, so the reported word is the one to go and look at.
  const segments = identifier.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  return segments.find((segment) => TRADE_WORDS.has(segment))
}
