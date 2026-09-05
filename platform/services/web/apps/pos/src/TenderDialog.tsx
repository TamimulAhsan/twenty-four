import { useEffect, useState } from 'react'
import { changeDue, money, parseDecimalInput, serialiseMoney, type Money } from '@twentyfour/money'
import type { TenderInput, TenderMethod } from '@twentyfour/api'
import { Button, Dialog, Icon, MoneyText, cn, useFormat, type IconName } from '@twentyfour/ui'
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

export function TenderDialog({
  open,
  due,
  onClose,
  onConfirm,
  pending,
}: {
  open: boolean
  due: Money
  onClose: () => void
  onConfirm: (tenders: TenderInput[]) => void
  pending: boolean
}) {
  const { currency } = useFormat()
  const [method, setMethod] = useState<TenderMethod>('card')
  const [cash, setCash] = useState('')

  useEffect(() => {
    if (open) {
      setMethod('card')
      setCash('')
    }
  }, [open])

  let tendered: Money | null = null
  let change: Money | null = null
  let cashError: string | undefined

  if (method === 'cash' && cash.trim() !== '') {
    try {
      tendered = parseDecimalInput(cash, currency)
      change = tendered.minor >= due.minor ? changeDue(tendered, due) : null
      if (tendered.minor < due.minor) cashError = 'That does not cover the total yet.'
    } catch (error) {
      cashError = error instanceof Error ? error.message : 'Enter an amount.'
    }
  }

  const ready = method !== 'cash' || (tendered !== null && tendered.minor >= due.minor)

  const confirm = () => {
    onConfirm([
      {
        method,
        amount: serialiseMoney(due),
        ...(method === 'cash' && tendered ? { tendered: serialiseMoney(tendered) } : {}),
      },
    ])
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Take payment"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="lg" loading={pending} disabled={!ready} onClick={confirm}>
            {method === 'cash' ? 'Tender cash' : 'Charge'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="rounded-xl bg-surface-sunken p-4 text-center">
          <p className="text-sm font-medium text-text-muted">Amount due</p>
          <p className="mt-1 text-4xl font-semibold tracking-[-0.03em] text-text">
            <MoneyText value={due} deemphasiseSymbol />
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={method === entry.id}
              onClick={() => setMethod(entry.id)}
              className={cn(
                'flex h-20 flex-col items-center justify-center gap-1.5 rounded-xl border',
                'text-base font-medium transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                method === entry.id
                  ? 'border-accent bg-accent-subtle text-accent-text'
                  : 'border-border-strong bg-surface text-text-muted hover:text-text',
              )}
            >
              <Icon name={entry.icon} size="xl" />
              {entry.label}
            </button>
          ))}
        </div>

        {method === 'cash' && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-4 gap-2">
              {cashSuggestions(due, currency).map((suggestion) => (
                <button
                  key={suggestion.minor}
                  type="button"
                  onClick={() => setCash(String(suggestion.minor))}
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

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">Cash received</span>
              <input
                inputMode="decimal"
                value={cash}
                onChange={(event) => setCash(event.target.value)}
                aria-invalid={cashError ? true : undefined}
                className={cn(
                  'tnum h-14 w-full rounded-lg border bg-surface px-3 text-right text-2xl font-semibold',
                  'focus:outline-none focus:ring-[3px] focus:ring-accent/18',
                  cashError ? 'border-danger' : 'border-border-strong focus:border-accent',
                )}
              />
              {cashError && (
                <span role="alert" className="text-sm text-danger-text">{cashError}</span>
              )}
            </label>

            {/* Change is the number the cashier actually acts on, so it gets
                the emphasis, not the tendered figure they just typed. */}
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
          </div>
        )}
      </div>
    </Dialog>
  )
}
