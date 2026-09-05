import type { ReactNode } from 'react'
import { useEntitlement, type ModuleId } from '@twentyfour/entitlement'
import { EmptyState } from '@twentyfour/ui'

/**
 * Guards an application that the tenant may not hold.
 *
 * POS and Bookings are reachable by URL whether or not they were bought, so
 * each one checks on entry and says so plainly rather than rendering a broken
 * screen against a stream of 403s.
 *
 * This is presentation. The gateway refuses the calls regardless, and a
 * missing guard here is a bad screen rather than a data leak.
 */
export function RequireModule({
  module,
  name,
  children,
}: {
  module: ModuleId
  name: string
  children: ReactNode
}) {
  const entitlement = useEntitlement()

  if (entitlement.pending(module)) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <EmptyState
          icon="Clock"
          title={`${name} is being set up`}
          description="A specialist is finishing a step that cannot complete on its own. You will be told the moment it is ready."
        />
      </div>
    )
  }

  if (!entitlement.has(module)) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <EmptyState
          icon="Ban"
          title={`${name} is not on your plan`}
          description="Change your plan from the subscription page in your dashboard, and this opens as soon as it is provisioned."
        />
      </div>
    )
  }

  return <>{children}</>
}
