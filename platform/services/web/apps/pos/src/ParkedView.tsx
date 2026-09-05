import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { orders, queryKeys, tables as tablesApi, type Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  Badge, Button, Card, Dialog, EmptyState, ErrorState, Icon, MoneyText, PageBody, Skeleton,
  cn, useDateFormat, useToast,
} from '@twentyfour/ui'

const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))

/**
 * Sales that have been set aside.
 *
 * Oldest first, because the one that has been waiting longest is the one
 * somebody needs to do something about. A tab nobody can find is a tab nobody
 * collects, so this is a list and not a menu item.
 */
export function ParkedView({ onResume }: { onResume: (orderId: string) => void }) {
  const terms = useTerms()
  const dates = useDateFormat()
  const [discarding, setDiscarding] = useState<Order | null>(null)

  const parked = useQuery({
    queryKey: queryKeys.orders.parked(),
    queryFn: orders.parked,
    refetchInterval: 30_000,
  })

  // Only to name the table on a card. A till with no floor still parks sales.
  const floor = useQuery({
    queryKey: queryKeys.tables.list(),
    queryFn: tablesApi.list,
    enabled: (parked.data ?? []).some((order) => order.tableId !== null),
  })
  const tableLabel = (order: Order): string | null =>
    order.tableId === null
      ? null
      : (floor.data?.find((table) => table.id === order.tableId)?.label ?? null)

  return (
    <PageBody scroll>
      {parked.isError ? (
        <ErrorState onRetry={() => void parked.refetch()} />
      ) : parked.isPending ? (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32" />)}
        </div>
      ) : parked.data.length === 0 ? (
        <EmptyState
          icon="Clock"
          title="Nothing is parked"
          description={`Press Park on a sale to set it aside. Its ${terms.t('catalog_item', { plural: true, case: 'lower' })} are held back until it is paid for or thrown away.`}
          className="mt-10"
        />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-base text-text-muted">
            {parked.data.length} parked. Nothing here has been paid for, and none of it counts
            towards the day.
          </p>

          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {parked.data.map((order) => {
              const waiting = minutesSince(order.placedAt)
              const label = tableLabel(order)
              return (
                <li key={order.id}>
                  <Card className="flex h-full flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2">
                          <span className="font-mono text-sm text-text-muted">{order.number}</span>
                          {label && <Badge tone="accent">Table {label}</Badge>}
                        </p>
                        <p className="mt-1 text-base text-text-muted">
                          {dates.time(order.placedAt)} · {order.lines.length}{' '}
                          {order.lines.length === 1
                            ? terms.t('order_line', { case: 'lower' })
                            : terms.t('order_line', { plural: true, case: 'lower' })}
                        </p>
                      </div>
                      <span className="tnum shrink-0 text-lg font-semibold">
                        <MoneyText value={order.gross} />
                      </span>
                    </div>

                    <ul className="flex flex-col gap-0.5 text-base text-text-muted">
                      {order.lines.slice(0, 3).map((line) => (
                        <li key={line.id} className="truncate">
                          <span className="tnum">{line.quantity}x </span>
                          {line.name}
                        </li>
                      ))}
                      {order.lines.length > 3 && (
                        <li className="text-text-subtle">
                          and {order.lines.length - 3} more
                        </li>
                      )}
                    </ul>

                    <div className="mt-auto flex items-center gap-2">
                      {/* Position as well as colour: a rail of tabs is scanned
                          from a metre away for the one that has been sitting
                          longest, and an hour is not a shade of orange. */}
                      <span
                        className={cn(
                          'flex items-center gap-1.5 text-sm',
                          waiting >= 60 ? 'font-medium text-warning-text' : 'text-text-subtle',
                        )}
                      >
                        <Icon name="Clock" size="sm" />
                        <span className="tnum">
                          {waiting < 60 ? `${waiting} min` : `${Math.floor(waiting / 60)} h ${waiting % 60} min`}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setDiscarding(order)}
                      >
                        Discard
                      </Button>
                      <Button size="sm" iconStart="ArrowRight" onClick={() => onResume(order.id)}>
                        Open
                      </Button>
                    </div>
                  </Card>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <DiscardDialog order={discarding} onClose={() => setDiscarding(null)} />
    </PageBody>
  )
}

function DiscardDialog({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const discard = useMutation({
    mutationFn: () => orders.discardParked(order!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onClose()
      toast.show({
        tone: 'success',
        title: 'Parked sale thrown away',
        description: 'Nothing was charged, and what it was holding is back on the shelf.',
      })
    },
    onError: (error) => {
      toast.show({ tone: 'danger', title: 'It is still parked', description: error.message })
    },
  })

  return (
    <Dialog
      open={order !== null}
      onClose={onClose}
      title="Throw this sale away?"
      description={order ? order.number : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={discard.isPending} onClick={() => discard.mutate()}>
            Throw it away
          </Button>
        </>
      }
    >
      <p className="text-base text-text-muted">
        Nobody has been charged, so there is nothing to refund. The stock it was holding goes
        straight back, and the sale is gone rather than voided: it never happened.
      </p>
    </Dialog>
  )
}
