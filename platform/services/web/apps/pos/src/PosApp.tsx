import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { orders, queryKeys } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import { useTerms } from '@twentyfour/terms'
import { RequireModule, Wordmark, useBootstrap } from '@twentyfour/runtime'
import { Avatar, Icon, IconButton, ThemeToggle, cn, type IconName } from '@twentyfour/ui'
import { SessionGate, SignOutButton } from '@twentyfour/shell'
import { DevToolbar } from '@twentyfour/shell'
import { Till } from './Till'
import { ParkedView } from './ParkedView'
import { OrdersView } from './OrdersView'
import { KitchenView } from './KitchenView'
import { TablesView } from './TablesView'
import { CatalogView } from './CatalogView'
import { TeamView } from './TeamView'
import { DayClose } from './DayClose'

export function PosApp() {
  return (
    <SessionGate>
      <RequireModule module="pos_orders" name="Point of sale">
        <PosShell />
      </RequireModule>
    </SessionGate>
  )
}

type View = 'till' | 'parked' | 'orders' | 'kitchen' | 'tables' | 'catalog' | 'team' | 'close'

/**
 * The till's own chrome.
 *
 * Deliberately not the dashboard's. This runs full screen on a tablet at a
 * counter, held in one hand, touched a few hundred times a day. It has no
 * sidebar, no search, and nothing that scrolls the page: the grid scrolls and
 * the cart scrolls, and the frame around them never moves.
 */
function PosShell() {
  const { profile } = useBootstrap()
  const terms = useTerms()
  const entitlement = useEntitlement()
  const [view, setView] = useState<View>('till')

  /**
   * The two ways into the till from somewhere else.
   *
   * Held here rather than in the till because the till is not mounted when the
   * floor screen or the parked list asks for it. Each is taken exactly once
   * and then cleared, so switching back to the till later does not reopen a
   * tab that has since been settled.
   */
  const [resumeOrderId, setResumeOrderId] = useState<string | null>(null)
  const [startTableId, setStartTableId] = useState<string | null>(null)

  const openTill = useCallback(() => {
    setResumeOrderId(null)
    setStartTableId(null)
  }, [])

  const resumeSale = (orderId: string) => {
    setStartTableId(null)
    setResumeOrderId(orderId)
    setView('till')
  }

  const startTab = (tableId: string) => {
    setResumeOrderId(null)
    setStartTableId(tableId)
    setView('till')
  }

  // Only for the count on the tab. A cashier needs to see that something is
  // waiting without going to look.
  const parked = useQuery({
    queryKey: queryKeys.orders.parked(),
    queryFn: orders.parked,
    refetchInterval: 60_000,
  })
  const parkedCount = parked.data?.length ?? 0

  const tabs: Array<{ id: View; label: string; icon: IconName; badge?: number }> = [
    { id: 'till', label: 'Till', icon: 'ScanLine' },
    // Always present, whatever the count. A control that appears and vanishes
    // is one nobody builds a habit around.
    { id: 'parked', label: 'Parked', icon: 'Clock', ...(parkedCount > 0 ? { badge: parkedCount } : {}) },
    { id: 'orders', label: terms.t('order', { plural: true }), icon: 'ReceiptText' },
    // Trade capabilities, switched on by the industry profile. Nobody chose
    // them: a candy shop buying POS gets a till, a restaurant buying the same
    // POS gets a till, prep screens and a floor.
    ...(entitlement.can('kitchen_display')
      ? [{ id: 'kitchen' as const, label: 'Kitchen', icon: 'ChefHat' as const }]
      : []),
    ...(entitlement.can('table_management')
      ? [{ id: 'tables' as const, label: 'Tables', icon: 'Grid3x3' as const }]
      : []),
    // Named by the term set: Menu in a restaurant, Room types in a hotel.
    { id: 'catalog', label: terms.t('catalog'), icon: 'LayoutGrid' },
    // Accounts, not the trade role: this list has the owner in it.
    { id: 'team', label: 'Team', icon: 'Users' },
    { id: 'close', label: 'Close day', icon: 'Wallet' },
  ]

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
        <Wordmark suffix="Point of sale" className="hidden sm:flex" />
        <Wordmark className="sm:hidden" />

        <nav
          aria-label="Till sections"
          className="scrollbar-none ml-auto flex items-center gap-1 overflow-x-auto sm:ml-6 sm:mr-auto"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={view === tab.id ? 'page' : undefined}
              onClick={() => setView(tab.id)}
              className={cn(
                'flex h-10 items-center gap-2 rounded-lg px-2.5 text-base font-medium lg:px-3.5',
                'transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                view === tab.id
                  ? 'bg-accent-subtle text-accent-text'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Icon name={tab.icon} size="lg" />
              <span className="hidden lg:inline">{tab.label}</span>
              {tab.badge !== undefined && (
                <span
                  className={cn(
                    'tnum flex h-5 min-w-5 items-center justify-center rounded-full px-1.5',
                    'text-2xs font-semibold',
                    view === tab.id
                      ? 'bg-accent text-on-accent'
                      : 'bg-surface-active text-text-muted',
                  )}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <span className="hidden items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-1.5 2xl:flex">
            <Avatar name={profile.name} colour="#2f5bff" size="sm" />
            <span className="max-w-40 truncate text-sm font-medium text-text">{profile.name}</span>
          </span>
          <ThemeToggle className="hidden sm:inline-flex" />
          <IconButton
            icon="ArrowUpRight"
            label="Back to dashboard"
            size="sm"
            onClick={() => window.open('/', '_blank', 'noopener')}
          />
          {/* A counter device is shared. Ending a shift has to be one press
              from wherever the person is standing, not somewhere in the back
              office they would have to open a second tab to reach. */}
          <SignOutButton />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {view === 'till' && (
          <Till
            resumeOrderId={resumeOrderId}
            startTableId={startTableId}
            onOpened={openTill}
          />
        )}
        {view === 'parked' && <ParkedView onResume={resumeSale} />}
        {view === 'orders' && <OrdersView />}
        {view === 'kitchen' && <KitchenView />}
        {view === 'tables' && <TablesView onOpenSale={resumeSale} onStartTab={startTab} />}
        {view === 'catalog' && <CatalogView />}
        {view === 'team' && <TeamView />}
        {view === 'close' && <DayClose />}
      </div>

      <DevToolbar />
    </div>
  )
}
