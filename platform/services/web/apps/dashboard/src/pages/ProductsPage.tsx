import { useMemo, useState } from 'react'
import {
  basketAffinity,
  dayCount,
  performanceThresholds,
  productPerformance,
  VERDICT_LABELS,
  type ProductPerformance,
  type ProductVerdict,
} from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, MoneyText, PageHeader,
  QuadrantChart, RankBars, Select, Skeleton, Table, TableScroll, Td, Th, Tr, cn, useFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import { CatalogItemDialog } from '@twentyfour/shell'
import { ProductDetailDialog } from './ProductDetailDialog'
import { useTradeData } from '../analytics/useTradeData'
import { PeriodPicker, usePeriod } from '../analytics/PeriodPicker'
import { Delta } from '../analytics/Delta'

const VERDICT_TONE: Record<ProductVerdict, BadgeTone> = {
  star: 'success',
  traffic_driver: 'accent',
  hidden_gem: 'warning',
  drag: 'neutral',
  dormant: 'danger',
}

type SortKey = 'revenue' | 'margin' | 'units' | 'marginRate' | 'change'

export function ProductsPage() {
  const terms = useTerms()
  const { currency, locale } = useFormat()
  const { preset, setPreset, period, comparison } = usePeriod('30d')
  const data = useTradeData(period)
  const [sort, setSort] = useState<SortKey>('revenue')
  const [verdict, setVerdict] = useState<ProductVerdict | ''>('')
  const [open, setOpen] = useState<ProductPerformance | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const analysis = useMemo(() => {
    const rows = productPerformance({
      orders: data.orders,
      previousOrders: data.previousOrders,
      days: dayCount(period),
      catalog: data.items.map((item) => ({
        id: item.id,
        name: item.name,
        categoryId: item.categoryId,
      })),
    })
    return { rows, pairs: basketAffinity(data.orders, { minimumTogether: 4, limit: 8 }) }
  }, [data.orders, data.previousOrders, data.items, period])

  const sorted = useMemo(() => {
    const filtered = verdict ? analysis.rows.filter((row) => row.verdict === verdict) : analysis.rows
    const by: Record<SortKey, (row: ProductPerformance) => number> = {
      revenue: (row) => row.grossMinor,
      margin: (row) => row.marginMinor ?? -Infinity,
      units: (row) => row.units,
      marginRate: (row) => row.marginRate ?? -Infinity,
      change: (row) => row.revenueChange ?? -Infinity,
    }
    return [...filtered].sort((a, b) => by[sort](b) - by[sort](a))
  }, [analysis.rows, sort, verdict])

  const counts = useMemo(() => {
    const map = new Map<ProductVerdict, number>()
    for (const row of analysis.rows) map.set(row.verdict, (map.get(row.verdict) ?? 0) + 1)
    return map
  }, [analysis.rows])

  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

  const itemWord = terms.t('catalog_item', { plural: true })

  if (data.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={`${itemWord} performance`} />
        <ErrorState onRetry={data.refetch} />
      </div>
    )
  }

  const withMargin = analysis.rows.filter((row) => row.marginRate !== null && row.units > 0)
  const thresholds = performanceThresholds(analysis.rows)

  // Scaled so each threshold lands exactly on its divider: an item at the
  // median margin sits on the horizontal line, and one at its fair share of
  // revenue sits on the vertical. Scaling to the maximum instead would put
  // dots in quadrants that contradict their own verdict.
  const place = (value: number, threshold: number): number =>
    threshold <= 0 ? 0.5 : Math.max(0.02, Math.min(0.98, value / (threshold * 2)))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${itemWord} performance`}
        description={`Which of your ${terms.t('catalog_item', { plural: true, case: 'lower' })} to push, which to reprice, and which to stop making.`}
      />

      <PeriodPicker preset={preset} onChange={setPreset} comparison={comparison} />

      {/* The verdict counts are the summary. A merchant should be able to
          read the whole answer here and only then look at the table. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(['star', 'traffic_driver', 'hidden_gem', 'drag', 'dormant'] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={verdict === key}
            onClick={() => setVerdict(verdict === key ? '' : key)}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
              verdict === key
                ? 'border-accent bg-accent-subtle'
                : 'border-border bg-surface hover:bg-surface-hover',
            )}
          >
            <span className="flex items-center gap-2">
              <Badge tone={VERDICT_TONE[key]}>{VERDICT_LABELS[key].label}</Badge>
            </span>
            <span className="mt-2 block text-2xl font-semibold text-text">{counts.get(key) ?? 0}</span>
            <span className="mt-1 block text-sm leading-snug text-text-muted">
              {VERDICT_LABELS[key].action}
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          {withMargin.length === 0 ? (
            <EmptyState
              icon="ChartNoAxesCombined"
              title="No margin to plot"
              description="Add a cost to your items and every one of them appears here."
            />
          ) : (
            <QuadrantChart
              title="Volume against margin"
              caption="Each dot is one item. Where it sits is the decision: the top left earns well and nobody buys it."
              xLabel="Share of revenue"
              yLabel="Margin rate"
              quadrants={['Push these', 'Protect these', 'Reprice these', 'Consider dropping']}
              groups={[{ label: 'Above median margin' }, { label: 'Below median margin' }]}
              points={withMargin.map((row) => ({
                key: row.itemId,
                label: row.name,
                x: place(row.revenueShare, thresholds.revenueShare),
                y: place(row.marginRate as number, thresholds.medianMarginRate ?? 0),
                group: row.verdict === 'star' || row.verdict === 'hidden_gem' ? 0 : 1,
                detail: (
                  <ul className="mt-1 flex flex-col gap-0.5 text-text-muted">
                    <li className="tnum">{row.units} sold</li>
                    <li className="tnum">
                      <MoneyText value={money(row.grossMinor, currency)} /> revenue
                    </li>
                    <li className="tnum">{((row.marginRate as number) * 100).toFixed(0)}% margin</li>
                  </ul>
                ),
              }))}
            />
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="What carries the business"
              description="The few items that make most of the revenue."
            />
            <RankBars
              className="mt-4"
              rows={analysis.rows
                .filter((row) => row.abc === 'A')
                .slice(0, 6)
                .map((row) => ({
                  key: row.itemId,
                  label: row.name,
                  value: row.grossMinor,
                  display: <MoneyText value={money(row.grossMinor, currency)} display="none" />,
                  meta: `${(row.revenueShare * 100).toFixed(0)}%`,
                }))}
            />
            <p className="mt-4 flex items-start gap-2 text-sm text-text-muted">
              <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
              {analysis.rows.filter((row) => row.abc === 'A').length} of {analysis.rows.length}{' '}
              {terms.t('catalog_item', { plural: true, case: 'lower' })} make the first 80% of your
              revenue. Running out of one of these costs more than running out of anything else.
            </p>
          </Card>

          <Card>
            <CardHeader
              title="Bought together"
              description="Pairs that appear together more often than chance would produce."
            />
            {analysis.pairs.length === 0 ? (
              <p className="mt-4 text-base text-text-subtle">
                Not enough multi-line sales in this period to find a pattern.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {analysis.pairs.slice(0, 6).map((pair) => (
                  <li key={`${pair.a}-${pair.b}`} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-text">
                        {pair.aName} <span className="text-text-subtle">with</span> {pair.bName}
                      </p>
                      <p className="tnum text-sm text-text-subtle">
                        {pair.together} times · {Math.round(pair.confidence * 100)}% of{' '}
                        {pair.aName} baskets
                      </p>
                    </div>
                    <Badge tone={pair.lift >= 1.5 ? 'success' : 'neutral'} className="tnum">
                      {pair.lift.toFixed(1)}x
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card padded={false}>
        <CardHeader
          className="flex-wrap p-5"
          title={`Every ${terms.t('catalog_item', { case: 'lower' })}`}
          description="Sorted by whichever column matters to the decision you are making."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {verdict && (
                <Button size="sm" variant="ghost" iconStart="X" onClick={() => setVerdict('')}>
                  {VERDICT_LABELS[verdict].label} only
                </Button>
              )}
              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                aria-label="Sort by"
                className="w-44"
              >
                <option value="revenue">Most revenue</option>
                <option value="margin">Most margin</option>
                <option value="marginRate">Best margin rate</option>
                <option value="units">Most sold</option>
                <option value="change">Fastest growing</option>
              </Select>
            </div>
          }
        />

        {data.isPending ? (
          <div className="flex flex-col gap-3 p-5 pt-0">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>{terms.t('catalog_item')}</Th>
                  <Th>Verdict</Th>
                  <Th numeric className="hidden sm:table-cell">Sold</Th>
                  <Th numeric className="hidden lg:table-cell">A day</Th>
                  <Th numeric>Revenue</Th>
                  <Th numeric className="hidden md:table-cell">Margin</Th>
                  <Th numeric className="hidden md:table-cell">Rate</Th>
                  <Th numeric>Change</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <Tr key={row.itemId} interactive onClick={() => setOpen(row)}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate font-medium text-text">{row.name}</span>
                        {row.abc === 'A' && (
                          <Badge tone="neutral" className="shrink-0">
                            Top 80%
                          </Badge>
                        )}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={VERDICT_TONE[row.verdict]}>{VERDICT_LABELS[row.verdict].label}</Badge>
                    </Td>
                    <Td numeric className="hidden text-text-muted sm:table-cell">{row.units}</Td>
                    <Td numeric className="hidden text-text-muted lg:table-cell">
                      {row.velocity.toFixed(1)}
                    </Td>
                    <Td numeric className="font-medium">
                      <MoneyText value={money(row.grossMinor, currency)} display="none" />
                    </Td>
                    <Td numeric className="hidden text-text-muted md:table-cell">
                      {row.marginMinor === null ? '—' : compact(row.marginMinor)}
                    </Td>
                    <Td numeric className="hidden md:table-cell">
                      {row.marginRate === null ? (
                        <span className="text-text-subtle">—</span>
                      ) : (
                        <span className={cn(row.marginRate < 0.2 && 'text-warning-text')}>
                          {(row.marginRate * 100).toFixed(0)}%
                        </span>
                      )}
                    </Td>
                    <Td numeric>
                      <Delta value={row.revenueChange} className="justify-end" />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      <ProductDetailDialog
        row={open}
        item={data.items.find((entry) => entry.id === open?.itemId)}
        orders={data.orders}
        days={dayCount(period)}
        onClose={() => setOpen(null)}
        onEdit={() => {
          setEditing(open?.itemId ?? null)
          setOpen(null)
        }}
      />
      <CatalogItemDialog
        item={data.items.find((entry) => entry.id === editing) ?? null}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}
