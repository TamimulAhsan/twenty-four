import { availableTenants, storeFor } from '@twentyfour/mock'
import { Card, Icon, cn } from '@twentyfour/ui'

/**
 * The three fixtures, one click away.
 *
 * Development scaffolding. It lives in its own module so the lazy import in
 * SignIn can drop it, and everything it reaches, from the production bundle.
 */
export default function DemoAccounts({ onPick }: { onPick: (email: string) => void }) {
  return (
    <Card className="mt-8 bg-surface-sunken" padded={false}>
      <p className="border-b border-border px-4 py-2.5 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
        Fixtures
      </p>
      <div className="flex flex-col">
        {availableTenants().map((tenant) => {
          const { session } = storeFor(tenant.id)
          return (
            <button
              key={tenant.id}
              type="button"
              onClick={() => onPick(session.email)}
              className={cn(
                'flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium text-text">{tenant.label}</p>
                <p className="truncate text-sm text-text-subtle">{tenant.proves}</p>
              </div>
              <Icon name="ArrowRight" size="md" className="shrink-0 text-text-subtle" />
            </button>
          )
        })}
      </div>
    </Card>
  )
}
