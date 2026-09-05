import { useMemo, useState } from 'react'
import {
  change,
  dayCount,
  financialSummary,
  hourlyHeatmap,
  revenueBy,
  revenueByDay,
} from '@twentyfour/analytics'
import { money, type Money } from '@twentyfour/money'
import {
  Badge, Card, CardHeader, ErrorState, Heatmap, Icon, MoneyText, PageHeader, RankBars,
  ShareBar, Skeleton, Table, TableScroll, Td, Th, Tr, TrendChart, cn,
  useDateFormat, useFormat,
} from '@twentyfour/ui'
import { OrderDetailDialog } from '../components/OrderDetailDialog'
import { useTradeData } from '../analytics/useTradeData'
import { PeriodPicker, usePeriod } from '../analytics/PeriodPicker'
import { Delta } from '../analytics/Delta'

export function FinancialsPage() {
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const { preset, setPreset, period, comparison } = usePeriod('30d')
  const data = useTradeData(period)
  const { currency, locale } = useFormat()
  const dates = useDateFormat()
  const [showAll, setShowAll] = useState(false)

  const analysis = useMemo(() => {
    const now = financialSummary(data.orders)
    const before = financialSummary(data.previousOrders)
    const days = dayCount(period)
    const series = revenueByDay(data.orders, period)
    const priorSeries = revenueByDay(data.previousOrders, comparison)

    const categories = new Map(data.items.map((item) => [item.id, item.categoryId ?? 'Uncategorised']))
    const byCategory = new Map<string, number>()
    for (const order of data.orders) {
      for (const line of order.lines) {
        const key = categories.get(line.itemId) ?? 'Uncategorised'
        byCategory.set(key, (byCategory.get(key) ?? 0) + line.grossMinor)
      }
    }

    return {
      now,
      before,
      days,
      series,
      priorSeries,
      byMethod: revenueBy(data.orders, (order) => order.method, { limit: 4 }),
      byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
      heat: hourlyHeatmap(data.orders),
    }
  }, [data.orders, data.previousOrders, data.items, period, comparison])

  const zero = money(0, currency)
  const amount = (minor: number | null): Money => (minor === null ? zero : money(minor, currency))
  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

  if (data.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Financials" />
        <ErrorState onRetry={data.refetch} />
      </div>
    )
  }

  const { now, before } = analysis
  const categoryName = (id: string) =>
    data.items.find((item) => item.categoryId === id)?.categoryId === id
      ? (id.split('-').pop() ?? id).replace(/_/g, ' ')
      : id

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Financials"
        description="What the business took, what it kept, and where both came from."
      />

      <PeriodPicker preset={preset} onChange={setPreset} comparison={comparison} />

      {/* Gross, net and margin are three different questions and a merchant
          needs all three at once. Tax is shown separately and never inside a
          revenue figure: it was collected on someone else's behalf. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FigureTile
          label="Revenue taken"
          hint="Everything customers paid, tax included"
          value={amount(now.grossMinor)}
          delta={change(now.grossMinor, before.grossMinor)}
          loading={data.isPending}
        />
        <FigureTile
          label="Gross margin"
          hint="Net less what the goods cost"
          value={amount(now.marginMinor)}
          secondary={now.marginRate === null ? 'no cost recorded' : `${(now.marginRate * 100).toFixed(1)}% of net`}
          delta={change(now.marginMinor ?? 0, before.marginMinor ?? 0)}
          loading={data.isPending}
        />
        <FigureTile
          label="Average basket"
          hint={`Across ${now.orders} sales`}
          value={amount(now.averageBasketMinor)}
          delta={change(now.averageBasketMinor, before.averageBasketMinor)}
          loading={data.isPending}
        />
        <FigureTile
          label="Given away"
          hint="Discounts, before refunds"
          value={amount(now.discountMinor)}
          delta={change(now.discountMinor, before.discountMinor)}
          goodWhenUp={false}
          loading={data.isPending}
        />
      </div>

      <Card>
        <TrendChart
          title="Revenue by day"
          caption={`Solid is this period. Dashed is the ${analysis.days} days before it, aligned day for day.`}
          labels={analysis.series.map((point) => point.date)}
          formatLabel={(label) => dates.date(label)}
          formatValue={(value) => compact(value)}
          series={[
            { key: 'now', label: 'This period', values: analysis.series.map((point) => point.grossMinor) },
            {
              key: 'before',
              label: 'Previous period',
              comparison: true,
              values: analysis.priorSeries.map((point) => point.grossMinor),
            },
          ]}
          height={260}
        />
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1fr]">
        <Card padded={false}>
          <CardHeader
            className="p-5"
            title="From takings to margin"
            description="Every step between what customers paid and what the business kept."
          />
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th numeric>Amount</Th>
                  <Th numeric className="hidden sm:table-cell">Share of net</Th>
                </tr>
              </thead>
              <tbody>
                <LedgerRow label="Revenue taken" hint="Gross, as the customer paid" value={amount(now.grossMinor)} />
                <LedgerRow
                  label="Tax collected"
                  hint="Owed onward. Never yours."
                  value={amount(-now.taxMinor)}
                  muted
                />
                <LedgerRow label="Net revenue" value={amount(now.netMinor)} emphasis share={1} netMinor={now.netMinor} />
                <LedgerRow
                  label="Cost of goods"
                  hint={now.costMinor === null ? 'Not recorded on every item' : undefined}
                  value={now.costMinor === null ? null : amount(-now.costMinor)}
                  netMinor={now.netMinor}
                  share={now.costMinor === null ? null : -now.costMinor / now.netMinor}
                  muted
                />
                <LedgerRow
                  label="Gross margin"
                  value={now.marginMinor === null ? null : amount(now.marginMinor)}
                  netMinor={now.netMinor}
                  share={now.marginRate}
                  emphasis
                />
                <LedgerRow
                  label="Refunded"
                  value={amount(-now.refundedMinor)}
                  netMinor={now.netMinor}
                  share={now.netMinor === 0 ? null : -now.refundedMinor / now.netMinor}
                  muted
                />
              </tbody>
            </Table>
          </TableScroll>
          {now.costMinor === null && (
            <p className="flex items-start gap-2 border-t border-border p-4 text-sm text-text-muted">
              <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
              Some items have no cost recorded, so margin cannot be calculated for the whole
              period. Add a cost in the catalog and this fills in.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="How people paid" description="Whatever this market's rails answered with." />
            <ShareBar
              className="mt-4"
              segments={analysis.byMethod.map((row) => ({
                key: row.key,
                label: row.key.charAt(0).toUpperCase() + row.key.slice(1),
                value: row.grossMinor,
                display: `${Math.round(row.share * 100)}%`,
              }))}
            />
          </Card>

          <Card>
            <CardHeader title="Where the money came from" description="Revenue by category." />
            <RankBars
              className="mt-4"
              rows={analysis.byCategory.slice(0, 6).map(([id, value]) => ({
                key: id,
                label: categoryName(id),
                value,
                display: <MoneyText value={money(value, currency)} display="none" />,
                meta: `${Math.round((value / Math.max(now.grossMinor, 1)) * 100)}%`,
              }))}
            />
          </Card>
        </div>
      </div>

      <Card>
        <Heatmap
          title="When the money comes in"
          caption="Revenue by hour and weekday. This is the shape that decides a rota."
          cells={analysis.heat.map((cell) => ({
            weekday: cell.weekday,
            hour: cell.hour,
            value: cell.grossMinor,
            detail: <p className="tnum mt-0.5 text-text-subtle">{cell.orders} sales</p>,
          }))}
          formatValue={(value) => (value === 0 ? 'Nothing' : compact(value))}
        />
      </Card>

      <Card padded={false}>
        <CardHeader
          className="p-5"
          title="Every transaction"
          description="Each sale with what it cost, what it kept, and what took it there."
        />
        {data.isPending ? (
          <div className="flex flex-col gap-3 p-5 pt-0">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        ) : (
          <>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th className="hidden lg:table-cell">Customer</Th>
                    <Th className="hidden md:table-cell">Method</Th>
                    <Th className="hidden xl:table-cell">Code</Th>
                    <Th numeric className="hidden sm:table-cell">Net</Th>
                    <Th numeric className="hidden sm:table-cell">Cost</Th>
                    <Th numeric>Margin</Th>
                    <Th numeric>Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders
                    .slice()
                    .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
                    .slice(0, showAll ? 200 : 12)
                    .map((order) => {
                      const cost = order.lines.some((line) => line.costMinor === null)
                        ? null
                        : order.lines.reduce((sum, line) => sum + (line.costMinor ?? 0), 0)
                      const margin = cost === null ? null : order.netMinor - cost
                      return (
                        <Tr key={order.id} interactive onClick={() => setOpenOrder(order.id)}>
                          <Td className="whitespace-nowrap text-text-muted">
                            {dates.dateTime(order.placedAt)}
                          </Td>
                          <Td className="hidden max-w-40 truncate lg:table-cell">
                            {data.customers.find((customer) => customer.id === order.customerId)?.name ?? (
                              <span className="text-text-subtle">Walk-in</span>
                            )}
                          </Td>
                          <Td className="hidden capitalize text-text-muted md:table-cell">{order.method}</Td>
                          <Td className="hidden xl:table-cell">
                            {order.discountCode ? (
                              <Badge tone="warning">{order.discountCode}</Badge>
                            ) : (
                              <span className="text-text-subtle">—</span>
                            )}
                          </Td>
                          <Td numeric className="hidden text-text-muted sm:table-cell">
                            <MoneyText value={money(order.netMinor, currency)} display="none" />
                          </Td>
                          <Td numeric className="hidden text-text-muted sm:table-cell">
                            {cost === null ? '—' : <MoneyText value={money(cost, currency)} display="none" />}
                          </Td>
                          <Td numeric>
                            {margin === null ? (
                              <span className="text-text-subtle">—</span>
                            ) : (
                              <span className={cn(margin < 0 && 'text-danger-text')}>
                                <MoneyText value={money(margin, currency)} display="none" />
                              </span>
                            )}
                          </Td>
                          <Td numeric className="font-medium">
                            <MoneyText value={money(order.grossMinor, currency)} />
                          </Td>
                        </Tr>
                      )
                    })}
                </tbody>
              </Table>
            </TableScroll>
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="text-sm font-medium text-accent-text underline-offset-4 hover:underline"
              >
                {showAll ? 'Show fewer' : `Show more of the ${now.orders} sales`}
              </button>
            </div>
          </>
        )}
      </Card>

      <OrderDetailDialog orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  )
}

function FigureTile({
  label, hint, value, secondary, delta, goodWhenUp = true, loading,
}: {
  label: string
  hint?: string
  value: Money
  secondary?: string
  delta: number | null
  goodWhenUp?: boolean
  loading: boolean
}) {
  return (
    <Card>
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <div className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-text">
        {loading ? <Skeleton className="h-8 w-28" /> : <MoneyText value={value} deemphasiseSymbol />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {!loading && <Delta value={delta} goodWhenUp={goodWhenUp} />}
        {secondary && <span className="text-sm text-text-subtle">{secondary}</span>}
      </div>
      {hint && <p className="mt-1 text-sm text-text-subtle">{hint}</p>}
    </Card>
  )
}

function LedgerRow({
  label, hint, value, share, netMinor, emphasis, muted,
}: {
  label: string
  hint?: string
  value: Money | null
  share?: number | null
  netMinor?: number
  emphasis?: boolean
  muted?: boolean
}) {
  return (
    <Tr>
      <Td className={cn(emphasis && 'font-semibold')}>
        {label}
        {hint && <span className="block text-sm font-normal text-text-subtle">{hint}</span>}
      </Td>
      <Td numeric className={cn(emphasis && 'font-semibold', muted && 'text-text-muted')}>
        {value === null ? <span className="text-text-subtle">not recorded</span> : <MoneyText value={value} display="none" />}
      </Td>
      <Td numeric className="hidden text-text-muted sm:table-cell">
        {share === null || share === undefined || netMinor === 0
          ? '—'
          : `${(share * 100).toFixed(1)}%`}
      </Td>
    </Tr>
  )
}
