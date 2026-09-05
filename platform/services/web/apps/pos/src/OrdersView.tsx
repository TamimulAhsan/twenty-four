import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { orders, queryKeys, type Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  PageBody, Badge, Button, Card, Dialog, EmptyState, ErrorState, MoneyText, Skeleton, cn, useDateFormat, useToast,
} from '@twentyfour/ui'

const today = () => new Date().toISOString().slice(0, 10)

/** Today's sales, on the till, so a cashier can reprint or refund without
 *  leaving the counter and opening the back office. */
export function OrdersView() {
  const terms = useTerms()
  const dates = useDateFormat()
  const [selected, setSelected] = useState<Order | null>(null)

  const list = useQuery({
    queryKey: queryKeys.orders.list({ from: today() }),
    queryFn: () => orders.list({ from: today() }),
  })

  return (
    <PageBody scroll>
      <div>
        {list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-16" />)}
          </div>
        ) : list.data.length === 0 ? (
          <EmptyState
            icon="ReceiptText"
            title={`No ${terms.t('order', { plural: true, case: 'lower' })} yet today`}
            description="Sales appear here as soon as they are rung up."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {list.data.map((order) => (
              <li key={order.id}>
                <button
                  type="button"
                  onClick={() => setSelected(order)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3.5 text-left',
                    'transition-colors hover:bg-surface-hover',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-text-muted">{order.number}</p>
                    <p className="mt-0.5 text-base text-text">
                      {dates.time(order.placedAt)} · {order.lines.length}{' '}
                      {order.lines.length === 1
                        ? terms.t('order_line', { case: 'lower' })
                        : terms.t('order_line', { plural: true, case: 'lower' })}
                    </p>
                  </div>
                  <Badge
                    dot
                    tone={order.status === 'paid' ? 'success' : order.status === 'voided' ? 'neutral' : 'warning'}
                  >
                    {order.status.replace(/_/g, ' ')}
                  </Badge>
                  <span className="tnum shrink-0 text-md font-semibold">
                    <MoneyText value={order.gross} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <OrderDialog order={selected} onClose={() => setSelected(null)} />
    </PageBody>
  )
}

function OrderDialog({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<'void' | 'refund' | null>(null)

  const act = useMutation({
    mutationFn: (kind: 'void' | 'refund') =>
      kind === 'void'
        ? orders.void(order!.id, 'Voided at the till')
        : orders.refund(order!.id, { reason: 'Refunded at the till' }),
    onSuccess: (_updated, kind) => {
      void queryClient.invalidateQueries()
      setConfirming(null)
      onClose()
      toast.show({
        tone: 'success',
        title: kind === 'void' ? 'Sale voided' : 'Sale refunded',
        description:
          kind === 'void'
            ? 'Stock has gone back and the sale is out of the day’s takings.'
            : 'A credit note has been issued against the original. The original is unchanged.',
      })
    },
  })

  const canChange = order?.status === 'paid'

  return (
    <Dialog
      open={order !== null}
      onClose={onClose}
      title={order ? order.number : ''}
      description={order ? dates.dateTime(order.placedAt) : undefined}
      footer={
        order && canChange ? (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="outline" onClick={() => setConfirming('void')}>Void</Button>
            <Button variant="danger" onClick={() => setConfirming('refund')}>Refund</Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {order && (
        <div className="flex flex-col gap-4">
          {confirming && (
            <Card className={cn('border-danger-border bg-danger-subtle')}>
              <p className="text-base font-medium text-text">
                {confirming === 'void' ? 'Void this sale?' : 'Refund this sale in full?'}
              </p>
              <p className="mt-1 text-base text-text-muted">
                {confirming === 'void'
                  ? 'It comes out of the day’s takings and the stock goes back.'
                  : 'A credit note is issued referencing the original. The original document stays exactly as it was issued.'}
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  Keep it
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={act.isPending}
                  onClick={() => act.mutate(confirming)}
                >
                  Yes, {confirming}
                </Button>
              </div>
            </Card>
          )}

          <ul className="flex flex-col divide-y divide-border">
            {order.lines.map((line) => (
              <li key={line.id} className="flex justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="tnum text-text-muted">{line.quantity}x </span>
                  {line.name}
                </span>
                <span className="tnum shrink-0 font-medium">
                  <MoneyText value={line.gross} display="none" />
                </span>
              </li>
            ))}
          </ul>

          <dl className="flex flex-col gap-1 border-t border-border pt-3 text-base">
            <div className="flex justify-between text-text-muted">
              <dt>Net</dt>
              <dd className="tnum"><MoneyText value={order.net} display="none" /></dd>
            </div>
            <div className="flex justify-between text-text-muted">
              <dt>Tax</dt>
              <dd className="tnum"><MoneyText value={order.tax} display="none" /></dd>
            </div>
            <div className="flex justify-between text-md font-semibold">
              <dt>Total</dt>
              <dd className="tnum"><MoneyText value={order.gross} /></dd>
            </div>
          </dl>
        </div>
      )}
    </Dialog>
  )
}
