import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { discounts as discountsApi, queryKeys, type Discount } from '@twentyfour/api'
import { DiscountDetailDialog } from './DiscountDetailDialog'
import { DiscountFormDialog } from './DiscountFormDialog'
import { discountPerformance, presetPeriod } from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, MoneyText, PageHeader,
  RankBars, Skeleton, Table, TableScroll, Td, Th, Tr, cn, useDateFormat, useFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import { useTradeData } from '../analytics/useTradeData'

const STATUS_TONE: Record<Discount['status'], BadgeTone> = {
  draft: 'neutral',
  scheduled: 'accent',
  live: 'success',
  paused: 'warning',
  ended: 'neutral',
}

function describeValue(discount: Discount, currency: string) {
  switch (discount.kind) {
    case 'percent':
      return `${discount.value / 100}% off`
    case 'fixed':
      return <MoneyText value={money(discount.value, currency)} display="none" />
    case 'free_item':
      return `Buy ${discount.value}, one free`
  }
}

/**
 * Coupons and discounts.
 *
 * The figure that matters is not how many were redeemed, it is what the
 * business kept afterwards. A code with a thousand redemptions that moved
 * nothing except margin from you to people who would have bought anyway is a
 * success by every vanity measure and a loss by the only real one.
 */
export function DiscountsPage() {
  const dates = useDateFormat()
  const { currency } = useFormat()
  const mayEdit = usePermission('catalog.edit')
  const period = useMemo(() => presetPeriod('90d'), [])
  const data = useTradeData(period)
  const [selected, setSelected] = useState<Discount | null>(null)
  const [editing, setEditing] = useState<Discount | null>(null)
  const [creating, setCreating] = useState(false)

  const list = useQuery({ queryKey: queryKeys.discounts.list(), queryFn: discountsApi.list })

  const performance = useMemo(() => {
    const firstOrder = new Map<string, string>()
    for (const order of [...data.orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt))) {
      if (order.customerId && !firstOrder.has(order.customerId)) {
        firstOrder.set(order.customerId, order.placedAt)
      }
    }
    const rows = discountPerformance(data.orders, { firstOrderByCustomer: firstOrder })
    return new Map(rows.map((row) => [row.code, row]))
  }, [data.orders])

  const totals = useMemo(() => {
    const rows = [...performance.values()]
    return {
      given: rows.reduce((sum, row) => sum + row.costMinor, 0),
      influenced: rows.reduce((sum, row) => sum + row.revenueMinor, 0),
      redemptions: rows.reduce((sum, row) => sum + row.redemptions, 0),
      newCustomers: rows.reduce((sum, row) => sum + row.newCustomers, 0),
    }
  }, [performance])

  if (list.isError || data.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Coupons and discounts" />
        <ErrorState onRetry={() => { void list.refetch(); data.refetch() }} />
      </div>
    )
  }

  const codes = list.data ?? []
  const losing = codes.filter((code) => {
    const row = performance.get(code.code)
    return row && row.returnOnDiscount !== null && row.returnOnDiscount < 1 && row.redemptions > 5
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Coupons and discounts"
        description="What each code cost, what it brought in, and whether it was worth running."
        actions={mayEdit && <Button iconStart="Plus" onClick={() => setCreating(true)}>New code</Button>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Given away" value={<MoneyText value={money(totals.given, currency)} deemphasiseSymbol />} hint="Across 90 days" loading={data.isPending} />
        <Tile label="Revenue on codes" value={<MoneyText value={money(totals.influenced, currency)} deemphasiseSymbol />} hint="Baskets that used one" loading={data.isPending} />
        <Tile label="Redemptions" value={String(totals.redemptions)} loading={data.isPending} />
        <Tile
          label="New customers won"
          value={String(totals.newCustomers)}
          hint="First-ever purchase used a code"
          loading={data.isPending}
        />
      </div>

      {/* The uncomfortable finding, said plainly. A dashboard that only
          reports redemptions lets a losing campaign look like a win. */}
      {losing.length > 0 && (
        <Card className="border-warning-border bg-warning-subtle">
          <div className="flex gap-3">
            <Icon name="TriangleAlert" size="lg" className="mt-0.5 shrink-0 text-warning-text" />
            <div>
              <p className="text-base font-medium text-text">
                {losing.length === 1 ? 'One code is' : `${losing.length} codes are`} giving away more
                than they bring back
              </p>
              <p className="mt-1 text-base text-text-muted">
                {losing.map((code) => code.code).join(', ')} returned less margin than the same
                baskets would have made undiscounted. That can still be the right call if it wins
                people who then come back, so check the new customers column before you pull them.
              </p>
            </div>
          </div>
        </Card>
      )}

      {list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}
          </div>
        </Card>
      ) : codes.length === 0 ? (
        <EmptyState
          icon="Percent"
          title="No codes yet"
          description="A code is the cheapest way to find out what actually moves people."
          action={mayEdit && <Button onClick={() => setCreating(true)}>Create the first one</Button>}
        />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Status</Th>
                  <Th numeric className="hidden sm:table-cell">Used</Th>
                  <Th numeric className="hidden lg:table-cell">Given away</Th>
                  <Th numeric className="hidden md:table-cell">Basket lift</Th>
                  <Th numeric>Return</Th>
                  <Th className="hidden xl:table-cell">Runs</Th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => {
                  const row = performance.get(code.code)
                  const roi = row?.returnOnDiscount ?? null
                  return (
                    <Tr
                      key={code.id}
                      interactive
                      onClick={() => setSelected(code)}
                    >
                      <Td>
                        <span className="block font-mono text-sm font-medium text-text">{code.code}</span>
                        <span className="block truncate text-sm text-text-subtle">
                          {code.name} · {describeValue(code, currency)}
                        </span>
                      </Td>
                      <Td>
                        <Badge dot tone={STATUS_TONE[code.status]}>{code.status}</Badge>
                      </Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        {code.redemptions}
                        {code.usageLimit !== null && (
                          <span className="block text-sm text-text-subtle">of {code.usageLimit}</span>
                        )}
                      </Td>
                      <Td numeric className="hidden text-text-muted lg:table-cell">
                        {row ? <MoneyText value={money(row.costMinor, currency)} display="none" /> : '—'}
                      </Td>
                      <Td numeric className="hidden md:table-cell">
                        {row?.basketLift == null ? (
                          <span className="text-text-subtle">—</span>
                        ) : (
                          <span className={cn(row.basketLift > 0 ? 'text-success-text' : 'text-text-muted')}>
                            {row.basketLift > 0 ? '+' : ''}
                            {Math.round(row.basketLift * 100)}%
                          </span>
                        )}
                      </Td>
                      <Td numeric>
                        {roi === null ? (
                          <span className="text-sm text-text-subtle">no cost data</span>
                        ) : (
                          <Badge tone={roi >= 1 ? 'success' : 'warning'} className="tnum">
                            {roi.toFixed(2)}x
                          </Badge>
                        )}
                      </Td>
                      <Td className="hidden whitespace-nowrap text-sm text-text-muted xl:table-cell">
                        {dates.date(code.startsAt)}
                        {code.endsAt ? ` to ${dates.date(code.endsAt)}` : ' onward'}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </TableScroll>
          <p className="flex items-start gap-2 border-t border-border p-4 text-sm text-text-muted">
            <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
            Return compares the margin those baskets actually kept against what the same baskets
            would have kept at your undiscounted margin rate. Above one, the code paid for itself
            in the period. Below one, it bought something else: new customers, a quiet afternoon
            filled, or nothing at all.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Most redeemed" description="By number of baskets that used it." />
          <RankBars
            className="mt-4"
            emptyLabel="No redemptions in this period"
            rows={[...performance.values()]
              .sort((a, b) => b.redemptions - a.redemptions)
              .slice(0, 5)
              .map((row) => ({
                key: row.code,
                label: row.code,
                value: row.redemptions,
                display: String(row.redemptions),
                meta: row.newCustomers > 0 ? `${row.newCustomers} new` : undefined,
              }))}
          />
        </Card>

        <Card>
          <CardHeader title="Biggest basket lift" description="How much more people spend when they use it." />
          <RankBars
            className="mt-4"
            emptyLabel="Not enough data to compare"
            rows={[...performance.values()]
              .filter((row) => row.basketLift !== null)
              .sort((a, b) => (b.basketLift as number) - (a.basketLift as number))
              .slice(0, 5)
              .map((row) => ({
                key: row.code,
                label: row.code,
                value: Math.max(0, (row.basketLift as number) * 100),
                display: `${(row.basketLift as number) > 0 ? '+' : ''}${Math.round((row.basketLift as number) * 100)}%`,
                tone: (row.basketLift as number) > 0 ? 'good' : 'warning',
              }))}
          />
        </Card>
      </div>

      <DiscountDetailDialog
        discount={selected}
        performance={selected ? performance.get(selected.code) : undefined}
        onClose={() => setSelected(null)}
        onEdit={() => {
          setEditing(selected)
          setSelected(null)
        }}
      />
      <DiscountFormDialog
        discount={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
      <DiscountFormDialog discount={null} open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function Tile({ label, value, hint, loading }: { label: string; value: React.ReactNode; hint?: string; loading: boolean }) {
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
