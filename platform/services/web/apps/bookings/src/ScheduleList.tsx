import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { bookings, queryKeys, type Booking } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  PageBody, Badge, Card, EmptyState, ErrorState, Input, MoneyText, Skeleton, Table, TableScroll,
  Td, Th, Tr, useDateFormat,
} from '@twentyfour/ui'
import { BookingDetailDialog } from './BookingDialog'

const shift = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const TONE = {
  confirmed: 'accent', arrived: 'success', completed: 'neutral',
  cancelled: 'neutral', no_show: 'danger',
} as const

export function ScheduleList() {
  const terms = useTerms()
  const dates = useDateFormat()
  const [from, setFrom] = useState(shift(-7))
  const [to, setTo] = useState(shift(14))
  const [selected, setSelected] = useState<Booking | null>(null)

  const list = useQuery({
    queryKey: queryKeys.bookings.range(from, to),
    queryFn: () => bookings.range(from, to),
  })

  return (
    <PageBody scroll>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <Input label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <Input label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
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
            icon="CalendarDays"
            title={`No ${terms.t('booking', { plural: true, case: 'lower' })} in that range`}
          />
        ) : (
          <Card padded={false}>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>{terms.t('customer')}</Th>
                    <Th className="hidden sm:table-cell">{terms.t('catalog_item')}</Th>
                    <Th>Status</Th>
                    <Th numeric className="hidden md:table-cell">Deposit</Th>
                    <Th className="hidden lg:table-cell">Reference</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((entry) => (
                    <Tr key={entry.id} interactive onClick={() => setSelected(entry)}>
                      <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(entry.startsAt)}</Td>
                      <Td className="font-medium">{entry.customerName}</Td>
                      <Td className="hidden text-text-muted sm:table-cell">{entry.itemName}</Td>
                      <Td>
                        <Badge dot tone={TONE[entry.status]}>{entry.status.replace(/_/g, ' ')}</Badge>
                      </Td>
                      <Td numeric className="hidden text-text-muted md:table-cell">
                        {entry.deposit ? <MoneyText value={entry.deposit} display="none" /> : '—'}
                      </Td>
                      <Td className="hidden font-mono text-sm text-text-muted lg:table-cell">
                        {entry.reference}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          </Card>
        )}
      </div>

      <BookingDetailDialog booking={selected} onClose={() => setSelected(null)} />
    </PageBody>
  )
}
