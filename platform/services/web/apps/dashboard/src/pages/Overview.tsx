import { useMemo, type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { inventory, orders, queryKeys } from '@twentyfour/api'
import {
  change,
  customerMetrics,
  dayCount,
  discountPerformance,
  financialSummary,
  presetPeriod,
  productPerformance,
  revenueByDay,
  SEGMENTS,
} from '@twentyfour/analytics'
import { launchableApps, useEntitlement } from '@twentyfour/entitlement'
import { useTerms } from '@twentyfour/terms'
import { launchTargets } from '@twentyfour/runtime'
import {
  Button, Card, CardHeader, ErrorState, Icon, MoneyText, PageHeader,
  Skeleton, Sparkline, Table, TableScroll, Td, Th, Tr, cn, isIconName, useDateFormat, useFormat,
  type IconName,
} from '@twentyfour/ui'
import { money } from '@twentyfour/money'
import { OrderDetailDialog } from '../components/OrderDetailDialog'
import { useTradeData } from '../analytics/useTradeData'
import { Delta } from '../analytics/Delta'

const today = () => new Date().toISOString().slice(0, 10)

export function Overview() {
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const terms = useTerms()
  const dates = useDateFormat()
  const { currency, locale } = useFormat()
  const entitlement = useEntitlement()
  const period = useMemo(() => presetPeriod('30d'), [])
  const data = useTradeData(period)

  const takings = useQuery({
    queryKey: queryKeys.orders.takings(today()),
    queryFn: () => orders.takings(today()),
    enabled: entitlement.has('pos_orders'),
  })

  const stock = useQuery({
    queryKey: queryKeys.inventory.levels(),
    queryFn: inventory.levels,
    enabled: entitlement.has('inventory'),
  })

  const analysis = useMemo(() => {
    const now = financialSummary(data.orders)
    const before = financialSummary(data.previousOrders)
    const series = revenueByDay(data.orders, period)
    const metrics = customerMetrics({ orders: data.orders })
    const products = productPerformance({
      orders: data.orders,
      previousOrders: data.previousOrders,
      days: dayCount(period),
      catalog: data.items.map((item) => ({ id: item.id, name: item.name, categoryId: item.categoryId })),
    })
    return {
      now,
      before,
      series,
      metrics,
      products,
      discounts: discountPerformance(data.orders),
    }
  }, [data.orders, data.previousOrders, data.items, period])

  const zero = money(0, currency)
  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description={dates.dateLong(new Date())} />

      <AppLaunchers />

      {takings.isError ? (
        <ErrorState
          description="The day's figures did not load. Nothing has been lost, and the till is unaffected."
          onRetry={() => void takings.refetch()}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label="Taken today"
            value={<MoneyText value={takings.data?.gross ?? zero} deemphasiseSymbol />}
            hint={`${takings.data?.orderCount ?? 0} ${terms.t('order', { plural: true, case: 'lower' })}`}
            loading={takings.isPending}
          />
          <Tile
            label="Last 30 days"
            value={<MoneyText value={money(analysis.now.grossMinor, currency)} deemphasiseSymbol />}
            delta={change(analysis.now.grossMinor, analysis.before.grossMinor)}
            spark={analysis.series.map((point) => point.grossMinor)}
            loading={data.isPending}
          />
          <Tile
            label="Gross margin"
            value={
              analysis.now.marginRate === null
                ? 'not recorded'
                : `${(analysis.now.marginRate * 100).toFixed(1)}%`
            }
            delta={change(analysis.now.marginMinor ?? 0, analysis.before.marginMinor ?? 0)}
            hint="Of net revenue, last 30 days"
            loading={data.isPending}
          />
          <Tile
            label="Average basket"
            value={<MoneyText value={money(analysis.now.averageBasketMinor, currency)} deemphasiseSymbol />}
            delta={change(analysis.now.averageBasketMinor, analysis.before.averageBasketMinor)}
            loading={data.isPending}
          />
        </div>
      )}

      {!data.isPending && (
        <WorthDoing
          analysis={analysis}
          lowStock={(stock.data ?? []).filter(
            (row) => row.lowStockThreshold !== null && row.onHand <= row.lowStockThreshold,
          )}
        />
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card padded={false}>
          <CardHeader
            className="p-5"
            title={`Recent ${terms.t('order', { plural: true, case: 'lower' })}`}
            description="Everything registered today, newest first."
          />
          {data.isPending ? (
            <div className="flex flex-col gap-3 p-5 pt-0">
              {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
            </div>
          ) : (
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Time</Th>
                    <Th className="hidden lg:table-cell">{terms.t('customer')}</Th>
                    <Th className="hidden sm:table-cell">{terms.t('order_line', { plural: true })}</Th>
                    <Th numeric>Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rawOrders
                    .filter((order) => order.placedAt.slice(0, 10) === today())
                    .slice(0, 8)
                    .map((order) => (
                      <Tr key={order.id} interactive onClick={() => setOpenOrder(order.id)}>
                        <Td className="font-mono text-sm">{order.number}</Td>
                        <Td className="text-text-muted">{dates.time(order.placedAt)}</Td>
                        <Td className="hidden max-w-40 truncate lg:table-cell">
                          {order.customerName ?? <span className="text-text-subtle">Walk-in</span>}
                        </Td>
                        <Td className="hidden text-text-muted sm:table-cell">{order.lines.length}</Td>
                        <Td numeric className="font-medium">
                          <MoneyText value={order.gross} />
                        </Td>
                      </Tr>
                    ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Card>

        <Card padded={false}>
          <CardHeader
            className="p-5"
            title="Carrying the business"
            description={`The ${terms.t('catalog_item', { plural: true, case: 'lower' })} making most of your revenue.`}
          />
          <div className="px-5 pb-5">
            {data.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {analysis.products.slice(0, 6).map((row) => (
                  <li key={row.itemId} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-text">{row.name}</p>
                      <p className="tnum text-sm text-text-subtle">
                        {row.units} sold · {(row.revenueShare * 100).toFixed(0)}% of revenue
                      </p>
                    </div>
                    <span className="tnum shrink-0 text-base font-medium text-text">
                      {compact(row.grossMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
      <OrderDetailDialog orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  )
}

interface ActionItem {
  readonly id: string
  readonly icon: IconName
  readonly tone: 'good' | 'warn' | 'bad'
  readonly title: string
  readonly detail: ReactNode
  readonly to: string
  readonly cta: string
}

/**
 * What is worth doing something about, this week.
 *
 * The point of the whole hub. Every other screen answers a question; this one
 * decides which question to ask. Each entry names a figure, says what it
 * means, and goes somewhere the merchant can act.
 *
 * Nothing appears here unless it clears a threshold. A permanent list of
 * five things is a list nobody reads.
 */
function WorthDoing({
  analysis,
  lowStock,
}: {
  analysis: {
    now: ReturnType<typeof financialSummary>
    metrics: ReturnType<typeof customerMetrics>
    products: ReturnType<typeof productPerformance>
    discounts: ReturnType<typeof discountPerformance>
  }
  lowStock: ReadonlyArray<{ itemId: string; itemName: string; onHand: number }>
}) {
  const navigate = useNavigate()
  const terms = useTerms()
  const entitlement = useEntitlement()
  const { currency } = useFormat()

  // Amounts go through the same formatter as every other figure in the
  // product. A bare Intl call here renders 118,900 next to 118 900 Ft
  // everywhere else, and a merchant is right to distrust both.
  const amount = (minor: number) => <MoneyText value={money(minor, currency)} />

  const items: ActionItem[] = []

  const atRisk = analysis.metrics.filter(
    (entry) => entry.segment === 'at_risk' || entry.segment === 'cannot_lose',
  )
  if (atRisk.length > 0 && entitlement.has('advanced_analytics')) {
    const value = atRisk.reduce((sum, entry) => sum + entry.lifetimeMinor, 0)
    items.push({
      id: 'at-risk',
      icon: 'Users',
      tone: 'bad',
      title: `${atRisk.length} good ${terms.t('customer', { plural: true, case: 'lower' })} have stopped coming`,
      detail: (
        <>
          They are worth {amount(value)} between them, and every one of them broke their own
          pattern. {SEGMENTS.cannot_lose.action}
        </>
      ),
      to: '/customers',
      cta: 'See who',
    })
  }

  const bleeding = analysis.discounts.filter(
    (row) => row.returnOnDiscount !== null && row.returnOnDiscount < 0.95 && row.redemptions > 5,
  )
  if (bleeding.length > 0) {
    const cost = bleeding.reduce((sum, row) => sum + row.costMinor, 0)
    items.push({
      id: 'discounts',
      icon: 'Percent',
      tone: 'warn',
      title: `${bleeding.length === 1 ? 'A code is' : `${bleeding.length} codes are`} giving away more than they bring back`,
      detail: (
        <>
          {bleeding.map((row) => row.code).join(', ')} cost {amount(cost)} and returned less margin
          than the same baskets would have made undiscounted.
        </>
      ),
      to: '/discounts',
      cta: 'Check them',
    })
  }

  const gems = analysis.products.filter((row) => row.verdict === 'hidden_gem')
  if (gems.length > 0 && entitlement.has('advanced_analytics')) {
    items.push({
      id: 'gems',
      icon: 'Sparkles',
      tone: 'good',
      title: `${gems.length} ${gems.length === 1 ? 'thing earns' : 'things earn'} well and nobody buys ${gems.length === 1 ? 'it' : 'them'}`,
      detail: `${gems.slice(0, 3).map((row) => row.name).join(', ')} keep more of each sale than most of your range. Moving them up the list is the cheapest margin you will find.`,
      to: '/products',
      cta: 'See which',
    })
  }

  if (lowStock.length > 0) {
    const out = lowStock.filter((row) => row.onHand <= 0)
    const low = lowStock.filter((row) => row.onHand > 0)
    items.push({
      id: 'stock',
      icon: 'Boxes',
      tone: out.length > 0 ? 'bad' : 'warn',
      title:
        out.length > 0
          ? `${out.length} ${out.length === 1 ? 'line is' : 'lines are'} out of stock`
          : `${low.length} ${low.length === 1 ? 'line is' : 'lines are'} running low`,
      detail: (
        <>
          {out.length > 0 && (
            <>
              Nothing left of {out.map((row) => row.itemName).join(', ')}.
              {low.length > 0 && ' '}
            </>
          )}
          {low.length > 0 && (
            <>
              Running low on{' '}
              {low.slice(0, 4).map((row) => `${row.itemName} (${row.onHand})`).join(', ')}
              {low.length > 4 ? ` and ${low.length - 4} more.` : '.'}
            </>
          )}
        </>
      ),
      to: '/inventory',
      cta: 'Reorder',
    })
  }

  if (items.length === 0) return null

  return (
    <section>
      <CardHeader
        title="Worth doing something about"
        description="Drawn from the last 30 days. Nothing appears here unless it is worth your time."
      />
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.slice(0, 4).map((item) => (
          <Card
            key={item.id}
            className={cn(
              'flex flex-col',
              item.tone === 'bad' && 'border-danger-border',
              item.tone === 'warn' && 'border-warning-border',
              item.tone === 'good' && 'border-success-border',
            )}
          >
            <div className="flex gap-3">
              <span
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  item.tone === 'bad' && 'bg-danger-subtle text-danger-text',
                  item.tone === 'warn' && 'bg-warning-subtle text-warning-text',
                  item.tone === 'good' && 'bg-success-subtle text-success-text',
                )}
              >
                <Icon name={item.icon} size="lg" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-text">{item.title}</p>
                <p className="mt-1 text-base text-text-muted">{item.detail}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 self-start"
              iconEnd="ArrowRight"
              onClick={() => navigate(item.to)}
            >
              {item.cta}
            </Button>
          </Card>
        ))}
      </div>
    </section>
  )
}

function Tile({
  label, value, hint, delta, spark, loading,
}: {
  label: string
  value: ReactNode
  hint?: string
  delta?: number | null
  spark?: readonly number[]
  loading: boolean
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-text-muted">{label}</p>
        {spark && !loading && <Sparkline values={spark} />}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-text">
        {loading ? <Skeleton className="h-8 w-28" /> : <span className="tnum">{value}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2">
        {!loading && delta !== undefined && <Delta value={delta} />}
        {hint && <span className="text-sm text-text-subtle">{hint}</span>}
      </div>
    </Card>
  )
}

function AppLaunchers() {
  const { record } = useEntitlement()
  const apps = launchableApps(record, launchTargets(import.meta.env)).filter((app) => app.id !== 'crm')
  if (apps.length === 0) return null

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {apps.map((app) => (
        <a
          key={app.id}
          href={app.launch}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'group flex items-center gap-4 rounded-xl border border-border bg-surface p-4 sm:p-5',
            'transition-[border-color,background-color,transform] duration-[var(--duration-fast)]',
            'hover:border-accent-border hover:bg-accent-subtle active:scale-[0.995]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          )}
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-surface-inverse text-text-inverse">
            <Icon name={isIconName(app.icon) ? app.icon : 'CircleDot'} size="lg" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-md font-semibold text-text">
                {app.fullName ?? (app.label.kind === 'static' ? app.label.text : app.id)}
              </span>
              <Icon
                name="ArrowUpRight"
                size="sm"
                className="shrink-0 text-text-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              />
            </span>
            {app.summary && (
              <span className="mt-0.5 block truncate text-base text-text-muted">{app.summary}</span>
            )}
          </span>
        </a>
      ))}
    </div>
  )
}
