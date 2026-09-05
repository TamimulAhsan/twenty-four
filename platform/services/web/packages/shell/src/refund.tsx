import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { orders, type Order, type OrderLine } from '@twentyfour/api'
import { money, type Money } from '@twentyfour/money'
import { Button, Card, MoneyText, useToast } from '@twentyfour/ui'

/**
 * Giving money back, in one place.
 *
 * Both surfaces that can refund a sale run through this: the till, where it
 * happens with the customer still at the counter, and the dashboard, where the
 * owner does it after the fact. They look different on purpose, because one is
 * read at arm's length on a tablet and the other at a desk, but what a refund
 * *is* must not differ between them. Two implementations of "which lines have
 * already gone back" is two answers to it, and only one of them is right.
 *
 * The rules held here:
 *
 * - A line goes back once. A second attempt is refused rather than quietly
 *   paying it out twice, returning two to stock and issuing two credit notes
 *   against a sale that happened once.
 * - Picking nothing means everything still owed, which is what somebody who
 *   pressed Refund without touching a line meant.
 * - The amount is built from the lines actually going back, never from the
 *   order total, and never by casting past the MinorUnits brand.
 *
 * None of it is the control. The gateway refuses a refund this cannot see, and
 * the store refuses a line it has already returned. This keeps the screen from
 * offering an action that would be refused, and nothing more.
 */
export type RefundKind = 'void' | 'refund'

export interface OrderRefund {
  /** Lines already refunded, by id. */
  readonly refunded: ReadonlySet<string>
  /** What is left to give back. */
  readonly refundable: readonly OrderLine[]
  /** What the operator picked. Empty means all of `refundable`. */
  readonly picked: readonly OrderLine[]
  /** What pressing refund would actually return. */
  readonly returning: readonly OrderLine[]
  /** What that comes to. */
  readonly returningTotal: Money
  readonly isPicked: (lineId: string) => boolean
  readonly toggle: (lineId: string) => void
  /** Whether lines can be picked at all: false once there is nothing left. */
  readonly selectable: boolean
  readonly canRefund: boolean
  readonly canVoid: boolean
  /** True when only some of the sale is going back. */
  readonly partial: boolean
  readonly confirming: RefundKind | null
  readonly ask: (kind: RefundKind | null) => void
  readonly run: () => void
  readonly pending: boolean
}

export function useOrderRefund({
  order,
  source,
  onDone,
  allowVoid = true,
  allowRefund = true,
}: {
  order: Order | null | undefined
  /** Where this was done, recorded as the reason: "the till", "the dashboard". */
  source: string
  onDone?: () => void
  /** The viewer holds the permission. The gateway checks it regardless. */
  allowVoid?: boolean
  allowRefund?: boolean
}): OrderRefund {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<RefundKind | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // A different sale starts clean. Carrying a selection across is how the
  // wrong line gets refunded.
  useEffect(() => {
    setSelected(new Set())
    setConfirming(null)
  }, [order?.id])

  const refunded = new Set(order?.refundedLineIds ?? [])
  const refundable = (order?.lines ?? []).filter((line) => !refunded.has(line.id))
  const picked = refundable.filter((line) => selected.has(line.id))
  const returning = picked.length > 0 ? picked : refundable

  const currency = order?.gross.currency ?? 'EUR'
  const returningTotal = money(
    returning.reduce((sum, line) => sum + line.gross.minor, 0),
    currency,
  )

  const act = useMutation({
    mutationFn: (kind: RefundKind) =>
      kind === 'void'
        ? orders.void(order!.id, `Voided from ${source}`)
        : orders.refund(order!.id, {
            reason: `Refunded from ${source}`,
            // Sent only when lines were picked. Omitting it means "the rest",
            // which is what the contract already says and what keeps a full
            // refund from having to enumerate itself.
            ...(picked.length > 0 ? { lineIds: picked.map((line) => line.id) } : {}),
          }),
    onSuccess: (_updated, kind) => {
      // A sale touches stock, takings, payments and documents. Invalidating
      // broadly is right: more moved than the caller can name.
      void queryClient.invalidateQueries()
      setConfirming(null)
      setSelected(new Set())
      toast.show({
        tone: 'success',
        title: kind === 'void' ? 'Sale voided' : 'Refunded',
        description:
          kind === 'void'
            ? 'Stock has gone back and the sale is out of the day’s takings.'
            : 'A credit note has been issued for what went back. The original is unchanged.',
      })
      onDone?.()
    },
    onError: (error) => {
      toast.show({
        tone: 'danger',
        title: 'Nothing was given back',
        description: error.message,
      })
    },
  })

  // Voiding is for a sale that should not have happened at all, so it stops
  // being offered the moment any part of it has been given back: a sale that
  // is half refunded and then voided is refunded twice.
  const canVoid = allowVoid && order?.status === 'paid'
  const canRefund = allowRefund && refundable.length > 0 && order?.status !== 'voided'

  return {
    refunded,
    refundable,
    picked,
    returning,
    returningTotal,
    isPicked: (lineId) => selected.has(lineId),
    toggle: (lineId) =>
      setSelected((current) => {
        const next = new Set(current)
        if (next.has(lineId)) next.delete(lineId)
        else next.add(lineId)
        return next
      }),
    selectable: canRefund && refundable.length > 1,
    canVoid: canVoid === true,
    canRefund,
    partial: returning.length < (order?.lines.length ?? 0),
    confirming,
    ask: setConfirming,
    run: () => confirming && act.mutate(confirming),
    pending: act.isPending,
  }
}

