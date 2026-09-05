import { useEntitlement } from '@twentyfour/entitlement'
import { useTerms } from '@twentyfour/terms'
import { launchTargets } from '@twentyfour/runtime'
import { Button, EmptyState } from '@twentyfour/ui'

/**
 * Where the catalog went.
 *
 * It is edited on the device that sells from it, so it lives in the till and
 * in the calendar rather than in the back office. An old bookmark lands here
 * and is pointed at whichever of the two this tenant actually holds.
 */
export function CatalogMoved() {
  const terms = useTerms()
  const entitlement = useEntitlement()
  const targets = launchTargets(import.meta.env)
  const word = terms.t('catalog', { case: 'lower' })

  return (
    <EmptyState
      icon="LayoutGrid"
      title={`Your ${word} moved`}
      description={`It is edited where it is used, so it now lives inside the applications that sell from it.`}
      className="mt-10"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {entitlement.has('pos_orders') && (
            <Button
              iconEnd="ArrowUpRight"
              onClick={() => window.open(targets.pos, '_blank', 'noopener')}
            >
              Open in the till
            </Button>
          )}
          {entitlement.has('bookings') && (
            <Button
              variant="outline"
              iconEnd="ArrowUpRight"
              onClick={() => window.open(targets.bookings, '_blank', 'noopener')}
            >
              Open in {terms.t('booking', { plural: true, case: 'lower' })}
            </Button>
          )}
        </div>
      }
    />
  )
}
