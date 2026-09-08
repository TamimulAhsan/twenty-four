import { useState } from 'react'
import { RequireModule, Wordmark, useBootstrap } from '@twentyfour/runtime'
import { useTerms } from '@twentyfour/terms'
import { Avatar, Icon, IconButton, ThemeToggle, cn, type IconName } from '@twentyfour/ui'
import { SessionGate, SignOutButton } from '@twentyfour/shell'
import { DevToolbar } from '@twentyfour/shell'
import { CalendarView } from './CalendarView'
import { ScheduleList } from './ScheduleList'
import { ServicesView } from './ServicesView'
import { TeamView } from './TeamView'
import { HoursView } from './HoursView'

export function BookingsApp() {
  return (
    <SessionGate>
      <RequireModule module="bookings" name="Bookings and appointments">
        <BookingsShell />
      </RequireModule>
    </SessionGate>
  )
}

type View = 'calendar' | 'list' | 'services' | 'team' | 'hours'

/**
 * The calendar's own chrome.
 *
 * A different tool from the till and a different one again from the back
 * office: it is looked at all day on a screen behind a desk, and the thing it
 * has to do best is show a whole day at a glance without scrolling.
 */
function BookingsShell() {
  const terms = useTerms()
  const { profile } = useBootstrap()
  const [view, setView] = useState<View>('calendar')

  const tabs: Array<{ id: View; label: string; icon: IconName }> = [
    { id: 'calendar', label: 'Calendar', icon: 'CalendarDays' },
    { id: 'list', label: terms.t('booking', { plural: true }), icon: 'ReceiptText' },
    // Named by the term set: Treatments in a salon, Services in a spa.
    { id: 'services', label: terms.t('catalog_item', { plural: true }), icon: 'LayoutGrid' },
    // Accounts, not the trade role: this list has the owner in it.
    { id: 'team', label: 'Team', icon: 'Users' },
    { id: 'hours', label: 'Hours', icon: 'Clock' },
  ]

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
        <Wordmark suffix={terms.t('booking', { plural: true })} className="hidden sm:flex" />
        <Wordmark className="sm:hidden" />

        <nav
          aria-label="Sections"
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
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <span className="hidden items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-1.5 lg:flex">
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
        {view === 'calendar' && <CalendarView />}
        {view === 'list' && <ScheduleList />}
        {view === 'services' && <ServicesView />}
        {view === 'team' && <TeamView />}
        {view === 'hours' && <HoursView />}
      </div>

      <DevToolbar />
    </div>
  )
}
