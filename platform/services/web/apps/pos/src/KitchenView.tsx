import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { orders, queryKeys } from '@twentyfour/api'
import {
  Badge, Button, DENSE_GUTTER, EmptyState, Icon, PageBody, Skeleton, cn, useDateFormat,
} from '@twentyfour/ui'

const today = () => new Date().toISOString().slice(0, 10)

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
}

/** How long a ticket stays on the rail before it is treated as served. */
const OPEN_TICKET_MINUTES = 120

/**
 * The prep screens.
 *
 * A trade capability, not a sold module: the industry profile switches it on
 * for food service and nobody ever chooses it from a picker. A candy shop
 * buying the same POS gets a till and never sees this.
 *
 * Designed for a screen on a wall that nobody is holding: large type, colour
 * plus a number for age, and one button per ticket big enough to hit with the
 * back of a hand.
 */
export function KitchenView() {
  const dates = useDateFormat()
  const [bumped, setBumped] = useState<Set<string>>(new Set())

  const list = useQuery({
    queryKey: queryKeys.orders.list({ from: today() }),
    queryFn: () => orders.list({ from: today() }),
    refetchInterval: 15_000,
  })

  const tickets = (list.data ?? [])
    .filter((order) => {
      if (order.status !== 'paid' || bumped.has(order.id)) return false
      // A prep screen shows what is still being made, not the day's history.
      // Until the Kitchen Display service exists to hold its own ticket state,
      // the window stands in for it: anything older than this was served long
      // ago, and a screen full of four-hour-old tickets is noise a kitchen
      // learns to ignore.
      return minutesSince(order.placedAt) <= OPEN_TICKET_MINUTES
    })
    // Oldest first. A kitchen works the order things were asked for, so the
    // list a cook reads top to bottom has to be the order they cook in.
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt))

  const bump = (id: string) => setBumped((current) => new Set(current).add(id))

  return (
    <PageBody scroll className="bg-bg-inset" gutter={DENSE_GUTTER}>
      {list.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-56" />)}
        </div>
      ) : tickets.length === 0 ? (
        <EmptyState
          icon="ChefHat"
          title="Nothing waiting"
          description="Tickets arrive here the moment an order is registered on the till, oldest first."
          className="mt-10 bg-surface"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {tickets.map((order) => {
            const age = minutesSince(order.placedAt)
            // Age is carried by a number as well as a colour: a prep screen is
            // exactly where someone colour-blind must not be guessing.
            const late = age >= 12
            const warming = age >= 6
            return (
              <article
                key={order.id}
                className={cn(
                  'flex flex-col rounded-xl border-2 bg-surface',
                  late ? 'border-danger' : warming ? 'border-warning' : 'border-border',
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
                  <span className="font-mono text-sm text-text-muted">{order.number}</span>
                  <Badge tone={late ? 'danger' : warming ? 'warning' : 'neutral'} icon="Clock">
                    {age} min
                  </Badge>
                </header>

                <ul className="flex-1 px-3.5 py-3">
                  {order.lines.map((line) => (
                    <li key={line.id} className="flex gap-2.5 py-1.5 text-lg">
                      <span className="tnum shrink-0 font-semibold text-accent-text">
                        {line.quantity}
                      </span>
                      <span className="min-w-0 text-text">{line.name}</span>
                    </li>
                  ))}
                </ul>

                {order.note && (
                  <p className="mx-3.5 mb-3 flex gap-2 rounded-lg bg-warning-subtle p-2.5 text-base text-text-muted">
                    <Icon name="Info" size="md" className="mt-0.5 shrink-0" />
                    {order.note}
                  </p>
                )}

                <footer className="border-t border-border p-2.5">
                  <p className="mb-2 text-center text-sm text-text-subtle">
                    Ordered {dates.time(order.placedAt)}
                  </p>
                  <Button size="lg" block iconStart="Check" onClick={() => bump(order.id)}>
                    Bump
                  </Button>
                </footer>
              </article>
            )
          })}
        </div>
      )}

      {bumped.size > 0 && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" iconStart="RotateCcw" onClick={() => setBumped(new Set())}>
            Recall {bumped.size} bumped {bumped.size === 1 ? 'ticket' : 'tickets'}
          </Button>
        </div>
      )}
    </PageBody>
  )
}
