import { Suspense, lazy, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { availableTenants, currentTenantId, resetStore, setCurrentTenantId } from '@twentyfour/mock'
import { Badge, Button, Icon, cn } from '@twentyfour/ui'

/**
 * Switches the fixture without a reload.
 *
 * This is the trade-neutrality test made usable. The same screens are built
 * once; flipping between a cafe, a salon and a boutique changes every visible
 * word, shows or hides the kitchen display, and lengthens or shortens the
 * sidebar. If any of them changes a layout or a behaviour, that is the bug the
 * architecture warns about, and it is visible here rather than in production.
 *
 * Development only. It is not rendered in a production build.
 */
function DevToolbarPanel() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const tenants = availableTenants()
  const active = currentTenantId()

  const switchTo = (tenantId: string) => {
    setCurrentTenantId(tenantId)
    void queryClient.invalidateQueries()
    setOpen(false)
  }

  return (
    <div className="fixed bottom-4 left-4 z-[60] flex flex-col items-start gap-2">
      {open && (
        <div className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-raised p-3 shadow-[var(--shadow-xl)]">
          <p className="px-1 pb-2 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
            Fixture
          </p>
          <div className="flex flex-col gap-1">
            {tenants.map((tenant) => (
              <button
                key={tenant.id}
                type="button"
                onClick={() => switchTo(tenant.id)}
                className={cn(
                  'rounded-lg p-2.5 text-left transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                  tenant.id === active
                    ? 'bg-accent-subtle'
                    : 'hover:bg-surface-hover',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-base font-medium text-text">{tenant.label}</span>
                  {tenant.id === active && <Badge tone="accent">Active</Badge>}
                </span>
                <span className="mt-0.5 block text-sm text-text-muted">{tenant.proves}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              iconStart="RotateCcw"
              block
              onClick={() => {
                resetStore(active)
                void queryClient.invalidateQueries()
              }}
            >
              Reset this fixture
            </Button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex h-10 items-center gap-2 rounded-full border border-border bg-surface-raised px-3.5',
          'text-sm font-medium text-text-muted shadow-[var(--shadow-md)]',
          'transition-colors hover:text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
        )}
      >
        <Icon name="Filter" size="sm" />
        {tenants.find((tenant) => tenant.id === active)?.label ?? 'Fixture'}
      </button>
    </div>
  )
}

/**
 * Loaded only in development.
 *
 * The lazy import is what keeps it out of the production bundle: a static
 * import would ship the store, all three fixtures and every seeded order to
 * merchants, behind a component that returns null.
 */
const LazyPanel = lazy(async () => ({ default: DevToolbarPanel }))

export function DevToolbar() {
  if (!import.meta.env.DEV) return null
  return (
    <Suspense fallback={null}>
      <LazyPanel />
    </Suspense>
  )
}
