import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  cohorts,
  customerMetrics,
  presetPeriod,
  segmentSummary,
  SEGMENTS,
  type Segment,
} from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import {
  Badge, Card, CardHeader, EmptyState, ErrorState, Icon, Input, MoneyText, PageHeader,
  Skeleton, Table, TableScroll, Td, Th, Tr, cn, sequentialStep, useDateFormat, useFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import { useTradeData } from '../analytics/useTradeData'

const TONE: Record<'good' | 'warn' | 'bad' | 'neutral', BadgeTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  neutral: 'neutral',
}

const ORDER: Segment[] = [
  'champion', 'loyal', 'promising', 'new', 'occasional',
  'needs_attention', 'at_risk', 'cannot_lose', 'lost',
]

export function CustomersPage() {
  const terms = useTerms()
  const navigate = useNavigate()
  const dates = useDateFormat()
  const { currency } = useFormat()
  const period = useMemo(() => presetPeriod('90d'), [])
  const data = useTradeData(period)

  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState<Segment | ''>('')

  const analysis = useMemo(() => {
    const metrics = customerMetrics({ orders: data.orders })
    return {
      metrics,
      summary: segmentSummary(metrics),
      cohorts: cohorts(data.orders, 4),
      byId: new Map(metrics.map((entry) => [entry.customerId, entry])),
    }
  }, [data.orders])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return analysis.metrics
      .map((entry) => ({
        metrics: entry,
        customer: data.customers.find((candidate) => candidate.id === entry.customerId),
      }))
      .filter((row) => {
        if (!row.customer) return false
        if (segment && row.metrics.segment !== segment) return false
        if (needle && !`${row.customer.name} ${row.customer.email ?? ''}`.toLowerCase().includes(needle)) {
          return false
        }
        return true
      })
  }, [analysis.metrics, data.customers, search, segment])

  const total = analysis.metrics.reduce((sum, entry) => sum + entry.lifetimeMinor, 0)
  const customerWord = terms.t('customer', { plural: true })

  if (data.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={customerWord} />
        <ErrorState onRetry={data.refetch} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={customerWord}
        description="Who they are, what they are worth, and which of them to do something about this week."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label={`Known ${terms.t('customer', { plural: true, case: 'lower' })}`} value={String(analysis.metrics.length)} loading={data.isPending} />
        <SummaryTile
          label="Their lifetime value"
          value={<MoneyText value={money(total, currency)} deemphasiseSymbol />}
          loading={data.isPending}
        />
        <SummaryTile
          label="Repeat rate"
          value={`${Math.round(
            (analysis.metrics.filter((entry) => entry.orderCount > 1).length /
              Math.max(analysis.metrics.length, 1)) * 100,
          )}%`}
          hint="Came back at least once"
          loading={data.isPending}
        />
        <SummaryTile
          label="Worth chasing"
          value={String(
            analysis.summary
              .filter((row) => row.segment === 'at_risk' || row.segment === 'cannot_lose')
              .reduce((sum, row) => sum + row.customers, 0),
          )}
          hint="At risk or about to be lost"
          loading={data.isPending}
        />
      </div>

      {/* Every segment carries the action it implies. A segment nobody knows
          what to do with is a label, not an insight. */}
      <div>
        <CardHeader
          title="Segments"
          description="By how recently they came, how often, and how much they spend. Tap one to filter the list."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ORDER.map((key) => {
            const row = analysis.summary.find((entry) => entry.segment === key)
            const meta = SEGMENTS[key]
            const active = segment === key
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setSegment(active ? '' : key)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                  active ? 'border-accent bg-accent-subtle' : 'border-border bg-surface hover:bg-surface-hover',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <Badge tone={TONE[meta.tone]}>{meta.label}</Badge>
                  <span className="tnum text-lg font-semibold text-text">{row?.customers ?? 0}</span>
                </div>
                <p className="mt-2 text-sm text-text-muted">{meta.meaning}</p>
                <p className="mt-2 flex items-start gap-1.5 text-sm text-text">
                  <Icon name="ArrowRight" size="sm" className="mt-0.5 shrink-0 text-accent-text" />
                  {meta.action}
                </p>
                {row && row.customers > 0 && (
                  <p className="tnum mt-2 text-sm text-text-subtle">
                    <MoneyText value={money(row.revenueMinor, currency)} display="none" /> lifetime,{' '}
                    <MoneyText value={money(row.averageLifetimeMinor, currency)} display="none" /> each
                  </p>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Do they come back"
          description="Each row is everyone who first bought in that month. The columns are the months after."
        />
        {analysis.cohorts.length === 0 ? (
          <p className="mt-4 text-base text-text-subtle">Not enough history yet.</p>
        ) : (
          <TableScroll className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>First bought</Th>
                  <Th numeric>People</Th>
                  {['Month 0', 'Month 1', 'Month 2', 'Month 3'].map((label) => (
                    <Th key={label} numeric>{label}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analysis.cohorts.map((cohort) => (
                  <Tr key={cohort.cohort}>
                    <Td className="font-medium">{cohort.cohort}</Td>
                    <Td numeric className="text-text-muted">{cohort.size}</Td>
                    {cohort.retention.map((value, index) => (
                      <Td key={index} numeric className="p-1">
                        <span
                          className="tnum block rounded-md px-2 py-1.5 text-center text-text"
                          style={{
                            background: value === 0 ? 'var(--surface-sunken)' : sequentialStep(value),
                            color: value > 0.6 ? '#fff' : undefined,
                          }}
                        >
                          {Math.round(value * 100)}%
                        </span>
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      <Card padded={false}>
        <CardHeader
          className="flex-wrap p-5"
          title={`Every ${terms.t('customer', { case: 'lower' })}`}
          action={
            <Input
              type="search"
              iconStart="Search"
              placeholder="Search by name or email"
              className="w-full sm:w-64"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={`Search ${terms.t('customer', { plural: true, case: 'lower' })}`}
            />
          }
        />

        {data.isPending ? (
          <div className="flex flex-col gap-3 p-5 pt-0">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              icon="Users"
              title="Nobody matches that"
              description="Clear the search or the segment filter."
            />
          </div>
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Segment</Th>
                  <Th numeric className="hidden sm:table-cell">Visits</Th>
                  <Th numeric>Lifetime</Th>
                  <Th numeric className="hidden lg:table-cell">Average</Th>
                  <Th className="hidden md:table-cell">Last seen</Th>
                  <Th className="hidden xl:table-cell">Rhythm</Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map(({ metrics, customer }) => {
                  const meta = SEGMENTS[metrics.segment]
                  const overdue = metrics.overdueRatio
                  return (
                    <Tr
                      key={metrics.customerId}
                      interactive
                      onClick={() => navigate(`/customers/${metrics.customerId}`)}
                    >
                      <Td>
                        <span className="block truncate font-medium text-text">{customer?.name}</span>
                        <span className="block truncate text-sm text-text-subtle">
                          {customer?.email ?? customer?.phone ?? 'No contact details'}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={TONE[meta.tone]}>{meta.label}</Badge>
                      </Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        {metrics.orderCount}
                      </Td>
                      <Td numeric className="font-medium">
                        <MoneyText value={money(metrics.lifetimeMinor, currency)} display="none" />
                      </Td>
                      <Td numeric className="hidden text-text-muted lg:table-cell">
                        <MoneyText value={money(metrics.averageBasketMinor, currency)} display="none" />
                      </Td>
                      <Td className="hidden whitespace-nowrap text-text-muted md:table-cell">
                        {dates.date(metrics.lastOrderAt)}
                        <span className="tnum block text-sm text-text-subtle">
                          {metrics.recencyDays} days ago
                        </span>
                      </Td>
                      <Td className="hidden xl:table-cell">
                        {metrics.cadenceDays === null ? (
                          <span className="text-sm text-text-subtle">One visit</span>
                        ) : (
                          <span className="text-sm text-text-muted">
                            about every {Math.round(metrics.cadenceDays)} days
                            {overdue !== null && overdue > 2 && (
                              <span className="tnum block text-danger-text">
                                {overdue.toFixed(1)}x overdue
                              </span>
                            )}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </TableScroll>
        )}
        {rows.length > 60 && (
          <p className="border-t border-border p-3 text-center text-sm text-text-subtle">
            Showing the 60 most valuable of {rows.length}. Search to narrow it.
          </p>
        )}
      </Card>
    </div>
  )
}

function SummaryTile({
  label, value, hint, loading,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  loading: boolean
}) {
  return (
    <Card>
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <div className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-text">
        {loading ? <Skeleton className="h-8 w-24" /> : <span className="tnum">{value}</span>}
      </div>
      {hint && <p className="mt-1 text-sm text-text-subtle">{hint}</p>}
    </Card>
  )
}
