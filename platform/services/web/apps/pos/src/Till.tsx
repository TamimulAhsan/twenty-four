import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  catalog, idempotencyKey, orders, queryKeys, tables as tablesApi,
  type CatalogItem, type Order, type ParkOrderInput, type PaymentPending, type TenderInput,
} from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { serialiseMoney } from '@twentyfour/money'
import {
  Badge, Button, DENSE_GUTTER, EmptyState, ErrorState, Icon, IconButton, MoneyText, Skeleton,
  cn, useFormat, useToast,
} from '@twentyfour/ui'
import { cartLinesFromOrder, useCart } from './cart'
import { TenderDialog } from './TenderDialog'
import { ReceiptDialog } from './ReceiptDialog'
import { AwaitingPaymentDialog } from './AwaitingPaymentDialog'
import { PaymentNotCompleted, runCheckout } from './checkout'

/**
 * The till.
 *
 * A sale here is one of three things: a new one, a tab being resumed, or a new
 * tab about to be opened on a table. All three ring up identically, and only
 * what happens at the end differs.
 */
export function Till({
  resumeOrderId,
  startTableId,
  onOpened,
}: {
  /** A parked sale to reopen, from the parked list or from the floor. */
  resumeOrderId: string | null
  /** A table to start a new tab on. */
  startTableId: string | null
  /** Tells the shell the handoff has been taken, so it does not repeat it. */
  onOpened: () => void
}) {
  const terms = useTerms()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { currency } = useFormat()
  const cart = useCart(currency)

  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const [tendering, setTendering] = useState(false)
  const [receipt, setReceipt] = useState<Order | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  /** The parked sale this cart is, once it is one. */
  const [parkedId, setParkedId] = useState<string | null>(null)
  /** The table this sale belongs to. Set before it is parked as well as after,
   *  so a tab started from the floor keeps its table if it is parked later. */
  const [tableId, setTableId] = useState<string | null>(null)
  /** Set while the customer is away paying. */
  const [awaiting, setAwaiting] = useState<PaymentPending | null>(null)
  /** The browser refused the payment tab, so the dialog has to offer the link. */
  const [popupBlocked, setPopupBlocked] = useState(false)

  /**
   * The key that makes this one checkout rather than several.
   *
   * Held in a ref, not in state, because every attempt at the same sale must
   * send the same one and a re-render must not mint a new one. A fresh key per
   * attempt would charge per attempt. Cleared once the sale is placed, so the
   * next customer starts a checkout of their own.
   */
  const checkoutKey = useRef<string | null>(null)
  /** Lets the cancel button stop the wait. */
  const waiting = useRef<AbortController | null>(null)

  const { load: loadCart, clear: clearCart } = cart

  const categories = useQuery({ queryKey: queryKeys.catalog.categories(), queryFn: catalog.categories })
  const items = useQuery({ queryKey: queryKeys.catalog.items({}), queryFn: () => catalog.items() })

  const resuming = useQuery({
    queryKey: queryKeys.orders.detail(resumeOrderId ?? ''),
    queryFn: () => orders.detail(resumeOrderId as string),
    enabled: resumeOrderId !== null,
  })

  // Only fetched to put a name on the tab. A till with no floor never asks.
  const floor = useQuery({
    queryKey: queryKeys.tables.list(),
    queryFn: tablesApi.list,
    enabled: tableId !== null,
  })
  const tableLabel = floor.data?.find((table) => table.id === tableId)?.label ?? null

  // Reopening a tab. It waits for the catalog because a cart line holds the
  // item, not a copy of what the item cost when the tab was opened.
  useEffect(() => {
    if (resumeOrderId === null) return
    const order = resuming.data
    if (!order || !items.data) return

    const { lines, missing } = cartLinesFromOrder(order, items.data)
    loadCart(lines, order.note)
    setParkedId(order.id)
    setTableId(order.tableId)
    onOpened()

    if (missing.length > 0) {
      toast.show({
        tone: 'warning',
        title: 'Some lines could not be reopened',
        description: `${missing.join(', ')} is no longer in the ${terms.t('catalog', { case: 'lower' })}. Ring it up again or take it off.`,
      })
    }
  }, [resumeOrderId, resuming.data, items.data, loadCart, onOpened, toast, terms])

  // Starting a fresh tab on a table from the floor screen.
  useEffect(() => {
    if (startTableId === null) return
    clearCart()
    setParkedId(null)
    setTableId(startTableId)
    onOpened()
  }, [startTableId, clearCart, onOpened])

  const lineInput = () =>
    cart.lines.map((line) => ({
      itemId: line.item.id,
      quantity: line.quantity,
      ...(line.discount ? { discount: serialiseMoney(line.discount) } : {}),
    }))

  const parkInput = (): ParkOrderInput => ({
    lines: lineInput(),
    ...(cart.note ? { note: cart.note } : {}),
    tableId,
  })

  /** Leaves the tab where it is and starts a fresh sale. The parked sale is
   *  untouched: it is still in the parked list and still on its table. */
  const leaveTab = () => {
    clearCart()
    setParkedId(null)
    setTableId(null)
  }

  const park = useMutation({
    mutationFn: () =>
      parkedId ? orders.updateParked(parkedId, parkInput()) : orders.park(parkInput()),
    onSuccess: (order) => {
      leaveTab()
      setCartOpen(false)
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: tableLabel ? `Tab saved to table ${tableLabel}` : `Sale ${order.number} parked`,
        description: 'It is waiting under Parked, with its stock held back.',
      })
    },
    onError: (error) => {
      toast.show({ tone: 'danger', title: 'That sale was not parked', description: error.message })
    },
  })

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (items.data ?? []).filter((item) => {
      if (categoryId && item.categoryId !== categoryId) return false
      if (needle && !`${item.name} ${item.sku}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [items.data, categoryId, search])

  /** Gives back anything taken for a checkout the till is giving up on. */
  const releaseCheckout = (checkoutId: string): void => {
    void orders.abandonCheckout(checkoutId).catch(() => {
      // Said out loud rather than swallowed. Money taken for a sale that did
      // not happen is the one failure here a merchant has to know about.
      toast.show({
        tone: 'danger',
        title: 'That payment may not have been released',
        description: 'Check it under Payments before the customer leaves.',
      })
    })
  }

  const cancelWaiting = (): void => {
    const pending = awaiting
    waiting.current?.abort()
    setAwaiting(null)
    // A new key, because the old one now names a payment that was called off.
    // Reusing it would ask for a sale against a cancelled payment and be
    // refused, which reads to a cashier as a till that has jammed.
    checkoutKey.current = null
    if (pending) releaseCheckout(pending.checkoutId)
  }

  const place = useMutation({
    // A tab settles as the sale it already is: same id, same number. Placing it
    // afresh would leave the parked one behind and hold its stock forever.
    //
    // What is on screen is saved first. A tab is resumed precisely so more can
    // go on it, and settling the lines the server still remembers would charge
    // for the first round and quietly throw the second away.
    //
    // A card or a wallet answers with somewhere to send the customer rather
    // than with a sale. The till opens it, waits, and asks again under the same
    // key: the payment is then found rather than taken twice.
    mutationFn: async (tenders: TenderInput[]) => {
      const key = (checkoutKey.current ??= idempotencyKey())
      const controller = new AbortController()
      waiting.current = controller

      const attempt = async () => {
        if (!parkedId) {
          return orders.place(
            { lines: lineInput(), tenders, ...(cart.note ? { note: cart.note } : {}) },
            key,
          )
        }
        await orders.updateParked(parkedId, parkInput())
        return orders.settleParked(parkedId, tenders, key)
      }

      try {
        return await runCheckout(attempt, {
          signal: controller.signal,
          onAwaiting: (pending, tab) => {
            setAwaiting(pending)
            setPopupBlocked(tab === null)
          },
        })
      } finally {
        waiting.current = null
        setAwaiting(null)
      }
    },
    onSuccess: (order) => {
      // The checkout is over, so the next one is a different checkout.
      checkoutKey.current = null
      leaveTab()
      setTendering(false)
      setCartOpen(false)
      setReceipt(order)
      // Takings, stock and the order list all moved. Invalidating broadly is
      // right here: a sale touches more than the caller can name.
      void queryClient.invalidateQueries()
    },
    onError: (error) => {
      // Cancelling is not a failure and the dialog already said what happened.
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (error instanceof PaymentNotCompleted) {
        toast.show({
          tone: 'warning',
          title: 'Nobody completed that payment',
          description: error.message,
        })
        return
      }
      // The key is dropped so the cashier's next attempt is a clean one. A
      // refusal leaves nothing taken: whatever was is given back before the
      // error reaches here.
      checkoutKey.current = null
      toast.show({ tone: 'danger', title: 'That sale did not go through', description: error.message })
    },
  })

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className={cn('flex shrink-0 flex-col gap-2 border-b border-border', DENSE_GUTTER)}>
          <label className="relative flex items-center">
            <span className="sr-only">Search {terms.t('catalog_item', { plural: true, case: 'lower' })}</span>
            <span className="pointer-events-none absolute left-3 text-text-subtle">
              <Icon name="Search" size="md" />
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${terms.t('catalog_item', { plural: true, case: 'lower' })}`}
              className={cn(
                'h-11 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-3',
                'text-md sm:text-base placeholder:text-text-subtle',
                'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/18',
              )}
            />
          </label>

          {/* A rail, not a wrap: categories must never push the grid down the
              screen on a tablet held in portrait. */}
          <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            <CategoryChip active={categoryId === ''} onClick={() => setCategoryId('')}>
              All
            </CategoryChip>
            {(categories.data ?? []).map((category) => (
              <CategoryChip
                key={category.id}
                active={categoryId === category.id}
                onClick={() => setCategoryId(category.id)}
              >
                {category.name}
              </CategoryChip>
            ))}
          </div>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto', DENSE_GUTTER)}>
          {items.isError ? (
            <ErrorState onRetry={() => void items.refetch()} />
          ) : items.isPending ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="h-24" />)}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="Search"
              title={`No ${terms.t('catalog_item', { plural: true, case: 'lower' })} match`}
              description="Clear the search or pick another category."
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {visible.map((item) => (
                <ItemKey key={item.id} item={item} onPress={() => cart.add(item)} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Desktop and tablet landscape: the cart is always visible, because a
          cashier needs to see the running total while they are still adding to
          it. Below that it becomes a sheet raised by a bar showing the total. */}
      <aside className="hidden w-80 shrink-0 border-l border-border bg-surface lg:flex xl:w-96">
        <CartPanel
          cart={cart}
          onTender={() => setTendering(true)}
          onPark={() => park.mutate()}
          parking={park.isPending}
          isTab={parkedId !== null}
          tableLabel={tableLabel}
          onLeaveTab={leaveTab}
        />
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface p-4 lg:hidden">
        <Button
          size="lg"
          block
          disabled={cart.count === 0}
          onClick={() => setCartOpen(true)}
          className="justify-between"
        >
          <span className="flex items-center gap-2">
            <Icon name="Receipt" size="lg" />
            {cart.count} {cart.count === 1 ? terms.t('order_line', { case: 'lower' }) : terms.t('order_line', { plural: true, case: 'lower' })}
          </span>
          <MoneyText value={cart.total.gross} />
        </Button>
      </div>

      {cartOpen && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end bg-scrim lg:hidden" onClick={() => setCartOpen(false)}>
          <div
            className="max-h-[85dvh] rounded-t-2xl border border-border bg-surface animate-[var(--animate-slide-up)] motion-reduce:animate-none"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-md font-semibold">This sale</p>
              <IconButton icon="X" label="Close" size="sm" onClick={() => setCartOpen(false)} />
            </div>
            <CartPanel
              cart={cart}
              onTender={() => setTendering(true)}
              onPark={() => park.mutate()}
              parking={park.isPending}
              isTab={parkedId !== null}
              tableLabel={tableLabel}
              onLeaveTab={leaveTab}
            />
          </div>
        </div>
      )}

      <TenderDialog
        open={tendering}
        due={cart.total.gross}
        onClose={() => setTendering(false)}
        onConfirm={(tenders) => place.mutate(tenders)}
        pending={place.isPending}
        title={parkedId ? 'Settle this tab' : 'Take payment'}
        confirmLabel={parkedId ? 'Settle the tab' : 'Complete sale'}
      />

      <AwaitingPaymentDialog
        pending={awaiting}
        blocked={popupBlocked}
        onCancel={cancelWaiting}
      />

      <ReceiptDialog order={receipt} onClose={() => setReceipt(null)} />
    </div>
  )
}

