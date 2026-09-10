import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { bookings, queryKeys, type BookingResource, type ResourceOpeningWindow } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, PageBody,
  Select, Skeleton, Switch, useToast,
} from '@twentyfour/ui'

/** ISO weekdays, Monday first, which is how the service stores them. */
const WEEKDAYS = [
  { iso: 1, label: 'Monday' },
  { iso: 2, label: 'Tuesday' },
  { iso: 3, label: 'Wednesday' },
  { iso: 4, label: 'Thursday' },
  { iso: 5, label: 'Friday' },
  { iso: 6, label: 'Saturday' },
  { iso: 7, label: 'Sunday' },
] as const

/** Every quarter hour of a day, which is the grid slots are offered on. */
const TIMES = Array.from({ length: 24 * 4 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, '0')
  const m = String((i % 4) * 15).padStart(2, '0')
  return `${h}:${m}`
})

/**
 * When each thing is open, which is what decides the slots the calendar offers.
 *
 * This used to show the business's opening hours from the profile, and that was
 * wrong in a way that looked right: the calendar does not read them. Slots come
 * from a pattern held per resource, so a chair can work Saturdays while the
 * shop's stated hours say something else entirely, and a screen showing the
 * wrong one is worse than a screen showing none.
 */
export function HoursView() {
  const terms = useTerms()
  const toast = useToast()
  const client = useQueryClient()
  const [selectedId, setSelectedId] = useState('')

  const resources = useQuery({
    queryKey: queryKeys.bookings.resources(),
    queryFn: () => bookings.resources(true),
  })

  const list = resources.data ?? []
  const selected = list.find((entry) => entry.id === selectedId) ?? list[0]

  return (
    <PageBody scroll>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_1fr]">
        <Card padded={false}>
          <div className="flex flex-wrap items-end justify-between gap-3 p-5">
            <CardHeader
              title="Working hours"
              description="The outer limit for every slot the calendar will offer."
            />
            {list.length > 1 && (
              <Select
                label="Which"
                value={selected?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
                className="w-48"
              >
                {list.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </Select>
            )}
          </div>

          {resources.isLoading && <Skeleton className="m-5 h-64" />}
          {resources.isError && (
            <ErrorState
              title="These could not be read"
              description="Nothing has changed. Try again."
              className="m-5"
            />
          )}
          {resources.data && list.length === 0 && (
            <EmptyState
              icon="CalendarDays"
              title={`Nothing can be booked yet`}
              description={`Add a ${terms.t('staff_member', { case: 'lower' })}, a room or a table, and its hours decide which slots the calendar offers.`}
              className="m-5"
            />
          )}
          {selected && (
            <OpeningEditor
              key={selected.id}
              resource={selected}
              onSaved={() => {
                void client.invalidateQueries({ queryKey: queryKeys.bookings.resources() })
                // Availability is derived from these, so every cached answer
                // about a free time is now a stale answer.
                void client.invalidateQueries({ queryKey: ['bookings', 'availability'] })
                toast.show({ tone: 'success', title: 'Hours saved' })
              }}
            />
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="border-accent-border bg-accent-subtle">
            <div className="flex gap-3">
              <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
              <div>
                <p className="text-base font-medium text-text">
                  Two chairs can take the same slot. One chair cannot.
                </p>
                <p className="mt-0.5 text-base text-text-muted">
                  The calendar refuses a second {terms.t('booking', { case: 'lower' })} against
                  something already busy, whichever screen it was made from. That refusal comes
                  from the server under a lock, so it holds even when two people book at the same
                  instant.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex gap-3">
              <Icon name="Clock" size="lg" className="mt-0.5 shrink-0 text-text-subtle" />
              <div>
                <p className="text-base font-medium text-text">How long something takes</p>
                <p className="mt-0.5 text-base text-text-muted">
                  Comes from the {terms.t('catalog_item', { case: 'lower' })} rather than from
                  here, so a long treatment holds the chair longer than a short one without
                  anybody setting it twice.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex gap-3">
              <Icon name="Info" size="lg" className="mt-0.5 shrink-0 text-text-subtle" />
              <div>
                <p className="text-base font-medium text-text">Hours are wall clock</p>
                <p className="mt-0.5 text-base text-text-muted">
                  Nine o'clock stays nine o'clock across a daylight saving change. The times here
                  are read in your own time zone, not stored as fixed instants.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </PageBody>
  )
}

/**
 * One resource's week.
 *
 * The whole pattern is sent on save rather than the days that changed, because
 * the absence of a window is the fact being stated: a merchant who no longer
 * works Saturdays is saying there is no Saturday window, and a patch has no way
 * to send an absence.
 */
function OpeningEditor({
  resource,
  onSaved,
}: {
  resource: BookingResource
  onSaved: () => void
}) {
  const [days, setDays] = useState<Map<number, ResourceOpeningWindow>>(new Map())

  useEffect(() => {
    setDays(new Map(resource.opening.map((window) => [window.weekday, window])))
  }, [resource])

  const save = useMutation({
    mutationFn: () =>
      bookings.putResource({
        id: resource.id,
        name: resource.name,
        staffId: resource.staffId ?? undefined,
        capacity: resource.capacity,
        active: resource.active,
        opening: [...days.values()].sort((a, b) => a.weekday - b.weekday),
      }),
    onSuccess: onSaved,
  })

  const setDay = (weekday: number, patch: Partial<ResourceOpeningWindow> | null) => {
    setDays((current) => {
      const next = new Map(current)
      if (patch === null) {
        next.delete(weekday)
        return next
      }
      const existing = next.get(weekday) ?? { weekday, opens: '09:00', closes: '17:00' }
      next.set(weekday, { ...existing, ...patch })
      return next
    })
  }

  return (
    <div className="border-t border-border">
      <div className="flex flex-col divide-y divide-border">
        {WEEKDAYS.map(({ iso, label }) => {
          const window = days.get(iso)
          return (
            <div key={iso} className="flex flex-wrap items-center gap-3 px-5 py-3">
              {/* The switch carries the day name as its own label, so the
                  toggle and the word are one control rather than two things
                  that happen to sit beside each other. */}
              <div className="w-40 shrink-0">
                <Switch
                  checked={Boolean(window)}
                  label={label}
                  onChange={(open) => setDay(iso, open ? {} : null)}
                />
              </div>
              {window ? (
                <div className="flex items-center gap-2">
                  <Select
                    aria-label={`${label} opens`}
                    value={window.opens}
                    onChange={(event) => setDay(iso, { opens: event.target.value })}
                    className="w-28"
                  >
                    {TIMES.map((time) => <option key={time} value={time}>{time}</option>)}
                  </Select>
                  <span className="text-text-subtle">to</span>
                  <Select
                    aria-label={`${label} closes`}
                    value={window.closes}
                    onChange={(event) => setDay(iso, { closes: event.target.value })}
                    className="w-28"
                  >
                    {TIMES.map((time) => <option key={time} value={time}>{time}</option>)}
                  </Select>
                  {/* A window that closes before it opens crosses midnight,
                      which a bar that shuts at two genuinely does. Said rather
                      than refused. */}
                  {window.closes <= window.opens && (
                    <Badge tone="neutral">Runs past midnight</Badge>
                  )}
                </div>
              ) : (
                <Badge tone="neutral">Closed</Badge>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save hours
        </Button>
      </div>
    </div>
  )
}
