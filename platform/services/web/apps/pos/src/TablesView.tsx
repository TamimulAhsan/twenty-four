import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys, staff, tables, type DiningTable } from '@twentyfour/api'
import {
  Avatar, Badge, Button, Dialog, EmptyState, ErrorState, Icon, Input, PageBody, Select, Skeleton,
  cn, useToast, type BadgeTone,
} from '@twentyfour/ui'

const STATE: Record<
  DiningTable['status'],
  { label: string; tone: BadgeTone; ring: string; surface: string }
> = {
  free: {
    label: 'Free',
    tone: 'neutral',
    ring: 'border-border',
    surface: 'bg-surface',
  },
  seated: {
    label: 'Seated',
    tone: 'accent',
    ring: 'border-accent',
    surface: 'bg-accent-subtle',
  },
  ordered: {
    label: 'Ordered',
    tone: 'success',
    ring: 'border-success',
    surface: 'bg-success-subtle',
  },
  bill_requested: {
    label: 'Wants the bill',
    tone: 'warning',
    ring: 'border-warning',
    surface: 'bg-warning-subtle',
  },
}

function minutesSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
}

/**
 * The floor.
 *
 * A trade capability, switched on by the industry profile for venues where
 * customers sit down. A food truck cooks to order and has a prep screen; it has
 * no floor, and never sees this.
 *
 * Laid out by area rather than as a drawn plan. A real floor plan needs an
 * editor, and a grid grouped by area answers the two questions a server
 * actually has, which table is free and who has been waiting longest, without
 * one.
 */
