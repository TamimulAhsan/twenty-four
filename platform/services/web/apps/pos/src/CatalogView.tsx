import { CatalogList } from '@twentyfour/shell'
import { useTerms } from '@twentyfour/terms'
import { PageBody } from '@twentyfour/ui'

/**
 * The catalog, inside the till.
 *
 * Named by the term set, so a restaurant sees Menu, a hotel sees Room types
 * and a boutique sees Product list. Same route, same table, same API.
 */
export function CatalogView() {
  const terms = useTerms()
  return (
    <PageBody scroll>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.025em] text-text">
            {terms.t('catalog')}
          </h1>
          <p className="mt-1 text-base text-text-muted">
            Everything you sell, with prices and tax. One source of truth for the till, the calendar
            and your site.
          </p>
        </div>
        <CatalogList />
      </div>
    </PageBody>
  )
}
