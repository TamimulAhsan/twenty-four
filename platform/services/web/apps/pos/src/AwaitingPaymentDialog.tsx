import type { PaymentPending } from '@twentyfour/api'
import { Button, Dialog, Icon, MoneyText, Spinner } from '@twentyfour/ui'

const METHOD_LABEL: Record<string, string> = {
  card: 'card',
  wallet: 'wallet',
  cash: 'cash',
}

/**
 * What the cashier looks at while the customer pays.
 *
 * The sale is not placed yet and no receipt exists, so this says so plainly.
 * The one thing it must never do is look finished: a cashier who reads this as
 * a completed sale hands over the goods for money nobody took.
 *
 * The link is here as well as in the tab that opened, because the browser is
 * allowed to refuse a popup and the sale cannot depend on one.
 */
export function AwaitingPaymentDialog({
  pending,
  blocked,
  onCancel,
}: {
  pending: PaymentPending | null
  /** The browser would not open the page, so this is the only way to it. */
  blocked: boolean
  onCancel: () => void
}) {
  const method = METHOD_LABEL[pending?.method ?? ''] ?? 'payment'
  return (
    <Dialog
      open={pending !== null}
      // Escape and the backdrop go through the same path as the button: giving
      // up on a payment gives the money back, and a dialog that can be
      // dismissed without doing that leaves a customer out of pocket.
      onClose={onCancel}
      title="Waiting for the customer"
      description={`The ${method} payment opens in its own tab. This sale is not placed until it goes through.`}
      footer={
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel this payment
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="rounded-xl bg-surface-sunken p-4 text-center">
          <p className="text-sm font-medium text-text-muted">Waiting for</p>
          <p className="mt-1 text-4xl font-semibold tracking-[-0.03em] text-text">
            {pending && <MoneyText value={pending.amount} deemphasiseSymbol />}
          </p>
        </div>

        {blocked ? (
          <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-subtle p-3">
            <span className="mt-0.5 text-warning-text">
              <Icon name="TriangleAlert" size="md" />
            </span>
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-text">
                Your browser blocked the payment tab. Open it here instead.
              </p>
              {pending && (
                <Button
                  size="sm"
                  onClick={() => window.open(pending.url, '_blank', 'noopener,noreferrer')}
                >
                  Open the payment page
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 text-text-muted">
            <Spinner />
            <p className="text-sm">Nothing to do here until they finish.</p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
