import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { orders, queryKeys, type Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  RefundActions, RefundCheckbox, RefundConfirmation, RefundHint, useOrderRefund,
} from '@twentyfour/shell'
import {
  PageBody, Badge, Button, Dialog, EmptyState, ErrorState, MoneyText, Skeleton, cn, useDateFormat,
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
  const dates = useDateFormat()
  // Every rule about what can go back, and what it comes to, lives in the
  // shared hook. The till and the dashboard cannot drift apart on it.
  const refund = useOrderRefund({ order, source: 'the till', onDone: onClose })

  return (
    <Dialog
      open={order !== null}
      onClose={onClose}
      title={order ? order.number : ''}
      description={order ? dates.dateTime(order.placedAt) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {order && <RefundActions refund={refund} />}
        </>
      }
    >
      {order && (
        <div className="flex flex-col gap-4">
          <RefundConfirmation order={order} refund={refund} />
          <RefundHint refund={refund} />

          <ul className="flex flex-col divide-y divide-border">
            {order.lines.map((line) => {
              const done = refund.refunded.has(line.id)
              return (
                <li key={line.id}>
                  {/* A line that has already gone back is shown and not
                      offered: hiding it makes a part-refunded sale look like a
                      smaller sale that was never refunded at all. */}
                  <label
                    className={cn(
                      'flex items-center gap-3 py-2.5',
                      done ? 'opacity-60' : refund.canRefund && 'cursor-pointer',
                    )}
                  >
                    {refund.canRefund && <RefundCheckbox line={line} refund={refund} />}
                    <span className="min-w-0 flex-1">
                      <span className="tnum text-text-muted">{line.quantity}x </span>
                      {line.name}
                      {done && <Badge tone="neutral" className="ml-2">Refunded</Badge>}
                    </span>
                    <span className="tnum shrink-0 font-medium">
                      <MoneyText value={line.gross} display="none" />
                    </span>
                  </label>
                </li>
              )
            })}
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
            {order.refunded.minor > 0 && (
              <div className="flex justify-between text-danger-text">
                <dt>Given back</dt>
                <dd className="tnum"><MoneyText value={order.refunded} display="none" /></dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </Dialog>
  )
}
