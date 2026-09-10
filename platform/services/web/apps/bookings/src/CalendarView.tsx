import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { bookings, queryKeys, staff, type Booking } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  Avatar, Badge, Button, EmptyState, ErrorState, IconButton, PAGE_GUTTER, Skeleton, cn,
  useDateFormat,
} from '@twentyfour/ui'
import { BookingDetailDialog, NewBookingDialog } from './BookingDialog'

const OPENS = 8
const CLOSES = 20
const HOURS = CLOSES - OPENS
/** Enough that a fifteen-minute slot is still a hittable target. */
const ROW_HEIGHT = 56

const iso = (date: Date) => date.toISOString().slice(0, 10)

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/**
 * The day, as columns of whatever is booked.
 *
 * A calendar's job is to answer "what is free and when" without scrolling, so
 * the whole trading day is on screen at once and each bookable thing is a
 * column. Below the tablet breakpoint that stops working, and it becomes a
 * single ordered list instead of a grid squeezed sideways.
 *
 * The columns are resources rather than staff, and the difference is the whole
 * reason it is worth saying: a salon books a person, a hotel books a room and a
 * restaurant books a table. Drawing columns of people gives a hotel a calendar
 * with no columns at all, and the term set decides what a merchant sees them
 * called.
 */
export function CalendarView() {
  const terms = useTerms()
  const dates = useDateFormat()
  const [day, setDay] = useState(() => new Date())
  const [selected, setSelected] = useState<Booking | null>(null)
  const [creating, setCreating] = useState<{ startsAt: string; resourceId: string | null } | null>(null)

  const date = iso(day)
  const list = useQuery({
    queryKey: queryKeys.bookings.range(date, date),
    queryFn: () => bookings.range(date, date),
  })
  const resources = useQuery({
    queryKey: queryKeys.bookings.resources(),
    queryFn: () => bookings.resources(),
  })
  // Colours are the team's, so a person keeps the same colour on the rota and
  // on the calendar. A resource that is not a person simply has none.
  const people = useQuery({ queryKey: queryKeys.staff.list(), queryFn: staff.list })

  const columns = useMemo(() => {
    const colours = new Map((people.data ?? []).map((member) => [member.id, member.colour]))
    // Something switched off cannot take a booking, so it gets no column. Its
    // past bookings stay attributed to it.
    const active = (resources.data ?? []).filter((entry) => entry.active)
    if (active.length === 0) {
      return [{ id: '', name: 'Unassigned', colour: '#71717a' }]
    }
    return active.map((entry) => ({
      id: entry.id,
      name: entry.name,
      colour: (entry.staffId && colours.get(entry.staffId)) || '#71717a',
    }))
  }, [resources.data, people.data])

  const isToday = date === iso(new Date())

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex items-center gap-1">
          <IconButton icon="ChevronLeft" label="Previous day" size="sm" variant="outline"
            onClick={() => setDay((current) => shiftDays(current, -1))} />
          <IconButton icon="ChevronRight" label="Next day" size="sm" variant="outline"
            onClick={() => setDay((current) => shiftDays(current, 1))} />
        </div>
        <Button size="sm" variant="outline" onClick={() => setDay(new Date())} disabled={isToday}>
          Today
        </Button>
        <h1 className="ml-1 text-md font-semibold text-text">{dates.dateLong(day)}</h1>
        {list.data && (
          <Badge tone="neutral" className="ml-1">
            {list.data.filter((entry) => entry.status !== 'cancelled').length} booked
          </Badge>
        )}
        <Button
          className="ml-auto"
          size="sm"
          iconStart="Plus"
          onClick={() => {
            const start = new Date(day)
            start.setHours(OPENS + 1, 0, 0, 0)
            setCreating({ startsAt: start.toISOString(), resourceId: null })
          }}
        >
          New {terms.t('booking', { case: 'lower' })}
        </Button>
      </header>

      {list.isError ? (
        <div className="p-4"><ErrorState onRetry={() => void list.refetch()} /></div>
      ) : list.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-16" />)}
        </div>
      ) : (
        <>
          {/* Tablet and up: the grid. */}
          <div className="hidden min-h-0 flex-1 overflow-auto md:block">
            <div className="flex min-w-full">
              <div className="sticky left-0 z-10 w-16 shrink-0 border-r border-border bg-bg">
                <div className="h-11 border-b border-border" />
                {Array.from({ length: HOURS }, (_, index) => (
                  <div
                    key={index}
                    className="tnum relative border-b border-border pr-2 text-right text-xs text-text-subtle"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span className="absolute -top-2 right-2">{String(OPENS + index).padStart(2, '0')}:00</span>
                  </div>
                ))}
              </div>

              {columns.map((member) => (
                <div
                  key={member.id || 'none'}
                  className="flex-1 border-r border-border"
                  style={{ minWidth: 168 }}
                >
                  <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-border bg-bg px-3">
                    <Avatar name={member.name} colour={member.colour} size="sm" />
                    <span className="truncate text-base font-medium text-text">{member.name}</span>
                  </div>

                  <div className="relative" style={{ height: HOURS * ROW_HEIGHT }}>
                    {Array.from({ length: HOURS }, (_, index) => (
                      <button
                        key={index}
                        type="button"
                        aria-label={`Book ${member.name} at ${OPENS + index}:00`}
                        onClick={() => {
                          const start = new Date(day)
                          start.setHours(OPENS + index, 0, 0, 0)
                          setCreating({ startsAt: start.toISOString(), resourceId: member.id || null })
                        }}
                        className="absolute inset-x-0 border-b border-border transition-colors hover:bg-accent-subtle"
                        style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                      />
                    ))}

                    {(list.data ?? [])
                      .filter((entry) => entry.resourceId === member.id && entry.status !== 'cancelled')
                      .map((entry) => {
                        const start = new Date(entry.startsAt)
                        const end = new Date(entry.endsAt)
                        const top = ((start.getHours() - OPENS) * 60 + start.getMinutes()) * (ROW_HEIGHT / 60)
                        const height = Math.max(24, ((end.getTime() - start.getTime()) / 60_000) * (ROW_HEIGHT / 60))
                        // Below two lines' worth of height the service name
                        // is dropped rather than clipped: the customer name
                        // alone still identifies the booking, and half a word
                        // sliced off by an overflow reads as a bug.
                        const roomForDetail = height >= 44
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            onClick={() => setSelected(entry)}
                            title={`${entry.customerName} · ${entry.itemName}`}
                            className={cn(
                              'absolute inset-x-1 overflow-hidden rounded-lg border-l-4 px-2 text-left',
                              roomForDetail ? 'py-1' : 'flex items-center py-0',
                              'transition-[transform,filter] hover:brightness-105 active:scale-[0.99]',
                              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                              entry.status === 'no_show'
                                ? 'border-l-danger bg-danger-subtle'
                                : entry.status === 'completed'
                                  ? 'border-l-border-strong bg-surface-sunken'
                                  : 'border-l-accent bg-accent-subtle',
                            )}
                            style={{ top, height }}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-text">
                                {entry.customerName}
                              </span>
                              {roomForDetail && (
                                <span className="block truncate text-xs text-text-muted">
                                  {entry.itemName}
                                </span>
                              )}
                            </span>
                          </button>
                        )
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Phone: a grid squeezed to 390px is unreadable, so it becomes the
              same information as an ordered list. */}
          <div className={cn('min-h-0 flex-1 overflow-y-auto md:hidden', PAGE_GUTTER)}>
            {(list.data ?? []).length === 0 ? (
              <EmptyState
                icon="CalendarDays"
                title="Nothing booked"
                description={`Tap New ${terms.t('booking', { case: 'lower' })} to add the first one.`}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {(list.data ?? []).map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(entry)}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left"
                    >
                      <span className="tnum w-12 shrink-0 text-sm font-medium text-text-muted">
                        {dates.time(entry.startsAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text">{entry.customerName}</span>
                        <span className="block truncate text-sm text-text-subtle">{entry.itemName}</span>
                      </span>
                      {entry.status === 'no_show' && <Badge tone="danger">{terms.t('no_show')}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <NewBookingDialog
        open={creating !== null}
        startsAt={creating?.startsAt ?? null}
        resourceId={creating?.resourceId ?? null}
        onClose={() => setCreating(null)}
      />
      <BookingDetailDialog booking={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
