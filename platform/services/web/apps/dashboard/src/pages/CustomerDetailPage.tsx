import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { customerMetrics, presetPeriod, revenueByDay, SEGMENTS } from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, MoneyText, PageHeader,
  RankBars, Skeleton, Table, TableScroll, Td, Th, Tr, TrendChart, cn, useDateFormat, useFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import { ReachOutDialog } from './ReachOutDialog'
import { useTradeData } from '../analytics/useTradeData'

const TONE: Record<'good' | 'warn' | 'bad' | 'neutral', BadgeTone> = {
  good: 'success', warn: 'warning', bad: 'danger', neutral: 'neutral',
}

/**
 * One customer, in full.
 *
 * Everything they have bought, when they come, what they favour, and whether
 * they are drifting. The purpose is a decision: call them, offer them
 * something, or leave them alone.
 */
export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const terms = useTerms()
  const dates = useDateFormat()
  const { currency, locale } = useFormat()
  const period = useMemo(() => presetPeriod('90d'), [])
  const [reachingOut, setReachingOut] = useState(false)
  const data = useTradeData(period)

  const analysis = useMemo(() => {
    const theirs = data.orders.filter((order) => order.customerId === id)
    const metrics = customerMetrics({ orders: data.orders }).find(
      (entry) => entry.customerId === id,
    )
    const customer = data.customers.find((entry) => entry.id === id)

    // Weekly buckets rather than daily: one person does not buy every day, and
    // a daily line for a fortnightly customer is a row of zeroes with spikes.
    const weeks = new Map<string, number>()
    for (const order of theirs) {
      const date = new Date(order.placedAt)
      const monday = new Date(date)
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7))
      const key = monday.toISOString().slice(0, 10)
      weeks.set(key, (weeks.get(key) ?? 0) + order.grossMinor)
    }

    const allWeeks = revenueByDay([], period)
      .map((point) => point.date)
      .filter((date) => new Date(date).getDay() === 1)

    return {
      theirs: [...theirs].sort((a, b) => b.placedAt.localeCompare(a.placedAt)),
      metrics,
      customer,
      weekLabels: allWeeks,
      weekValues: allWeeks.map((week) => weeks.get(week) ?? 0),
    }
  }, [data.orders, data.customers, id, period])

  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

  if (data.isError) return <ErrorState onRetry={data.refetch} className="mt-10" />

  if (data.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const { customer, metrics, theirs } = analysis

  if (!customer || !metrics) {
    return (
      <EmptyState
        icon="Users"
        title={`No such ${terms.t('customer', { case: 'lower' })}`}
        description="They may have been removed, or the link may be old."
        action={<Button onClick={() => navigate('/customers')}>Back to the list</Button>}
        className="mt-10"
      />
    )
  }

  const meta = SEGMENTS[metrics.segment]
  const overdue = metrics.overdueRatio

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        iconStart="ArrowLeft"
        className="self-start"
        onClick={() => navigate('/customers')}
      >
        All {terms.t('customer', { plural: true, case: 'lower' })}
      </Button>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar name={customer.name} colour="#2f5bff" size="lg" />
            {customer.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {customer.email && <span>{customer.email}</span>}
            {customer.phone && <span>{customer.phone}</span>}
            {!customer.marketingConsent && (
              <Badge tone="neutral" icon="Ban">
                No marketing consent
              </Badge>
            )}
          </span>
        }
      />

      {/* The action comes before the figures. The figures explain it. */}
      <Card
        className={cn(
          meta.tone === 'bad' && 'border-danger-border bg-danger-subtle',
          meta.tone === 'warn' && 'border-warning-border bg-warning-subtle',
          meta.tone === 'good' && 'border-success-border bg-success-subtle',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <Icon name="ArrowRight" size="lg" className="mt-0.5 shrink-0 text-text-muted" />
            <div>
              <p className="flex items-center gap-2 text-base font-medium text-text">
                <Badge tone={TONE[meta.tone]}>{meta.label}</Badge>
                {meta.meaning}
              </p>
              <p className="mt-1 text-base text-text-muted">{meta.action}</p>
            </div>
          </div>
          {customer.marketingConsent && customer.email && (
            <Button
              variant="outline"
              size="sm"
              iconStart="Bell"
              onClick={() => setReachingOut(true)}
            >
              Send them something
            </Button>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Lifetime value" value={<MoneyText value={money(metrics.lifetimeMinor, currency)} deemphasiseSymbol />} />
        <Metric label="Visits" value={metrics.orderCount} />
        <Metric label="Average basket" value={<MoneyText value={money(metrics.averageBasketMinor, currency)} deemphasiseSymbol />} />
        <Metric
          label="Comes about"
          value={metrics.cadenceDays === null ? 'Once' : `every ${Math.round(metrics.cadenceDays)}d`}
        />
        <Metric
          label="Last seen"
          value={`${metrics.recencyDays}d ago`}
          tone={overdue !== null && overdue > 2 ? 'bad' : overdue !== null && overdue > 1.2 ? 'warn' : undefined}
          hint={
            overdue === null
              ? undefined
              : overdue > 1
                ? `${overdue.toFixed(1)}x their own rhythm`
                : 'Not due yet'
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <TrendChart
            title="What they spend, week by week"
            caption="Weekly, because one person does not buy every day and a daily line would be mostly zeroes."
            labels={analysis.weekLabels}
            formatLabel={(label) => dates.date(label)}
            formatValue={(value) => compact(value)}
            series={[{ key: 'spend', label: customer.name, values: analysis.weekValues }]}
            height={220}
          />
        </Card>

        <Card>
          <CardHeader
            title="What they come for"
            description={`Their most bought ${terms.t('catalog_item', { plural: true, case: 'lower' })}.`}
          />
          <RankBars
            className="mt-4"
            emptyLabel="Nothing bought yet"
            rows={metrics.favouriteItems.map((item) => ({
              key: item.itemId,
              label: item.name,
              value: item.units,
              display: `${item.units}`,
            }))}
          />
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader
          className="p-5"
          title="Every purchase"
          description={`${theirs.length} ${theirs.length === 1 ? 'sale' : 'sales'} since ${dates.date(metrics.firstOrderAt)}.`}
        />
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th className="hidden md:table-cell">Code</Th>
                <Th numeric>Total</Th>
              </tr>
            </thead>
            <tbody>
              {theirs.map((order) => (
                <Tr key={order.id}>
                  <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(order.placedAt)}</Td>
                  <Td>
                    <span className="block truncate">
                      {order.lines.map((line) => `${line.quantity}x ${line.name}`).join(', ')}
                    </span>
                  </Td>
                  <Td className="hidden md:table-cell">
                    {order.discountCode ? (
                      <Badge tone="warning">{order.discountCode}</Badge>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </Td>
                  <Td numeric className="font-medium">
                    <MoneyText value={money(order.grossMinor, currency)} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      <ReachOutDialog
        customer={customer}
        metrics={metrics}
        open={reachingOut}
        onClose={() => setReachingOut(false)}
      />
    </div>
  )
}

function Metric({
  label, value, hint, tone,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'warn' | 'bad'
}) {
  return (
    <Card className={cn(tone === 'bad' && 'border-danger-border', tone === 'warn' && 'border-warning-border')}>
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <p className="tnum mt-1.5 text-lg font-semibold text-text">{value}</p>
      {hint && (
        <p className={cn('mt-0.5 text-sm', tone === 'bad' ? 'text-danger-text' : 'text-text-subtle')}>
          {hint}
        </p>
      )}
    </Card>
  )
}