export function TablesView({
  onOpenSale,
  onStartTab,
}: {
  /** Opens the tab already running on a table, in the till. */
  onOpenSale: (orderId: string) => void
  /** Starts a new tab against a table, in the till. */
  onStartTab: (tableId: string) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<DiningTable | null>(null)

  const list = useQuery({
    queryKey: queryKeys.tables.list(),
    queryFn: tables.list,
    refetchInterval: 30_000,
  })

  const byArea = useMemo(() => {
    const groups = new Map<string, DiningTable[]>()
    for (const table of list.data ?? []) {
      const bucket = groups.get(table.area) ?? []
      bucket.push(table)
      groups.set(table.area, bucket)
    }
    return [...groups.entries()]
  }, [list.data])

  const free = (list.data ?? []).filter((table) => table.status === 'free').length
  const waiting = (list.data ?? []).filter((table) => table.status === 'bill_requested').length

  return (
    <PageBody scroll>
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          icon="Grid3x3"
          title="No tables set up yet"
          description="Add your floor in settings and it appears here."
          className="mt-10"
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" dot>
              {free} free
            </Badge>
            {waiting > 0 && (
              <Badge tone="warning" icon="TriangleAlert">
                {waiting} waiting to pay
              </Badge>
            )}
          </div>

          {byArea.map(([area, group]) => (
            <section key={area}>
              <h2 className="mb-2 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
                {area}
              </h2>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
                {group.map((table) => {
                  const state = STATE[table.status]
                  const sitting = minutesSince(table.seatedAt)
                  return (
                    <button
                      key={table.id}
                      type="button"
                      onClick={() => setSelected(table)}
                      className={cn(
                        'flex h-28 flex-col justify-between rounded-xl border-2 p-3 text-left',
                        'transition-[transform,filter] duration-[var(--duration-fast)]',
                        'hover:brightness-[1.03] active:scale-[0.98]',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                        state.ring,
                        state.surface,
                      )}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-xl font-semibold text-text">{table.label}</span>
                        <span className="flex items-center gap-1 text-sm text-text-muted">
                          <Icon name="Users" size="sm" />
                          {table.partySize ?? table.seats}
                        </span>
                      </span>
                      <span>
                        {/* Status is a word as well as a colour. A floor screen
                            is glanced at across a room, which is exactly where
                            colour alone stops carrying meaning. */}
                        <span className="block text-sm font-medium text-text">{state.label}</span>
                        <span className="flex items-center gap-1.5">
                          {sitting !== null && (
                            <span className="tnum text-sm text-text-muted">{sitting} min</span>
                          )}
                          {/* Money on the table. Worth its own mark: clearing
                              a table with an unpaid tab on it is the mistake
                              this screen exists to prevent. */}
                          {table.orderId !== null && (
                            <span className="flex items-center gap-1 text-sm font-medium text-text">
                              <Icon name="Receipt" size="sm" />
                              Tab
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <TableDialog
        table={selected}
        onOpenSale={onOpenSale}
        onStartTab={onStartTab}
        onClose={() => setSelected(null)}
        onDone={(message) => {
          void queryClient.invalidateQueries({ queryKey: ['tables'] })
          toast.show({ tone: 'success', title: message })
          setSelected(null)
        }}
      />
    </PageBody>
  )
}

function TableDialog({
  table,
  onClose,
  onDone,
  onOpenSale,
  onStartTab,
}: {
  table: DiningTable | null
  onClose: () => void
  onDone: (message: string) => void
  onOpenSale: (orderId: string) => void
  onStartTab: (tableId: string) => void
}) {
  const [partySize, setPartySize] = useState('')
  const [staffId, setStaffId] = useState('')

  const team = useQuery({
    queryKey: queryKeys.staff.list(),
    queryFn: staff.list,
    enabled: table !== null,
  })

  const update = useMutation({
    mutationFn: (input: Parameters<typeof tables.update>[1]) => tables.update(table!.id, input),
    onSuccess: (updated) => {
      onDone(
        updated.status === 'free'
          ? `Table ${updated.label} cleared`
          : `Table ${updated.label} is ${STATE[updated.status].label.toLowerCase()}`,
      )
      setPartySize('')
      setStaffId('')
    },
  })

  const bookable = (team.data ?? []).filter((member) => member.status === 'active')

  return (
    <Dialog
      open={table !== null}
      onClose={onClose}
      title={table ? `Table ${table.label}` : ''}
      description={table ? `${table.area} · seats ${table.seats}` : undefined}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {table && (
        <div className="flex flex-col gap-5">
          <Badge dot tone={STATE[table.status].tone}>
            {STATE[table.status].label}
          </Badge>

          {table.status === 'free' ? (
            <div className="flex flex-col gap-4">
              <Input
                label="Party size"
                inputMode="numeric"
                numeric
                value={partySize}
                onChange={(event) => setPartySize(event.target.value)}
                hint={`This table seats ${table.seats}.`}
                error={update.error?.message}
              />
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text">Serving</span>
                <Select value={staffId} onChange={(event) => setStaffId(event.target.value)}>
                  <option value="">Nobody yet</option>
                  {bookable.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                size="lg"
                loading={update.isPending}
                disabled={partySize.trim() === ''}
                onClick={() =>
                  update.mutate({
                    status: 'seated',
                    partySize: Number(partySize),
                    staffId: staffId || null,
                  })
                }
              >
                Seat this party
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <dl className="flex flex-col gap-1.5 text-base">
                <div className="flex justify-between">
                  <dt className="text-text-muted">Party</dt>
                  <dd className="tnum font-medium">{table.partySize}</dd>
                </div>
                {table.seatedAt && (
                  <div className="flex justify-between">
                    <dt className="text-text-muted">Sitting</dt>
                    <dd className="tnum font-medium">{minutesSince(table.seatedAt)} min</dd>
                  </div>
                )}
                {table.staffId && (
                  <div className="flex items-center justify-between">
                    <dt className="text-text-muted">Serving</dt>
                    <dd className="flex items-center gap-2 font-medium">
                      <Avatar
                        name={bookable.find((m) => m.id === table.staffId)?.name ?? '?'}
                        colour={bookable.find((m) => m.id === table.staffId)?.colour}
                        size="sm"
                      />
                      {bookable.find((m) => m.id === table.staffId)?.name ?? 'Unknown'}
                    </dd>
                  </div>
                )}
              </dl>

              {/* The tab comes first. It is the reason a server opened this
                  dialog on a table that is already occupied, and everything
                  else here is housekeeping around it. */}
              <div className="flex flex-wrap gap-2">
                {table.orderId !== null ? (
                  <Button
                    size="lg"
                    iconStart="Receipt"
                    className="flex-1"
                    onClick={() => onOpenSale(table.orderId as string)}
                  >
                    Open the tab
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="outline"
                    iconStart="Plus"
                    className="flex-1"
                    onClick={() => onStartTab(table.id)}
                  >
                    Start a tab
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {table.status !== 'ordered' && (
                  <Button
                    variant="outline"
                    loading={update.isPending}
                    onClick={() => update.mutate({ status: 'ordered' })}
                  >
                    Mark ordered
                  </Button>
                )}
                {table.status !== 'bill_requested' && (
                  <Button
                    variant="outline"
                    loading={update.isPending}
                    onClick={() => update.mutate({ status: 'bill_requested' })}
                  >
                    Wants the bill
                  </Button>
                )}
                <Button
                  loading={update.isPending}
                  disabled={table.orderId !== null}
                  onClick={() => update.mutate({ status: 'free' })}
                >
                  Clear the table
                </Button>
              </div>

              {table.orderId !== null && (
                <p className="text-sm text-text-muted">
                  This table cannot be cleared while a tab is open on it. Settle it or throw it
                  away first, or the sale is left with nothing pointing at it.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
