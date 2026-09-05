import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, payments, type Payment } from '@twentyfour/api'
import { serialiseMoney, subtractMoney } from '@twentyfour/money'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, Dialog, Icon, MoneyText, cn, useDateFormat, useToast, type BadgeTone,
} from '@twentyfour/ui'

const TONE: Record<Payment['status'], BadgeTone> = {
  pending: 'warning',
  authorised: 'accent',
  captured: 'success',
  refunded: 'neutral',
  failed: 'danger',
}

/**
 * One payment, with what happened to it and when.
 *
 * The timeline is the point. A payment is not a row, it is a sequence:
 * authorised, captured, sometimes refunded, occasionally failed in between.
 * Which stage it reached is the difference between money you have and money
 * you were promised.
 */
export function PaymentDetailDialog({
  payment,
  onClose,
  onOpenOrder,
}: {
  payment: Payment | null
  onClose: () => void
  onOpenOrder: (orderId: string) => void
}) {
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const mayRefund = usePermission('payments.refund')
  const [confirming, setConfirming] = useState(false)

  const refund = useMutation({
    mutationFn: () =>
      payments.refund(payment!.id, {
        amount: serialiseMoney(subtractMoney(payment!.amount, payment!.refunded)),
        reason: 'Refunded from the dashboard',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: 'Refund sent',
        description: 'A correcting document has been issued. The original is unchanged.',
      })
      setConfirming(false)
      onClose()
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'That refund was refused',
        description: error instanceof HttpError ? error.message : undefined,
      }),
  })

  const outstanding = payment ? payment.amount.minor - payment.refunded.minor : 0
  const refundable = payment?.status === 'captured' && outstanding > 0

  // Which stages this payment actually reached. A stage it never reached is
  // shown as not reached rather than omitted, because "never captured" is the
  // most important thing a failed payment has to say.
  const stages = payment
    ? [
        { key: 'created', label: 'Created', reached: true, at: payment.createdAt },
        {
          key: 'authorised',
          label: 'Authorised',
          reached: payment.status !== 'pending' && payment.status !== 'failed',
          at: null,
        },
        {
          key: 'captured',
          label: 'Captured',
          reached: payment.status === 'captured' || payment.status === 'refunded',
          at: null,
        },
        {
          key: 'refunded',
          label: payment.refunded.minor > 0 ? 'Refunded' : 'Not refunded',
          reached: payment.refunded.minor > 0,
          at: null,
        },
      ]
    : []

  return (
    <Dialog
      open={payment !== null}
      onClose={onClose}
      title="Payment"
      description={payment ? dates.dateTime(payment.createdAt) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {payment?.orderId && (
            <Button variant="outline" iconEnd="ArrowRight" onClick={() => onOpenOrder(payment.orderId as string)}>
              The sale
            </Button>
          )}
          {refundable && mayRefund && (
            <Button variant="danger" onClick={() => setConfirming(true)}>Refund</Button>
          )}
        </>
      }
    >
      {payment && (
        <div className="flex flex-col gap-5">
          {confirming && (
            <Card className="border-danger-border bg-danger-subtle">
              <p className="text-base font-medium text-text">Refund the outstanding amount?</p>
              <p className="mt-1 text-base text-text-muted">
                A credit note is issued referencing the original document, which stays exactly as
                it was issued. The provider decides when the money actually lands.
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button variant="danger" size="sm" loading={refund.isPending} onClick={() => refund.mutate()}>
                  Refund
                </Button>
              </div>
            </Card>
          )}

          <div className="rounded-xl bg-surface-sunken p-4 text-center">
            <p className="text-sm font-medium text-text-muted">Amount</p>
            <p className="mt-1 text-3xl font-semibold tracking-[-0.03em] text-text">
              <MoneyText value={payment.amount} deemphasiseSymbol />
            </p>
            {payment.refunded.minor > 0 && (
              <p className="mt-1 text-base text-text-muted">
                <MoneyText value={payment.refunded} display="none" /> refunded
              </p>
            )}
          </div>

          <ol className="flex flex-col">
            {stages.map((stage, index) => (
              <li key={stage.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-full',
                      stage.reached ? 'bg-success-subtle text-success-text' : 'bg-surface-sunken text-text-subtle',
                    )}
                  >
                    <Icon name={stage.reached ? 'Check' : 'Minus'} size="sm" />
                  </span>
                  {index < stages.length - 1 && (
                    <span className={cn('w-px flex-1', stage.reached ? 'bg-success-border' : 'bg-border')} />
                  )}
                </div>
                <div className="pb-4">
                  <p className={cn('text-base', stage.reached ? 'font-medium text-text' : 'text-text-subtle')}>
                    {stage.label}
                  </p>
                  {stage.at && <p className="text-sm text-text-subtle">{dates.dateTime(stage.at)}</p>}
                </div>
              </li>
            ))}
          </ol>

          <dl className="flex flex-col divide-y divide-border border-t border-border">
            <Row label="Status">
              <Badge dot tone={TONE[payment.status]}>{payment.status}</Badge>
            </Row>
            <Row label="Method"><span className="capitalize">{payment.method}</span></Row>
            <Row label="Provider reference">
              {/* Whatever this market's provider returned. Never parsed for
                  meaning: the format is theirs and it changes. */}
              <span className="font-mono text-sm">{payment.providerReference ?? '—'}</span>
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
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
