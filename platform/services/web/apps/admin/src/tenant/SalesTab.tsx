import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminTenants, type TenantOrder } from '@twentyfour/api'
import {
  Badge,
  Card,
  EmptyState,
  Input,
  MoneyText,
  Select,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  useDateFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import { Preamble } from '../common'
import { useDrawer } from '../Drawer'
import { useEnvironment } from '../session'
import { useTenant, useTenantId } from './useTenant'

/**
 * The merchant's own sales, from the support side.
 *
 * This tab exists because support calls are about one order: a receipt with
 * the wrong footer, a refund stuck in pending, a document the tax authority
 * did not accept. It is a list of transactions, not of people.
 *
 * The design this replaces also carried a customers tab: every one of the
 * merchant's customers, with email, phone and lifetime spend, sorted by who
 * had spent the most. That is not support, it is a marketing list assembled
 * out of somebody else's customer base, and it is the one screen in the design
 * that could not be justified to the person whose data it holds. Answering a
 * data subject request needs one record found by exact address, not a
 * browsable directory, so the browse is gone.
 */
const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  completed: 'success',
  open: 'accent',
  refunded: 'danger',
  partly_refunded: 'warning',
  void: 'neutral',
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  completed: 'Completed',
  open: 'Open',
  refunded: 'Refunded',
  partly_refunded: 'Partly refunded',
  void: 'Void',
}

export function SalesTab() {
  const tenantId = useTenantId()
  const tenant = useTenant()
  const environment = useEnvironment()
  const [channel, setChannel] = useState('all')
  const [query, setQuery] = useState('')

  const orders = useQuery({
    queryKey: adminKeys.tenants.orders(tenantId),
    queryFn: () => adminTenants.orders(tenantId),
    enabled: tenantId.length > 0,
  })

  const channels = useMemo(
    () => [...new Set((orders.data ?? []).map((order) => order.channel))].sort(),
    [orders.data],
  )

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (orders.data ?? []).filter((order) => {
      if (channel !== 'all' && order.channel !== channel) return false
      if (!needle) return true
      return `${order.orderId} ${order.invoiceNumber ?? ''}`.toLowerCase().includes(needle)
    })
  }, [orders.data, channel, query])

  if (orders.isPending || tenant.isPending) return <Skeleton className="h-96" />

  if ((orders.data ?? []).length === 0) {
    return (
      <EmptyState
        icon="Receipt"
        title="No sales yet"
        description="This tenant has not started trading. There is nothing to look up."
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Preamble>
        These are the merchant&rsquo;s own transactions, shown so a support call about one order
        can be answered. Refunding or re-issuing anything happens in their dashboard, under a
        support session, so the action is attributed to you rather than appearing as theirs.
      </Preamble>

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Select
            label="Channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="w-44"
          >
            <option value="all">Every channel</option>
            {channels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <div className="min-w-[14rem] flex-1">
            <Input
              label="Find an order"
              iconStart="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Order or document number"
            />
          </div>
          <p className="pb-3 text-sm text-text-muted">
            {rows.length} of {orders.data?.length ?? 0}
          </p>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon="Search"
            title="Nothing matches"
            description="Check the order number, or widen the channel."
            className="m-4"
          />
        ) : (
          <OrderTable rows={rows} authority={environment.fiscalAuthority} />
        )}
      </Card>
    </div>
  )
}

function OrderTable({ rows, authority }: { rows: readonly TenantOrder[]; authority: string }) {
  const dates = useDateFormat()
  const drawer = useDrawer()

  return (
    <TableScroll className="border-t border-border">
      <Table>
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>When</Th>
            <Th>Channel</Th>
            <Th>Paid by</Th>
            <Th>Contents</Th>
            <Th>Document</Th>
            <Th>Status</Th>
            <Th numeric>Total</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 60).map((order) => (
            <Tr
              key={order.orderId}
              interactive
              onClick={() =>
                drawer.open({
                  title: `Order ${order.orderId}`,
                  subtitle: dates.dateTime(order.placedAt),
                  rows: [
                    { key: 'Channel', value: order.channel },
                    { key: 'Paid by', value: order.tender },
                    { key: 'Contents', value: order.lineSummary },
                    { key: 'Status', value: STATUS_LABEL[order.status] ?? order.status },
                    { key: 'Total', value: <MoneyText value={order.total} /> },
                    {
                      key: 'Document',
                      value: order.invoiceNumber ? (
                        <span className="font-mono text-sm">{order.invoiceNumber}</span>
                      ) : (
                        <span className="text-text-subtle">none issued</span>
                      ),
                    },
                    { key: `With the ${authority.toLowerCase()}`, value: order.fiscalState },
                  ],
                  // The document number, spelled out, because its shape is the
                  // thing people phone about: year, merchant code, sequence,
                  // gapless per tenant per year.
                  payload: order.invoiceNumber
                    ? `${order.invoiceNumber}\nyear · merchant code · sequence`
                    : undefined,
                })
              }
            >
              <Td>
                <span className="font-mono text-sm">{order.orderId}</span>
              </Td>
              <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(order.placedAt)}</Td>
              <Td className="text-text-muted">{order.channel}</Td>
              <Td className="text-text-muted">{order.tender}</Td>
              <Td className="text-text-muted">{order.lineSummary}</Td>
              <Td>
                {order.invoiceNumber ? (
                  <span className="font-mono text-xs">{order.invoiceNumber}</span>
                ) : (
                  <span className="text-sm text-text-subtle">none</span>
                )}
                {order.fiscalState === 'queued' && (
                  <Badge tone="warning" className="ml-2">
                    queued
                  </Badge>
                )}
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>
                  {STATUS_LABEL[order.status] ?? order.status}
                </Badge>
              </Td>
              <Td numeric>
                <MoneyText value={order.total} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {rows.length > 60 && (
        <p className="border-t border-border px-4 py-2.5 text-sm text-text-subtle">
          Showing the 60 most recent. Narrow the search to find an older one.
        </p>
      )}
    </TableScroll>
  )
}
