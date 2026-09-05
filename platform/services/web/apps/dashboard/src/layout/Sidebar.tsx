import { NavLink } from 'react-router'
import { FOOTER_NAV, useEntitlement, type NavItem, type NavLabel } from '@twentyfour/entitlement'
import { useTerms } from '@twentyfour/terms'
import { BrandMark, useBootstrap, Wordmark } from '@twentyfour/runtime'
import { Avatar, Badge, Icon, IconButton, cn, isIconName } from '@twentyfour/ui'

function useLabel() {
  const terms = useTerms()
  return (label: NavLabel): string =>
    label.kind === 'static'
      ? label.text
      : terms.t(label.key as never, label.plural ? { plural: true } : {})
}

const ROW = cn(
  'group relative flex h-10 items-center gap-2.5 rounded-lg px-2.5',
  'text-base transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
)

function NavRow({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem
  collapsed?: boolean
  onNavigate?: () => void
}) {
  const label = useLabel()(item.label)
  const icon = isIconName(item.icon) ? item.icon : 'CircleDot'
  // Collapsed, the icon is the only thing carrying the name, so the accessible
  // name and the hover tooltip both have to supply it.
  const collapsedProps = collapsed ? { title: label, 'aria-label': label } : {}
  const rowLayout = collapsed ? 'justify-center px-0' : 'px-2.5'

  // Held but still provisioning. Shown so the merchant can see what they paid
  // for arriving, and not clickable, because it does not work yet.
  if (item.pending) {
    return (
      <span
        className={cn(ROW, rowLayout, 'cursor-default text-text-subtle')}
        title={`${label} is being set up by your specialist`}
      >
        <Icon name={icon} size="lg" className="shrink-0 opacity-60" />
        {!collapsed && (
          <>
            <span className="truncate">{label}</span>
            <Badge tone="warning" className="ml-auto">
              Setting up
            </Badge>
          </>
        )}
      </span>
    )
  }

  // A separate application. It opens in its own tab because it is a different
  // tool on a different device, not a section of this one.
  if (item.launch) {
    return (
      <a
        href={item.launch}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        className={cn(ROW, rowLayout, 'text-text-muted hover:bg-surface-hover hover:text-text')}
        {...collapsedProps}
      >
        <Icon name={icon} size="lg" className="shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">{label}</span>
            <Icon name="ArrowUpRight" size="sm" className="ml-auto shrink-0 opacity-50" />
          </>
        )}
      </a>
    )
  }

  return (
    <NavLink
      to={item.to ?? '/'}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          ROW,
          rowLayout,
          isActive
            ? 'bg-accent-subtle font-medium text-accent-text'
            : 'text-text-muted hover:bg-surface-hover hover:text-text',
        )
      }
      {...collapsedProps}
    >
      {({ isActive }) => (
        <>
          {/* Position is a second channel alongside colour: the bar marks the
              current location for a reader who cannot separate the hues. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-0 h-5 w-0.5 rounded-r-full bg-accent transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          />
          <Icon name={icon} size="lg" className="shrink-0" />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  )
}

export function SidebarContent({
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  collapsed?: boolean
  onToggle?: () => void
  onNavigate?: () => void
}) {
  const { nav, record, seatsLeft } = useEntitlement()
  const { profile, session } = useBootstrap()
  const tier = record.tier.charAt(0).toUpperCase() + record.tier.slice(1)

  return (
    <div className="flex h-full flex-col">
      {/* The toggle lives in the header rather than the footer: it is a
          navigation control, it is where the eye already is on arrival, and
          the footer is crowded enough without it. */}
      <div
        className={cn(
          'flex shrink-0 items-center',
          collapsed ? 'h-16 flex-col justify-center gap-1 pt-2' : 'h-16 justify-between pl-4 pr-2',
        )}
      >
        {collapsed ? <BrandMark /> : <Wordmark />}
        {onToggle && (
          <IconButton
            size="sm"
            icon={collapsed ? 'ChevronRight' : 'ChevronLeft'}
            label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            onClick={onToggle}
          />
        )}
      </div>

      <nav aria-label="Main" className={cn('flex-1 overflow-y-auto pb-4', collapsed ? 'px-2' : 'px-2.5')}>
        {nav.map((group) => (
          <div key={group.id} className="mb-1">
            {group.label &&
              // Collapsed, a heading has nowhere to sit, so a rule separates
              // the groups instead. The grouping is still visible; the words
              // for it are not.
              (collapsed ? (
                <div role="presentation" className="mx-2 my-2 border-t border-border" />
              ) : (
                <p className="px-2.5 pb-1 pt-4 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
                  {group.label}
                </p>
              ))}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavRow key={item.id} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn('shrink-0 border-t border-border py-2.5', collapsed ? 'px-2' : 'px-2.5')}>
        <div className="flex flex-col gap-0.5">
          {FOOTER_NAV.map((item) => (
            <NavRow key={item.id} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>

        <div
          className={cn(
            'mt-2.5 flex items-center rounded-lg bg-surface-sunken',
            collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-2.5',
          )}
          title={collapsed ? `${profile.name} · ${tier}` : undefined}
        >
          <Avatar name={session.name} colour="#2f5bff" />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{profile.name}</p>
              <p className="truncate text-xs text-text-subtle">
                {tier}
                {seatsLeft !== null && ` · ${record.seats.used}/${record.seats.limit} seats`}
              </p>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 hidden border-r border-border bg-surface lg:block',
        // Width is the only thing that animates. Animating the content would
        // reflow every row while it moves, which is what makes a collapsing
        // sidebar feel cheap.
        'transition-[width] duration-[var(--duration-base)] ease-[var(--ease-out)]',
        'motion-reduce:transition-none',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <SidebarContent collapsed={collapsed} onToggle={onToggle} />
    </aside>
  )
}
