import { useEffect, useState } from 'react'
import {
  money,
  parseDecimalInput,
  serialiseMoney,
  toDecimalString,
  type Money,
} from '@twentyfour/money'
import type { TenderInput, TenderMethod } from '@twentyfour/api'
import { Button, Dialog, Icon, IconButton, MoneyText, cn, useFormat, type IconName } from '@twentyfour/ui'
import { cashSuggestions } from './cart'

/**
 * Taking the money.
 *
 * The methods offered are data, not a branch. POS asks for a payment and gets
 * a result; it never learns that one market answered with a card and another
 * with a mobile wallet, which is what lets the Payments pod be swapped without
 * this screen changing.
 */
const METHODS: Array<{ id: TenderMethod; label: string; icon: IconName }> = [
  { id: 'cash', label: 'Cash', icon: 'Wallet' },
  { id: 'card', label: 'Card', icon: 'CreditCard' },
  { id: 'wallet', label: 'Wallet', icon: 'ScanLine' },
]

/** A payment already accepted towards this sale. */
interface TakenTender {
  readonly method: TenderMethod
  /** What it pays off. Never more than what was still owed when it was taken. */
  readonly amount: Money
  /** What was physically handed over. Cash only, and only when it differs. */
  readonly tendered: Money | null
}

const label = (method: TenderMethod): string =>
  METHODS.find((entry) => entry.id === method)?.label ?? method

/**
 * One sale, one or several payments.
 *
 * A split is the ordinary case at a counter, not an edge case: two people
 * paying half each, a gift card that does not cover the basket, the last of
 * someone's cash and the rest on a card. Each payment is accepted against what
 * is still owed, and the sale is not placed until nothing is.
 *
 * Only cash can be handed over in excess of what is owed, because change comes
 * out of a drawer. Every other method is charged for exactly what it settles.
 */
