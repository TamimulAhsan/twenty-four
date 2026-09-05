import { useTerms } from '@twentyfour/terms'
import { PageBody, Card, Icon } from '@twentyfour/ui'
import { CatalogList } from '@twentyfour/shell'

/**
 * What can be booked.
 *
 * The same catalog the till sells from, filtered to the things that occupy a
 * person for a length of time. A product has no duration and cannot hold a
 * slot, so it is not offered here.
 */
export function ServicesView() {
  const terms = useTerms()
  return (
    <PageBody scroll>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.025em] text-text">
            {terms.t('catalog_item', { plural: true })}
          </h1>
          <p className="mt-1 text-base text-text-muted">
            Everything that can be booked, and how long each one takes. The duration is what decides
            the slots the calendar offers.
          </p>
        </div>

        <CatalogList kind="service" />

        <Card className="border-accent-border bg-accent-subtle">
          <div className="flex gap-3">
            <Icon name="Info" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
            <div>
              <p className="text-base font-medium text-text">
                One catalog, two applications
              </p>
              <p className="mt-0.5 text-base text-text-muted">
                These are the same items the till sells from. Change a price here and it changes
                there, because there is only one of them. Products with no duration do not appear,
                since nothing can be booked into a slot that has no length.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </PageBody>
  )
}
