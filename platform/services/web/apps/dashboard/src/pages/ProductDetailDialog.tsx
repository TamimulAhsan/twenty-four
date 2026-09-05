import { useMemo } from 'react'
import { basketAffinity, VERDICT_LABELS, type AnalysedOrder, type ProductPerformance } from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, Dialog, Icon, MoneyText, RankBars, Sparkline, cn, useFormat,
  type BadgeTone,
} from '@twentyfour/ui'
import type { CatalogItem } from '@twentyfour/api'

const VERDICT_TONE: Record<ProductPerformance['verdict'], BadgeTone> = {
  star: 'success', traffic_driver: 'accent', hidden_gem: 'warning', drag: 'neutral', dormant: 'danger',
}

/**
 * One thing you sell, and what to do about it.
 *
 * The verdict and its action come first, then the figures that produced them.
 * A merchant opening this row already knows the number; what they want is
 * whether to push it, reprice it or drop it.
 */
export function ProductDetailDialog({
  row,
  item,
  orders,
  days,
  onClose,
  onEdit,
}: {
  row: ProductPerformance | null
  item: CatalogItem | undefined
  orders: readonly AnalysedOrder[]
  days: number
  onClose: () => void
  onEdit: () => void
}) {
  const terms = useTerms()
  const { currency } = useFormat()
  const mayEdit = usePermission('catalog.edit')

  const detail = useMemo(() => {
    if (!row) return null

    // Sales of this item only, bucketed by day, so the sparkline shows its own
    // rhythm rather than the shop's.
    const byDay = new Map<string, number>()
    const buyers = new Map<string, number>()
    for (const order of orders) {
      const lines = order.lines.filter((line) => line.itemId === row.itemId)
      if (lines.length === 0) continue
      const day = order.placedAt.slice(0, 10)
      const gross = lines.reduce((sum, line) => sum + line.grossMinor, 0)
      byDay.set(day, (byDay.get(day) ?? 0) + gross)
      if (order.customerId) {
        buyers.set(order.customerId, (buyers.get(order.customerId) ?? 0) + gross)
      }
    }

    const withIt = orders.filter((order) => order.lines.some((line) => line.itemId === row.itemId))
    const pairs = basketAffinity(withIt, { minimumTogether: 2, limit: 5 }).filter(
      (pair) => pair.a === row.itemId || pair.b === row.itemId,
    )

    return {
      trend: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, value]) => value),
      buyerCount: buyers.size,
      // How much of its revenue comes from named customers rather than
      // walk-ins. A line carried by a handful of regulars is a different risk
      // from one carried by passing trade.
      namedShare:
        row.grossMinor === 0
          ? 0
          : [...buyers.values()].reduce((sum, value) => sum + value, 0) / row.grossMinor,
      pairs: pairs.map((pair) => ({
        ...pair,
        otherName: pair.a === row.itemId ? pair.bName : pair.aName,
      })),
    }
  }, [row, orders])

  const verdict = row ? VERDICT_LABELS[row.verdict] : null

  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      size="lg"
      title={row?.name ?? ''}
      description={item ? `${item.sku} · ${item.kind}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {mayEdit && item && (
            <Button variant="outline" iconStart="Pencil" onClick={onEdit}>
              Edit {terms.t('catalog_item', { case: 'lower' })}
            </Button>
          )}
        </>
      }
    >
      {row && verdict && detail && (
        <div className="flex flex-col gap-5">
          <Card
            className={cn(
              row.verdict === 'star' && 'border-success-border bg-success-subtle',
              row.verdict === 'hidden_gem' && 'border-warning-border bg-warning-subtle',
              row.verdict === 'dormant' && 'border-danger-border bg-danger-subtle',
            )}
          >
            <div className="flex gap-3">
              <Icon name="ArrowRight" size="lg" className="mt-0.5 shrink-0 text-text-muted" />
              <div>
                <p className="flex flex-wrap items-center gap-2 text-base font-medium text-text">
                  <Badge tone={VERDICT_TONE[row.verdict]}>{verdict.label}</Badge>
                  {row.abc === 'A' && <Badge tone="neutral">In the top 80% of revenue</Badge>}
                </p>
                <p className="mt-1 text-base text-text-muted">{verdict.action}</p>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Revenue" value={<MoneyText value={money(row.grossMinor, currency)} deemphasiseSymbol />} />
            <Figure
              label="Margin"
              value={
                row.marginMinor === null
                  ? 'not recorded'
                  : <MoneyText value={money(row.marginMinor, currency)} deemphasiseSymbol />
              }
              hint={row.marginRate === null ? undefined : `${(row.marginRate * 100).toFixed(0)}% of net`}
              tone={row.marginRate !== null && row.marginRate < 0.2 ? 'warn' : undefined}
            />
            <Figure label="Sold" value={String(row.units)} hint={`${row.velocity.toFixed(1)} a day`} />
            <Figure
              label="Share of revenue"
              value={`${(row.revenueShare * 100).toFixed(1)}%`}
              hint={`across ${days} days`}
            />
          </div>

          {detail.trend.length > 1 && (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4">
              <div>
                <p className="text-sm font-medium text-text">How it has sold</p>
                <p className="text-sm text-text-subtle">
                  Every day it sold something, over the period.
                </p>
              </div>
              <Sparkline values={detail.trend} width={160} height={36} />
            </div>
          )}

          <dl className="flex flex-col divide-y divide-border border-t border-border">
            <Row label="Appeared in">{row.orderCount} baskets</Row>
            <Row label="Bought by">
              {detail.buyerCount === 0
                ? 'Nobody named'
                : `${detail.buyerCount} known ${detail.buyerCount === 1 ? terms.t('customer', { case: 'lower' }) : terms.t('customer', { plural: true, case: 'lower' })}`}
              {detail.namedShare > 0 && (
                <span className="ml-1.5 text-sm text-text-subtle">
                  {Math.round(detail.namedShare * 100)}% of its revenue
                </span>
              )}
            </Row>
            {item?.trackStock && <Row label="Stock tracked">Yes</Row>}
            {item && (
              <Row label="Price">
                <MoneyText value={item.unitPrice} />
                <span className="ml-1.5 text-sm text-text-subtle">
                  {item.taxIncluded ? 'tax included' : 'plus tax'}
                </span>
              </Row>
            )}
            {item?.costPrice && (
              <Row label="Costs you"><MoneyText value={item.costPrice} display="none" /></Row>
            )}
          </dl>

          {detail.pairs.length > 0 && (
            <div>
              <p className="text-sm font-medium text-text">Usually bought with</p>
              <RankBars
                className="mt-3"
                rows={detail.pairs.map((pair) => ({
                  key: pair.otherName,
                  label: pair.otherName,
                  value: pair.together,
                  display: `${pair.together}`,
                  meta: `${pair.lift.toFixed(1)}x`,
                }))}
              />
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

function Figure({
  label, value, hint, tone,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'warn'
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-3.5', tone === 'warn' && 'border-warning-border')}>
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <p className="tnum mt-1.5 text-lg font-semibold text-text">{value}</p>
      {hint && <p className="mt-0.5 text-sm text-text-subtle">{hint}</p>}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-base text-text-muted">{label}</dt>
      <dd className="text-base font-medium text-text">{children}</dd>
    </div>
  )
}
