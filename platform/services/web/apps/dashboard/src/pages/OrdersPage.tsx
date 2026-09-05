import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { orders, queryKeys } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { OrderDetailDialog } from '../components/OrderDetailDialog'
import {
  Badge, Card, EmptyState, ErrorState, Input, MoneyText, PageHeader, Select, Skeleton,
  Table, TableScroll, Td, Th, Tr, useDateFormat,
} from '@twentyfour/ui'

const daysAgo = (count: number) => {
  const date = new Date()
  date.setDate(date.getDate() - count)
  return date.toISOString().slice(0, 10)
}

export function OrdersPage() {
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const terms = useTerms()
  const dates = useDateFormat()
  const [from, setFrom] = useState(daysAgo(13))
  const [to, setTo] = useState(daysAgo(0))
  const [status, setStatus] = useState('')

  const list = useQuery({
    queryKey: queryKeys.orders.list({ from, to, status }),
    queryFn: () => orders.list({ from, to, ...(status ? { status } : {}) }),
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={terms.t('order', { plural: true })}
        description="Every sale registered on the till, with what was in it and how it was paid."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:max-w-2xl">
        <Input label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Input label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Any status</option>
          <option value="paid">Paid</option>
          <option value="refunded">Refunded</option>
          <option value="partly_refunded">Partly refunded</option>
          <option value="voided">Voided</option>
        </Select>
      </div>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        </Card>
      ) : list.data.length === 0 ? (
        <EmptyState
          icon="ReceiptText"
          title={`No ${terms.t('order', { plural: true, case: 'lower' })} in that range`}
          description="Widen the dates or clear the status filter."
        />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Number</Th>
                  <Th>When</Th>
                  <Th className="hidden md:table-cell">{terms.t('order_line', { plural: true })}</Th>
                  <Th className="hidden sm:table-cell">Paid by</Th>
                  <Th>Status</Th>
                  <Th numeric className="hidden lg:table-cell">Net</Th>
                  <Th numeric className="hidden lg:table-cell">Tax</Th>
                  <Th numeric>Total</Th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((order) => (
                  <Tr key={order.id} interactive onClick={() => setOpenOrder(order.id)}>
                    <Td className="font-mono text-sm">{order.number}</Td>
                    <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(order.placedAt)}</Td>
                    <Td className="hidden text-text-muted md:table-cell">{order.lines.length}</Td>
                    <Td className="hidden capitalize text-text-muted sm:table-cell">
                      {order.tenders.map((tender) => tender.method).join(', ')}
                    </Td>
                    <Td>
                      <Badge dot tone={order.status === 'paid' ? 'success' : order.status === 'voided' ? 'neutral' : 'warning'}>
                        {order.status.replace(/_/g, ' ')}
                      </Badge>
                    </Td>
                    <Td numeric className="hidden text-text-muted lg:table-cell">
                      <MoneyText value={order.net} display="none" />
                    </Td>
                    <Td numeric className="hidden text-text-muted lg:table-cell">
                      <MoneyText value={order.tax} display="none" />
                    </Td>
                    <Td numeric className="font-medium"><MoneyText value={order.gross} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <OrderDetailDialog orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  )
}
