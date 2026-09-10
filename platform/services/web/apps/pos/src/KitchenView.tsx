import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HttpError, kitchen, queryKeys, type Ticket, type TicketLine } from '@twentyfour/api'
import {
  Badge, Button, DENSE_GUTTER, EmptyState, ErrorState, Icon, PageBody, Select,
  Skeleton, cn, useDateFormat, useToast,
} from '@twentyfour/ui'

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
}

/**
 * The prep screens.
 *
 * A trade capability, not a sold module: the industry profile switches it on
 * for food service and nobody ever chooses it from a picker. A candy shop
 * buying the same POS gets a till and never sees this.
 *
 * Designed for a screen on a wall that nobody is holding: large type, colour
 * plus a number for age, and buttons big enough to hit with the back of a hand.
 *
 * The state is the server's, and that is the change worth knowing about. This
 * screen used to derive tickets from the day's orders and hold what had been
 * bumped in a local set, which meant two screens in one kitchen disagreed about
 * what was already cooking and a refresh brought everything back. A claim now
 * belongs to a person, a ticket cannot be passed while a line is still on, and
 * every screen sees the same rail.
 */
export function KitchenView() {
  const dates = useDateFormat()
  const toast = useToast()
  const client = useQueryClient()
  const [station, setStation] = useState('')

  const stations = useQuery({
    queryKey: queryKeys.kitchen.stations(),
    queryFn: () => kitchen.stations(),
  })

  const tickets = useQuery({
    queryKey: queryKeys.kitchen.tickets(station),
    queryFn: () => kitchen.tickets(station || undefined),
    // A wall screen nobody touches. Polling is the whole update mechanism, so
    // it is short enough that a cook is not looking at a stale rail.
    refetchInterval: 5_000,
  })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['kitchen', 'tickets'] })
  }

  const act = useMutation({
    mutationFn: (job: () => Promise<unknown>) => job(),
    onSuccess: refresh,
    onError: (err) => {
      // The refusals are the interesting part and they are written for a
      // kitchen: "somebody is already on that" and "that ticket still has
      // something cooking" both mean act differently, not try again.
      toast.show({
        tone: 'warning',
        title: err instanceof HttpError ? err.message : 'That did not work',
      })
      refresh()
    },
  })

  const list = tickets.data ?? []

  return (
    <PageBody scroll className="bg-bg-inset" gutter={DENSE_GUTTER}>
      {stations.data && stations.data.length > 1 && (
        <div className="mb-3 flex items-center gap-3">
          <Select
            label="Screen"
            value={station}
            onChange={(event) => setStation(event.target.value)}
            className="w-56"
          >
            {/* Everything, which is what a pass wants: knowing when a table's
                whole order is ready is the job. */}
            <option value="">The pass, everything</option>
            {stations.data.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </Select>
        </div>
      )}

      {tickets.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-56" />)}
        </div>
      ) : tickets.isError ? (
        <ErrorState
          title="The rail could not be read"
          description="Nothing has been lost. It will try again on its own in a few seconds."
          className="mt-10 bg-surface"
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon="ChefHat"
          title="Nothing waiting"
          description="Tickets arrive here the moment an order is registered on the till, oldest first."
          className="mt-10 bg-surface"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {list.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              orderedAt={dates.time(ticket.placedAt)}
              busy={act.isPending}
              onClaim={(line) => act.mutate(() => kitchen.claim(line.id))}
              onDone={(line) => act.mutate(() => kitchen.complete(line.id))}
              onPass={() => act.mutate(() => kitchen.pass(ticket.id))}
            />
          ))}
        </div>
      )}
    </PageBody>
  )
}

function TicketCard({
  ticket,
  orderedAt,
  busy,
  onClaim,
  onDone,
  onPass,
}: {
  ticket: Ticket
  orderedAt: string
  busy: boolean
  onClaim: (line: TicketLine) => void
  onDone: (line: TicketLine) => void
  onPass: () => void
}) {
  const age = minutesSince(ticket.placedAt)
  // Age is carried by a number as well as a colour: a prep screen is exactly
  // where somebody colour-blind must not be guessing.
  const late = age >= 12
  const warming = age >= 6
  const ready = ticket.state === 'ready'

  return (
    <article
      className={cn(
        'flex flex-col rounded-xl border-2 bg-surface',
        ready ? 'border-success' : late ? 'border-danger' : warming ? 'border-warning' : 'border-border',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <span className="font-mono text-sm text-text-muted">
          {ticket.orderNumber}
          {ticket.tableLabel && <span className="ml-2 text-text">{ticket.tableLabel}</span>}
        </span>
        <Badge tone={late ? 'danger' : warming ? 'warning' : 'neutral'} icon="Clock">
          {age} min
        </Badge>
      </header>

      <ul className="flex-1 divide-y divide-border px-3.5">
        {ticket.lines
          .filter((line) => line.state !== 'voided')
          .map((line) => (
            <li key={line.id} className="flex items-center gap-2.5 py-2.5 text-lg">
              <span className="tnum shrink-0 font-semibold text-accent-text">{line.quantity}</span>
              <span
                className={cn(
                  'min-w-0 flex-1',
                  line.state === 'done' ? 'text-text-subtle line-through' : 'text-text',
                )}
              >
                {line.name}
                {line.note && <span className="block text-base text-text-muted">{line.note}</span>}
              </span>
              <LineAction line={line} busy={busy} onClaim={onClaim} onDone={onDone} />
            </li>
          ))}
      </ul>

      {ticket.note && (
        <p className="mx-3.5 mb-3 flex gap-2 rounded-lg bg-warning-subtle p-2.5 text-base text-text-muted">
          <Icon name="Info" size="md" className="mt-0.5 shrink-0" />
          {ticket.note}
        </p>
      )}

      <footer className="border-t border-border p-2.5">
        <p className="mb-2 text-center text-sm text-text-subtle">Ordered {orderedAt}</p>
        {/*
          Offered only once everything on it is done. The service refuses it
          otherwise, and a button that is going to be refused is a button that
          teaches a kitchen to press things twice.
        */}
        <Button size="lg" block iconStart="Check" disabled={!ready || busy} onClick={onPass}>
          {ready ? 'Away' : 'Still cooking'}
        </Button>
      </footer>
    </article>
  )
}

function LineAction({
  line,
  busy,
  onClaim,
  onDone,
}: {
  line: TicketLine
  busy: boolean
  onClaim: (line: TicketLine) => void
  onDone: (line: TicketLine) => void
}) {
  if (line.state === 'done') {
    return <Icon name="CheckCircle2" size="md" className="shrink-0 text-success" />
  }
  if (line.state === 'claimed') {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDone(line)}>
        Done
      </Button>
    )
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => onClaim(line)}>
      Start
    </Button>
  )
}
