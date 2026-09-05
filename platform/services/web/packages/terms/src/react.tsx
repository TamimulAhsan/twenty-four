import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { PartialTermSet, TermKey } from './keys'
import { createTerms, resolveTermSet, type Terms, type TermOptions } from './resolve'

const TermsContext = createContext<Terms | null>(null)

export interface TermsProviderProps {
  /** The vocabulary family the business type belongs to. */
  family: string | undefined
  /** The business type itself, which corrects its family where the family is
   *  too coarse. A cafe is not a restaurant. */
  profile: string | undefined
  /** Tenant-level overrides, the third and most specific cascade layer. */
  overrides?: PartialTermSet
  /** BCP 47 tag from the business profile. Not the browser's. */
  locale: string
  children: ReactNode
}

/**
 * Resolves the cascade once and holds it for the session.
 *
 * Sits above the router, because a term appears in navigation before any route
 * has rendered.
 */
export function TermsProvider({ family, profile, overrides, locale, children }: TermsProviderProps) {
  const terms = useMemo(
    () => createTerms(resolveTermSet({ family, profile, overrides }), locale),
    [family, profile, overrides, locale],
  )
  return <TermsContext.Provider value={terms}>{children}</TermsContext.Provider>
}

export function useTerms(): Terms {
  const terms = useContext(TermsContext)
  if (!terms) {
    throw new Error('useTerms must be used inside a TermsProvider')
  }
  return terms
}

/** Shorthand for a single word: `useTerm('catalog_item', { count: 2 })`. */
export function useTerm(key: TermKey, options?: TermOptions): string {
  return useTerms().t(key, options)
}