/**
 * The checkbox against one line.
 *
 * Shared so the two surfaces cannot disagree about which lines can still be
 * picked, while each keeps the row it renders around it: the till puts it on a
 * list read at arm's length, the dashboard in a table with its own columns.
 */
export function RefundCheckbox({
  line,
  refund,
}: {
  line: OrderLine
  refund: OrderRefund
}) {
  const done = refund.refunded.has(line.id)
  return (
    <input
      type="checkbox"
      className="size-4 accent-[var(--accent)]"
      checked={refund.isPicked(line.id)}
      disabled={done}
      aria-label={done ? `${line.name} has already been refunded` : `Refund ${line.name}`}
      onChange={() => refund.toggle(line.id)}
    />
  )
}

/** The two destructive actions, for a dialog footer. */
export function RefundActions({ refund }: { refund: OrderRefund }) {
  return (
    <>
      {refund.canVoid && (
        <Button variant="outline" onClick={() => refund.ask('void')}>
          Void
        </Button>
      )}
      {refund.canRefund && (
        <Button variant="danger" onClick={() => refund.ask('refund')}>
          {refund.picked.length > 0
            ? `Refund ${refund.picked.length} of ${refund.refundable.length}`
            : 'Refund'}
        </Button>
      )}
    </>
  )
}

/**
 * What is about to happen, said plainly, with the figure on it.
 *
 * The amount is here rather than only in a toast afterwards, because the last
 * moment somebody can stop a refund is before they confirm it.
 */
export function RefundConfirmation({ order, refund }: { order: Order; refund: OrderRefund }) {
  if (!refund.confirming) return null
  const voiding = refund.confirming === 'void'

  return (
    <Card className="border-danger-border bg-danger-subtle">
      <p className="text-base font-medium text-text">
        {voiding
          ? 'Void this sale?'
          : refund.partial
            ? `Refund ${refund.returning.length} of ${order.lines.length} lines?`
            : 'Refund this sale in full?'}
      </p>
      <p className="mt-1 text-base text-text-muted">
        {voiding
          ? 'It comes out of the day’s takings and the stock goes back.'
          : 'A credit note is issued referencing the original. The original document stays exactly as it was issued.'}
      </p>
      {!voiding && (
        <p className="mt-2 text-md font-semibold text-text">
          Giving back <MoneyText value={refund.returningTotal} />
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => refund.ask(null)}>
          Keep it
        </Button>
        <Button variant="danger" size="sm" loading={refund.pending} onClick={refund.run}>
          Yes, {refund.confirming}
        </Button>
      </div>
    </Card>
  )
}

/** Says that picking nothing gives back everything still owed. Only worth
 *  saying where there is more than one line to pick from. */
export function RefundHint({ refund }: { refund: OrderRefund }) {
  if (!refund.selectable) return null
  return (
    <p className="text-sm text-text-subtle">
      Pick lines to refund only those, or refund without picking any to give back everything
      still owed.
    </p>
  )
}
