import { NavLink } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminProvisioning, adminTenants } from '@twentyfour/api'
import { BrandMark } from '@twentyfour/runtime'
import { Avatar, Badge, Icon, cn, type IconName } from '@twentyfour/ui'
import { ROLE_LABELS } from '../common'
import { useAdminSession, useEnvironment, useSignOut } from '../session'

/**
 * The console's navigation.
 *
 * Fixed, not derived. The merchant's sidebar is built from their entitlement
 * record because what they bought decides what exists for them; a specialist
 * buys nothing, and every screen here exists in every deployment. What varies
 * is what a role may do once it arrives, and that is enforced at the gateway
 * on the call rather than by hiding the page.
 */
interface Item {
  to: string
  label: string
  icon: IconName
  /** A number worth seeing without opening the screen. */
  count?: number
  /** Draws the count as a warning rather than a fact. */
  urgent?: boolean
}

const GROUPS: ReadonlyArray<{ label: string; items: Item[] }> = [
  {
    label: 'Oversight',
    items: [
      { to: '/', label: 'Tenants', icon: 'Building2' },
      { to: '/provisioning', label: 'Getting live', icon: 'Clock' },
    ],
  },
  {
    label: 'Commercial',
    items: [
      { to: '/tiers', label: 'Tiers and modules', icon: 'Layers' },
      { to: '/billing', label: 'Platform billing', icon: 'Wallet' },
    ],
  },
  {
    label: 'Trust and access',
    items: [
      { to: '/sessions', label: 'Impersonation', icon: 'KeyRound' },
      { to: '/audit', label: 'Audit log', icon: 'FileClock' },
      { to: '/team', label: 'Team and roles', icon: 'UserCog' },
    ],
  },
  {
    label: 'Platform',
    items: [{ to: '/settings', label: 'Settings', icon: 'Settings' }],
  },
]

const ROW = cn(
  'group flex h-10 items-center gap-2.5 rounded-lg px-2.5',
  'text-base transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
)

function Row({ item, count, urgent }: { item: Item; count?: number; urgent?: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          ROW,
          isActive
            ? 'bg-accent-subtle font-medium text-accent-text'
            : 'text-text-muted hover:bg-surface-hover hover:text-text',
        )
      }
    >
      <Icon name={item.icon} size="lg" className="shrink-0" />
      <span className="truncate">{item.label}</span>
      {count !== undefined && count > 0 && (
        <Badge tone={urgent ? 'danger' : 'neutral'} className="ml-auto">
          {count}
        </Badge>
      )}
    </NavLink>
  )
}

export function SidebarContent() {
  const session = useAdminSession()
  const environment = useEnvironment()
  const { signOut, pending } = useSignOut()

  // Counts only. The screens fetch their own data; these two exist so a
  // specialist can see there is a run in trouble without opening the page.
  const tenants = useQuery({ queryKey: adminKeys.tenants.list(), queryFn: () => adminTenants.list() })
  const queue = useQuery({
    queryKey: adminKeys.provisioning.queue(),
    queryFn: adminProvisioning.queue,
  })

  const counts: Record<string, { count: number; urgent?: boolean }> = {
    '/': { count: tenants.data?.total ?? 0 },
    '/provisioning': {
      count: queue.data?.length ?? 0,
      urgent: (queue.data ?? []).some((run) =>
        run.state.steps.some((step) => step.status === 'failed'),
      ),
    },
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <p className="truncate text-sm font-semibold tracking-[-0.01em] text-text">
            Admin console
          </p>
        </div>
        {/* Which deployment this is, before anything else. A specialist can
            have two consoles open and they look identical otherwise. */}
        <Badge tone="warning" dot className="mt-2.5">
          {environment.market} · {environment.environment}
        </Badge>
      </div>

      <nav aria-label="Console" className="flex-1 overflow-y-auto px-2.5 pb-4">
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-1">
            <p className="px-2.5 pb-1 pt-4 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
              {group.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <Row
                  key={item.to}
                  item={item}
                  count={counts[item.to]?.count}
                  urgent={counts[item.to]?.urgent}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border px-2.5 py-2.5">
        <button
          type="button"
          onClick={signOut}
          disabled={pending}
          className={cn(
            ROW,
            'w-full text-text-muted hover:bg-surface-hover hover:text-text',
            'disabled:cursor-default disabled:opacity-60',
          )}
        >
          <Icon
            name={pending ? 'LoaderCircle' : 'LogOut'}
            size="lg"
            className={cn('shrink-0', pending && 'animate-spin')}
          />
          <span className="truncate">Sign out</span>
        </button>

        <div className="mt-2.5 flex items-center gap-2.5 rounded-lg bg-surface-sunken p-2.5">
          <Avatar name={session.name} colour="#c98420" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{session.name}</p>
            <p className="truncate text-xs text-text-subtle">{ROLE_LABELS[session.role]}</p>
          </div>
        </div>
        {/* The address, spelled out. Whoever is reading this is inside an IP
            allowlist and should be able to see which side of it they are on. */}
        <p className="mt-2 px-1 font-mono text-2xs text-text-subtle">
          {session.mfa} · {session.sourceIp}
        </p>
      </div>
    </div>
  )
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-surface lg:block">
      <SidebarContent />
    </aside>
  )
}
