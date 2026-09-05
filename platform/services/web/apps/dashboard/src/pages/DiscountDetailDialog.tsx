import { useMutation, useQueryClient } from '@tanstack/react-query'
import { discounts, type Discount } from '@twentyfour/api'
import type { DiscountPerformance } from '@twentyfour/analytics'
import { money } from '@twentyfour/money'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, Dialog, Icon, MoneyText, cn, useDateFormat, useFormat, useToast,
  type BadgeTone,
} from '@twentyfour/ui'

const STATUS_TONE: Record<Discount['status'], BadgeTone> = {
  draft: 'neutral', scheduled: 'accent', live: 'success', paused: 'warning', ended: 'neutral',
}

/**
 * One code, and whether it earned its keep.
 *
 * Redemptions first, because that is what people look for, and the return
 * immediately after, because that is what matters. A campaign can be busy and
 * losing at the same time, and the two numbers sitting together is the only
 * way that reads.
 */
export function DiscountDetailDialog({
  discount,
  performance,
  onClose,
  onEdit,
}: {
  discount: Discount | null
  performance: DiscountPerformance | undefined
  onClose: () => void
  onEdit: () => void
}) {
  const toast = useToast()
  const dates = useDateFormat()
  const { currency } = useFormat()
  const queryClient = useQueryClient()
  const mayEdit = usePermission('catalog.edit')

  const setStatus = useMutation({
    mutationFn: (status: Discount['status']) => discounts.update(discount!.id, { status }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title:
          saved.status === 'live'
            ? `${saved.code} is live`
            : saved.status === 'paused'
              ? `${saved.code} paused`
              : `${saved.code} ended`,
        description:
          saved.status === 'paused'
            ? 'It stops working at the till. Anyone holding it will be told it is not available.'
            : undefined,
      })
      onClose()
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That change was refused', description: error.message }),
  })

  const roi = performance?.returnOnDiscount ?? null
  const describeValue = discount
    ? discount.kind === 'percent'
      ? `${discount.value / 100}% off`
      : discount.kind === 'fixed'
        ? 'a fixed amount off'
        : `buy ${discount.value}, one free`
    : ''

  return (
    <Dialog
      open={discount !== null}
      onClose={onClose}
      size="lg"
      title={discount?.code ?? ''}
      description={discount ? `${discount.name} · ${describeValue}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {mayEdit && discount && (
            <>
              <Button variant="outline" iconStart="Pencil" onClick={onEdit}>Edit</Button>
              {discount.status === 'live' ? (
                <Button
                  variant="outline"
                  loading={setStatus.isPending}
                  onClick={() => setStatus.mutate('paused')}
                >
                  Pause
                </Button>
              ) : discount.status === 'paused' || discount.status === 'draft' ? (
                <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('live')}>
                  Make it live
                </Button>
              ) : null}
            </>
          )}
        </>
      }
    >
      {discount && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge dot tone={STATUS_TONE[discount.status]}>{discount.status}</Badge>
            <span className="text-base text-text-muted">
              {dates.date(discount.startsAt)}
              {discount.endsAt ? ` to ${dates.date(discount.endsAt)}` : ' onward'}
            </span>
            {discount.stackable && <Badge tone="warning">Combines with other codes</Badge>}
          </div>

          {performance ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Redeemed" value={String(performance.redemptions)} />
                <Figure
                  label="Given away"
                  value={<MoneyText value={money(performance.costMinor, currency)} deemphasiseSymbol />}
                />
                <Figure
                  label="Revenue on it"
                  value={<MoneyText value={money(performance.revenueMinor, currency)} deemphasiseSymbol />}
                />
                <Figure
                  label="Return"
                  value={roi === null ? 'unknown' : `${roi.toFixed(2)}x`}
                  tone={roi === null ? undefined : roi >= 1 ? 'good' : 'bad'}
                />
              </div>

              {/* The verdict in a sentence, because a merchant should not have
                  to interpret a ratio to know whether to keep running it. */}
              <Card
                className={cn(
                  roi === null
                    ? undefined
                    : roi >= 1
                      ? 'border-success-border bg-success-subtle'
                      : 'border-warning-border bg-warning-subtle',
                )}
              >
                <div className="flex gap-3">
                  <Icon
                    name={roi === null ? 'Info' : roi >= 1 ? 'CheckCircle2' : 'TriangleAlert'}
                    size="lg"
                    className={cn(
                      'mt-0.5 shrink-0',
                      roi === null ? 'text-text-subtle' : roi >= 1 ? 'text-success-text' : 'text-warning-text',
                    )}
                  />
                  <div>
                    <p className="text-base font-medium text-text">
                      {roi === null
                        ? 'There is no cost recorded, so the return cannot be worked out'
                        : roi >= 1
                          ? 'It returned more than it gave away'
                          : 'It gave away more than it brought back'}
                    </p>
                    <p className="mt-1 text-base text-text-muted">
                      {roi === null
                        ? 'Add costs to the items this code touches and this fills in.'
                        : roi >= 1
                          ? 'The margin on these baskets beat what the same baskets would have made undiscounted.'
                          : `It won ${performance.newCustomers} first-time ${performance.newCustomers === 1 ? 'customer' : 'customers'}. That can be worth the margin if they come back, and is worth nothing if they do not.`}
                    </p>
                  </div>
                </div>
              </Card>

              <dl className="flex flex-col divide-y divide-border border-t border-border">
                <Row label="Average basket on it">
                  <MoneyText value={money(performance.averageBasketMinor, currency)} display="none" />
                </Row>
                <Row label="Basket lift">
                  {performance.basketLift === null ? (
                    <span className="text-text-subtle">no comparison</span>
                  ) : (
                    <span className={cn(performance.basketLift > 0 ? 'text-success-text' : 'text-text-muted')}>
                      {performance.basketLift > 0 ? '+' : ''}
                      {Math.round(performance.basketLift * 100)}%
                    </span>
                  )}
                </Row>
                <Row label="First-time customers">{performance.newCustomers}</Row>
                <Row label="First used">
                  {performance.firstUsedAt ? dates.date(performance.firstUsedAt) : '—'}
                </Row>
                <Row label="Last used">
                  {performance.lastUsedAt ? dates.date(performance.lastUsedAt) : '—'}
                </Row>
              </dl>
            </>
          ) : (
            <Card className="bg-surface-sunken">
              <p className="text-base text-text-muted">
                Nobody has used this code yet, so there is nothing to measure.
              </p>
            </Card>
          )}

          <dl className="flex flex-col divide-y divide-border border-t border-border">
            <Row label="Total uses allowed">
              {discount.usageLimit === null ? 'Unlimited' : discount.usageLimit}
            </Row>
            <Row label="Per person">
              {discount.perCustomerLimit === null ? 'Unlimited' : discount.perCustomerLimit}
            </Row>
            <Row label="Minimum basket">
              {discount.minimumBasket ? (
                <MoneyText value={discount.minimumBasket} display="none" />
              ) : (
                <span className="text-warning-text">None</span>
              )}
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
  )
}

function Figure({
  label, value, tone,
}: {
  label: string
  value: React.ReactNode
  tone?: 'good' | 'bad'
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <p className="text-sm font-medium text-text-muted">{label}</p>
      <p
        className={cn(
          'tnum mt-1.5 text-lg font-semibold',
          tone === 'good' ? 'text-success-text' : tone === 'bad' ? 'text-warning-text' : 'text-text',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-base text-text-muted">{label}</dt>
      <dd className="tnum text-base font-medium text-text">{children}</dd>
    </div>
  )
}