function CategoryChip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-10 shrink-0 whitespace-nowrap rounded-lg border px-3.5 text-base font-medium',
        'transition-colors duration-[var(--duration-fast)]',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        active
          ? 'border-transparent bg-surface-inverse text-text-inverse'
          : 'border-border-strong bg-surface text-text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

/**
 * One key on the till.
 *
 * Tall enough to hit without looking, and the price is on the key: a cashier
 * confirming a total against a customer should not have to open anything.
 */
function ItemKey({ item, onPress }: { item: CatalogItem; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        'relative flex h-24 flex-col justify-between overflow-hidden rounded-xl border border-border',
        'bg-surface p-3 text-left transition-[transform,border-color,background-color]',
        'duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'hover:border-border-strong hover:bg-surface-hover active:scale-[0.97]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: item.colour ?? 'var(--border)' }}
      />
      <span className="line-clamp-2 pt-1 text-base font-medium leading-snug text-text">{item.name}</span>
      <span className="tnum text-md font-semibold text-text">
        <MoneyText value={item.unitPrice} />
      </span>
    </button>
  )
}

function CartPanel({
  cart, onTender, onPark, parking, isTab, tableLabel, onLeaveTab,
}: {
  cart: ReturnType<typeof useCart>
  onTender: () => void
  onPark: () => void
  parking: boolean
  /** Already parked, so parking again saves rather than creates. */
  isTab: boolean
  tableLabel: string | null
  onLeaveTab: () => void
}) {
  const terms = useTerms()

  return (
    <div className="flex min-h-0 w-full flex-col">
      {(isTab || tableLabel) && (
        /* What this sale belongs to, where a cashier looks before they ring
           anything up. A tab charged to the wrong table is found at the end of
           the night by the party who did not order it. */
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-subtle px-4 py-2.5">
          <Icon name="Receipt" size="md" className="text-accent-text" />
          <span className="min-w-0 flex-1 truncate text-base font-medium text-accent-text">
            {tableLabel ? `Table ${tableLabel}` : 'Parked sale'}
            {isTab ? '' : ' · not saved yet'}
          </span>
          <Button variant="ghost" size="sm" onClick={onLeaveTab}>
            Leave
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {cart.lines.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon="Receipt"
              title="Nothing on this sale yet"
              description={`Tap ${terms.a('catalog_item', { case: 'lower' })} to start.`}
              className="border-0"
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {cart.lines.map((line, index) => (
              <li key={line.key} className="flex items-start gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-text">{line.item.name}</p>
                  <p className="tnum mt-0.5 text-sm text-text-subtle">
                    <MoneyText value={line.item.unitPrice} display="none" /> each
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    icon="Minus" label={`One fewer ${line.item.name}`} size="sm" variant="outline"
                    onClick={() => cart.setQuantity(line.key, line.quantity - 1)}
                  />
                  <span className="tnum w-7 text-center text-base font-semibold">{line.quantity}</span>
                  <IconButton
                    icon="Plus" label={`One more ${line.item.name}`} size="sm" variant="outline"
                    onClick={() => cart.setQuantity(line.key, line.quantity + 1)}
                  />
                </div>

                <span className="tnum w-20 shrink-0 pt-1.5 text-right text-base font-semibold">
                  <MoneyText value={cart.perLine[index]?.gross ?? line.item.unitPrice} display="none" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cn('shrink-0 border-t border-border', DENSE_GUTTER)}>
        {cart.bands.length > 0 && (
          <dl className="mb-2.5 flex flex-col gap-1 text-sm text-text-muted">
            <div className="flex justify-between">
              <dt>Net</dt>
              <dd className="tnum"><MoneyText value={cart.total.net} display="none" /></dd>
            </div>
            {cart.bands.map((band) => (
              <div key={band.basisPoints} className="flex justify-between">
                <dt>Tax {band.basisPoints / 100}%</dt>
                <dd className="tnum"><MoneyText value={band.tax} display="none" /></dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-base font-medium text-text-muted">Total</span>
          <span className="text-2xl font-semibold tracking-[-0.02em] text-text">
            <MoneyText value={cart.total.gross} deemphasiseSymbol />
          </span>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="lg"
            disabled={cart.count === 0 || parking}
            onClick={onLeaveTab}
          >
            Clear
          </Button>
          {/* Park sits beside pay, not behind a menu. Setting a sale aside is
              what a counter does when the queue moves and the customer does
              not, and a till that hides it loses the sale instead. */}
          <Button
            variant="outline"
            size="lg"
            iconStart="Clock"
            loading={parking}
            disabled={cart.count === 0}
            onClick={onPark}
          >
            {isTab ? 'Save tab' : 'Park'}
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={cart.count === 0 || parking}
            onClick={onTender}
          >
            {isTab ? 'Settle' : 'Take payment'}
          </Button>
        </div>

        {cart.count > 0 && (
          <p className="mt-2 text-center text-sm text-text-subtle">
            <Badge tone="neutral">{cart.count} on this sale</Badge>
          </p>
        )}
      </div>
    </div>
  )
}
