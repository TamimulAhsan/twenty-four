import { useMemo, useState } from 'react'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import {
  catalog, documents, orders, queryKeys, staff, type Order,
} from '@twentyfour/api'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import { usePermission } from '@twentyfour/rbac'
import {
  Avatar, Badge, Button, Card, Dialog, Icon, MoneyText, Skeleton, Table, TableScroll,
  Td, Th, Tr, cn, useDateFormat, useFormat, useToast, type BadgeTone,
} from '@twentyfour/ui'

const STATUS: Record<Order['status'], { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  partly_refunded: { label: 'Partly refunded', tone: 'warning' },
  voided: { label: 'Voided', tone: 'neutral' },
}

/**
 * One sale, in full.
 *
 * Reached from every table that lists orders, because a row is a summary and
 * the question a merchant has about a summary is always "what was actually in
 * it". Fetches by id rather than taking the row's copy, so a dialog opened
 * from a stale list still shows the truth.
 */
export function OrderDetailDialog({
  orderId,
  onClose,
}: {
  orderId: string | null
  onClose: () => void
}) {
  const terms = useTerms()
  const toast = useToast()
  const dates = useDateFormat()
  const { currency } = useFormat()
  const queryClient = useQueryClient()
  const mayRefund = usePermission('pos.refund')
  const mayVoid = usePermission('pos.void')
  const [confirming, setConfirming] = useState<'void' | 'refund' | null>(null)

  const [orderQuery, itemsQuery, staffQuery, documentsQuery] = useQueries({
    queries: [
      {
        queryKey: queryKeys.orders.detail(orderId ?? ''),
        queryFn: () => orders.detail(orderId as string),
        enabled: orderId !== null,
      },
      {
        queryKey: queryKeys.catalog.items({ includeInactive: true }),
        queryFn: () => catalog.items({ includeInactive: true }),
        enabled: orderId !== null,
      },
      { queryKey: queryKeys.staff.list(), queryFn: staff.list, enabled: orderId !== null },
      { queryKey: queryKeys.documents.list(), queryFn: () => documents.list(), enabled: orderId !== null },
    ],
  })

  const order = orderQuery?.data
  const items = itemsQuery?.data ?? []

  const analysis = useMemo(() => {
    if (!order) return null
    const costs = new Map(items.map((item) => [item.id, item.costPrice?.minor ?? null] as const))
    let cost: number | null = 0
    for (const line of order.lines) {
      const unit = costs.get(line.itemId) ?? null
      cost = cost === null || unit === null ? null : cost + unit * line.quantity
    }
    return { cost, margin: cost === null ? null : order.net.minor - cost }
  }, [order, items])

  const act = useMutation({
    mutationFn: (kind: 'void' | 'refund') =>
      kind === 'void'
        ? orders.void(order!.id, 'Voided from the dashboard')
        : orders.refund(order!.id, { reason: 'Refunded from the dashboard' }),
    onSuccess: (_updated, kind) => {
      void queryClient.invalidateQueries()
      setConfirming(null)
      toast.show({
        tone: 'success',
        title: kind === 'void' ? 'Sale voided' : 'Sale refunded',
        description:
          kind === 'void'
            ? 'Stock has gone back and the sale is out of the day’s takings.'
            : 'A credit note has been issued against the original. The original is unchanged.',
      })
      onClose()
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That was refused', description: error.message }),
  })

  const linked = (documentsQuery?.data ?? []).filter((document) => document.orderId === order?.id)
  const server = (staffQuery?.data ?? []).find((member) => member.id === order?.staffId)
  const canChange = order?.status === 'paid'

  return (
    <Dialog
      open={orderId !== null}
      onClose={onClose}
      size="lg"
      title={order ? order.number : 'Loading'}
      description={order ? dates.dateTime(order.placedAt) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="outline" iconStart="Printer" onClick={() => window.print()}>
            Print
          </Button>
          {canChange && mayVoid && (
            <Button variant="outline" onClick={() => setConfirming('void')}>Void</Button>
          )}
          {canChange && mayRefund && (
            <Button variant="danger" onClick={() => setConfirming('refund')}>Refund</Button>
          )}
        </>
      }
    >
      {orderQuery?.isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
        </div>
      ) : !order ? (
        <p className="text-base text-text-muted">That sale could not be loaded.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {confirming && (
            <Card className="border-danger-border bg-danger-subtle">
              <p className="text-base font-medium text-text">
                {confirming === 'void' ? 'Void this sale?' : 'Refund it in full?'}
              </p>
              <p className="mt-1 text-base text-text-muted">
                {confirming === 'void'
                  ? 'It comes out of the day’s takings and the stock goes back.'
                  : 'A credit note is issued referencing the original. The original document stays exactly as it was issued.'}
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Keep it</Button>
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

          <div className="flex flex-wrap items-center gap-2">
            <Badge dot tone={STATUS[order.status].tone}>{STATUS[order.status].label}</Badge>
            {order.discountCode && <Badge tone="warning">{order.discountCode}</Badge>}
            {order.customerName ? (
              <span className="flex items-center gap-1.5 text-base text-text">
                <Icon name="User" size="sm" className="text-text-subtle" />
                {order.customerName}
              </span>
            ) : (
              <span className="text-base text-text-subtle">Walk-in</span>
            )}
            {server && (
              <span className="flex items-center gap-1.5 text-base text-text-muted">
                <Avatar name={server.name} colour={server.colour} size="sm" />
                {server.name}
              </span>
            )}
          </div>

          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>{terms.t('order_line')}</Th>
                  <Th numeric>Qty</Th>
                  <Th numeric className="hidden sm:table-cell">Unit</Th>
                  <Th numeric className="hidden md:table-cell">Discount</Th>
                  <Th numeric className="hidden lg:table-cell">Net</Th>
                  <Th numeric className="hidden lg:table-cell">Tax</Th>
                  <Th numeric>Total</Th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <Tr key={line.id}>
                    <Td className="font-medium">{line.name}</Td>
                    <Td numeric>{line.quantity}</Td>
                    <Td numeric className="hidden text-text-muted sm:table-cell">
                      <MoneyText value={line.unitPrice} display="none" />
                    </Td>
                    <Td numeric className="hidden md:table-cell">
                      {line.discount ? (
                        <span className="text-warning-text">
                          <MoneyText value={line.discount} display="none" />
                        </span>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                    </Td>
                    <Td numeric className="hidden text-text-muted lg:table-cell">
                      <MoneyText value={line.net} display="none" />
                    </Td>
                    <Td numeric className="hidden text-text-muted lg:table-cell">
                      <MoneyText value={line.tax} display="none" />
                      <span className="ml-1 text-xs text-text-subtle">
                        {line.taxBasisPoints / 100}%
                      </span>
                    </Td>
                    <Td numeric className="font-medium">
                      <MoneyText value={line.gross} display="none" />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>

          <dl className="flex flex-col gap-1.5 border-t border-border pt-4 text-base">
            <Line label="Net" value={<MoneyText value={order.net} display="none" />} muted />
            <Line label="Tax" value={<MoneyText value={order.tax} display="none" />} muted />
            <Line label="Total" value={<MoneyText value={order.gross} />} strong />
            {/* Stated as a fact about the sale, not as a row in the sum. The
                discount is already inside every line's net and gross, so a
                deduction line here reads as money to subtract again and the
                column stops adding up. */}
            {order.discount && (
              <p className="flex items-center gap-1.5 pt-1 text-sm text-text-subtle">
                <Icon name="Percent" size="sm" className="shrink-0 text-warning-text" />
                {order.discountCode ?? 'A discount'} took{' '}
                <MoneyText value={order.discount} display="none" className="font-medium" /> off
                this sale, already reflected above.
              </p>
            )}
            {/* Cost and margin are the merchant's view, never the customer's.
                A receipt shows neither. */}
            {analysis && (
              <Line
                label="What it kept"
                value={
                  analysis.margin === null ? (
                    <span className="text-text-subtle">no cost recorded</span>
                  ) : (
                    <span className={cn(analysis.margin < 0 && 'text-danger-text')}>
                      <MoneyText value={money(analysis.margin, currency)} display="none" />
                      <span className="ml-1.5 text-sm text-text-subtle">
                        {Math.round((analysis.margin / Math.max(order.net.minor, 1)) * 100)}%
                      </span>
                    </span>
                  )
                }
              />
            )}
          </dl>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <section>
              <h3 className="text-sm font-medium text-text">How it was paid</h3>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {order.tenders.map((tender) => (
                  <li key={tender.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="capitalize text-text-muted">{tender.method}</span>
                    <span className="tnum text-right">
                      <MoneyText value={tender.tendered ?? tender.amount} display="none" />
                      {tender.change && tender.change.minor > 0 && (
                        <span className="block text-sm text-text-subtle">
                          change <MoneyText value={tender.change} display="none" />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-sm font-medium text-text">Documents issued</h3>
              {linked.length === 0 ? (
                <p className="mt-2 text-base text-text-subtle">None yet.</p>
              ) : (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {linked.map((document) => (
                    <li key={document.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="font-mono text-sm text-text-muted">{document.number}</span>
                      <Badge tone={document.kind === 'credit_note' ? 'warning' : 'neutral'}>
                        {document.kind.replace(/_/g, ' ')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {order.note && (
            <p className="flex gap-2 rounded-lg bg-surface-sunken p-3 text-base text-text-muted">
              <Icon name="Info" size="md" className="mt-0.5 shrink-0" />
              {order.note}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}

function Line({
  label, value, muted, strong,
}: {
  label: string
  value: React.ReactNode
  muted?: boolean
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn(muted ? 'text-text-muted' : 'text-text', strong && 'font-semibold')}>
        {label}
      </dt>
      <dd className={cn('tnum', strong && 'text-md font-semibold')}>{value}</dd>
    </div>
  )
}
