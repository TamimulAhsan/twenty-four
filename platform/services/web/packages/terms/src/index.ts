export {
  TERM_KEYS,
  type Term,
  type TermKey,
  type TermSet,
  type PartialTermSet,
} from './keys'

export { BASE_TERMS, INDUSTRY_TERMS, PROFILE_TERMS, industryTerms, profileTerms } from './sets'

export {
  resolveTermSet,
  createTerms,
  containsTradeWord,
  type Terms,
  type TermOptions,
  type TermResolution,
  type TermCase,
} from './resolve'

export { TermsProvider, useTerms, useTerm, type TermsProviderProps } from './react'
