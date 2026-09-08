import { ADMIN_STAFF, availableTenants, storeFor } from '@twentyfour/mock'
import { Card, Icon, cn } from '@twentyfour/ui'

/**
 * The fixtures, one click away.
 *
 * Both planes, because one form serves both and the interesting thing to be
 * able to try is that the same field sends two people to two different
 * applications. A specialist here lands on the admin console; a merchant lands
 * on their dashboard; neither picked a plane.
 *
 * Development scaffolding. It lives in its own module so the lazy import in
 * SignIn can drop it, and everything it reaches, from the production bundle.
 */
function Row({
  title,
  subtitle,
  onClick,
}: {
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium text-text">{title}</p>
        <p className="truncate text-sm text-text-subtle">{subtitle}</p>
      </div>
      <Icon name="ArrowRight" size="md" className="shrink-0 text-text-subtle" />
    </button>
  )
}

export default function DemoAccounts({ onPick }: { onPick: (email: string) => void }) {
  return (
    <Card className="mt-8 bg-surface-sunken" padded={false}>
      <p className="border-b border-border px-4 py-2.5 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
        Merchants
      </p>
      <div className="flex flex-col">
        {availableTenants().map((tenant) => {
          const { session } = storeFor(tenant.id)
          return (
            <Row
              key={tenant.id}
              title={tenant.label}
              subtitle={tenant.proves}
              onClick={() => onPick(session.email)}
            />
          )
        })}
      </div>

      <p className="border-y border-border px-4 py-2.5 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
        Specialists
      </p>
      <div className="flex flex-col">
        {ADMIN_STAFF.filter((member) => member.mfa !== null).map((member) => (
          <Row
            key={member.staffId}
            title={member.name}
            subtitle={`${member.role.replace(/_/g, ' ')} · goes to the admin console`}
            onClick={() => onPick(member.email)}
          />
        ))}
      </div>
    </Card>
  )
}
