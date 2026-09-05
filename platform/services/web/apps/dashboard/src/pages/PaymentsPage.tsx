import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { payments, queryKeys, type Payment } from '@twentyfour/api'
import { OrderDetailDialog } from '../components/OrderDetailDialog'
import { PaymentDetailDialog } from './PaymentDetailDialog'
import {
  Badge, Card, EmptyState, ErrorState, MoneyText, PageHeader, Skeleton, StatTile,
  Table, TableScroll, Td, Th, Tr, useDateFormat, useFormat,
} from '@twentyfour/ui'
import { money } from '@twentyfour/money'

const TONE = {
  captured: 'success', authorised: 'accent', pending: 'warning',
  refunded: 'neutral', failed: 'danger',
} as const

export function PaymentsPage() {
  const [open, setOpen] = useState<Payment | null>(null)
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const dates = useDateFormat()
  const { currency } = useFormat()
  const list = useQuery({ queryKey: queryKeys.payments.list(), queryFn: () => payments.list() })

  const rows = list.data ?? []
  const captured = money(rows.filter((row) => row.status === 'captured').reduce((sum, row) => sum + row.amount.minor, 0), currency)
  const refunded = money(rows.reduce((sum, row) => sum + row.refunded.minor, 0), currency)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payments"
        /* Provider-neutral by contract. The dashboard never names a rail,
           because the market implementation behind it is swapped per
           deployment and this page must read the same in both. */
        description="Every payment this market’s providers have settled, with what each one is against."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Captured" icon="CreditCard" money={captured} loading={list.isPending} />
        <StatTile label="Refunded" icon="RotateCcw" money={refunded} loading={list.isPending} />
        <StatTile label="Transactions" icon="ReceiptText" value={rows.length} loading={list.isPending} />
      </div>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState icon="CreditCard" title="No payments yet" description="Card and wallet payments appear here the moment they settle. Cash sales stay on the order." />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>When</Th>
                  <Th>Method</Th>
                  <Th>Status</Th>
                  <Th numeric className="hidden sm:table-cell">Refunded</Th>
                  <Th numeric>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((payment) => (
                  <Tr key={payment.id} interactive onClick={() => setOpen(payment)}>
                    <Td className="font-mono text-sm text-text-muted">{payment.providerReference ?? '—'}</Td>
                    <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(payment.createdAt)}</Td>
                    <Td className="capitalize">{payment.method}</Td>
                    <Td><Badge dot tone={TONE[payment.status]}>{payment.status}</Badge></Td>
                    <Td numeric className="hidden text-text-muted sm:table-cell">
                      {payment.refunded.minor > 0 ? <MoneyText value={payment.refunded} display="none" /> : '—'}
                    </Td>
                    <Td numeric className="font-medium"><MoneyText value={payment.amount} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <PaymentDetailDialog
        payment={open}
        onClose={() => setOpen(null)}
        onOpenOrder={(id) => {
          setOpen(null)
          setOpenOrder(id)
        }}
      />
      <OrderDetailDialog orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  )
}