export function TenderDialog({
  open,
  due,
  onClose,
  onConfirm,
  pending,
  title = 'Take payment',
  confirmLabel = 'Complete sale',
}: {
  open: boolean
  due: Money
  onClose: () => void
  onConfirm: (tenders: TenderInput[]) => void
  pending: boolean
  title?: string
  confirmLabel?: string
}) {
  const { currency } = useFormat()
  const [taken, setTaken] = useState<TakenTender[]>([])
  const [method, setMethod] = useState<TenderMethod>('card')
  const [entry, setEntry] = useState('')

  const settled = taken.reduce((sum, tender) => sum + tender.amount.minor, 0)
  const remaining = money(Math.max(0, due.minor - settled), currency)

  // Opening is the only thing that resets. Every later change to the field is
  // made by the code that moved the balance, so the amount on screen can never
  // be one taken from a sale that has already been rung up.
  useEffect(() => {
    if (!open) return
    setTaken([])
    setMethod('card')
    setEntry(toDecimalString(due))
  }, [open, due.minor, due.currency])

  let handedOver: Money | null = null
  let error: string | undefined

  if (entry.trim() !== '') {
    try {
      handedOver = parseDecimalInput(entry, currency)
      if (handedOver.minor <= 0) {
        error = 'Enter an amount.'
        handedOver = null
      } else if (method !== 'cash' && handedOver.minor > remaining.minor) {
        // No card gives change. Charging more than the sale is worth and
        // handing the difference back in cash is a way to launder a drawer.
        error = `A ${label(method).toLowerCase()} payment cannot be more than the balance.`
        handedOver = null
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Enter an amount.'
    }
  }

  const applied = handedOver ? money(Math.min(handedOver.minor, remaining.minor), currency) : null
  const change =
    method === 'cash' && handedOver && handedOver.minor > remaining.minor
      ? money(handedOver.minor - remaining.minor, currency)
      : null
  const completes = applied !== null && applied.minor >= remaining.minor

  const toInput = (tender: TakenTender): TenderInput => ({
    method: tender.method,
    amount: serialiseMoney(tender.amount),
    ...(tender.tendered ? { tendered: serialiseMoney(tender.tendered) } : {}),
  })

  const submit = () => {
    if (!applied || !handedOver) return
    const next: TakenTender = {
      method,
      amount: applied,
      tendered: method === 'cash' ? handedOver : null,
    }
    if (completes) {
      onConfirm([...taken, next].map(toInput))
      return
    }
    // A part payment leaves a balance, and the balance is what the next
    // payment is for. Defaulting to it is right nearly every time and typing
    // over it is the only thing a further split has to do.
    setTaken((current) => [...current, next])
    setMethod('card')
    setEntry(toDecimalString(money(remaining.minor - next.amount.minor, currency)))
  }

  const removeTaken = (index: number) => {
    const removed = taken[index]
    if (!removed) return
    setTaken((current) => current.filter((_, position) => position !== index))
    setEntry(toDecimalString(money(remaining.minor + removed.amount.minor, currency)))
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" loading={pending} disabled={applied === null} onClick={submit}>
            {completes ? confirmLabel : 'Add part payment'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="rounded-xl bg-surface-sunken p-4 text-center">
          <p className="text-sm font-medium text-text-muted">
            {taken.length > 0 ? 'Left to pay' : 'Amount due'}
          </p>
          <p className="mt-1 text-4xl font-semibold tracking-[-0.03em] text-text">
            <MoneyText value={remaining} deemphasiseSymbol />
          </p>
          {taken.length > 0 && (
            <p className="mt-1 text-sm text-text-subtle">
              of <MoneyText value={due} display="none" />
            </p>
          )}
        </div>

        {taken.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {taken.map((tender, index) => (
              <li
                key={`${tender.method}-${index}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <Icon
                  name={METHODS.find((option) => option.id === tender.method)?.icon ?? 'Wallet'}
                  size="md"
                  className="text-text-subtle"
                />
                <span className="text-base font-medium text-text">{label(tender.method)}</span>
                <span className="tnum ml-auto text-base font-semibold">
                  <MoneyText value={tender.amount} display="none" />
                </span>
                {/* Taken in this dialog and not yet sent anywhere, so it can
                    simply be taken off again. Once the sale is placed a
                    payment is a refund, not a deletion. */}
                <IconButton
                  icon="X"
                  label={`Remove the ${label(tender.method).toLowerCase()} payment`}
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => removeTaken(index)}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={method === option.id}
              onClick={() => setMethod(option.id)}
              className={cn(
                'flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border',
                'text-base font-medium transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                method === option.id
                  ? 'border-accent bg-accent-subtle text-accent-text'
                  : 'border-border-strong bg-surface text-text-muted hover:text-text',
              )}
            >
              <Icon name={option.icon} size="xl" />
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {method === 'cash' && (
            <div className="grid grid-cols-4 gap-2">
              {cashSuggestions(remaining, currency).map((suggestion) => (
                <button
                  key={suggestion.minor}
                  type="button"
                  // The decimal form, not the minor units. Typing "1000" into a
                  // field that means euros is a ten thousand euro tender.
                  onClick={() => setEntry(toDecimalString(suggestion))}
                  className={cn(
                    'tnum h-12 rounded-lg border border-border-strong bg-surface px-2',
                    'text-base font-medium transition-colors hover:bg-surface-hover',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                  )}
                >
                  <MoneyText value={suggestion} display="none" />
                </button>
              ))}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">
              {method === 'cash' ? 'Cash received' : `${label(method)} amount`}
            </span>
            <input
              inputMode="decimal"
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
              aria-invalid={error ? true : undefined}
              className={cn(
                'tnum h-14 w-full rounded-lg border bg-surface px-3 text-right text-2xl font-semibold',
                'focus:outline-none focus:ring-[3px] focus:ring-accent/18',
                error ? 'border-danger' : 'border-border-strong focus:border-accent',
              )}
            />
            {error && (
              <span role="alert" className="text-sm text-danger-text">
                {error}
              </span>
            )}
          </label>

          {method === 'cash' ? (
            /* Change is the number the cashier acts on, so it gets the
               emphasis, not the tendered figure they just typed. */
            <div
              className={cn(
                'flex items-baseline justify-between rounded-xl p-4',
                change && change.minor > 0 ? 'bg-success-subtle' : 'bg-surface-sunken',
              )}
            >
              <span className="text-base font-medium text-text-muted">Change</span>
              <span className="text-2xl font-semibold text-text">
                <MoneyText value={change ?? money(0, currency)} deemphasiseSymbol />
              </span>
            </div>
          ) : (
            applied !== null &&
            !completes && (
              <p className="text-base text-text-muted">
                Leaves <MoneyText value={money(remaining.minor - applied.minor, currency)} /> to pay.
              </p>
            )
          )}
        </div>
      </div>
    </Dialog>
  )
}
