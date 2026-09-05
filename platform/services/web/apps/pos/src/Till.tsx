import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, orders, queryKeys, type CatalogItem, type Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { serialiseMoney } from '@twentyfour/money'
import {
  Badge, Button, DENSE_GUTTER, EmptyState, ErrorState, Icon, IconButton, MoneyText, Skeleton,
  cn, useFormat, useToast,
} from '@twentyfour/ui'
import { useCart } from './cart'
import { TenderDialog } from './TenderDialog'
import { ReceiptDialog } from './ReceiptDialog'

export function Till() {
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

  const categories = useQuery({ queryKey: queryKeys.catalog.categories(), queryFn: catalog.categories })
  const items = useQuery({ queryKey: queryKeys.catalog.items({}), queryFn: () => catalog.items() })

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (items.data ?? []).filter((item) => {
      if (categoryId && item.categoryId !== categoryId) return false
      if (needle && !`${item.name} ${item.sku}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [items.data, categoryId, search])

  const place = useMutation({
    mutationFn: (tenders: Parameters<typeof orders.place>[0]['tenders']) =>
      orders.place({
        lines: cart.lines.map((line) => ({
          itemId: line.item.id,
          quantity: line.quantity,
          ...(line.discount ? { discount: serialiseMoney(line.discount) } : {}),
        })),
        tenders,
        ...(cart.note ? { note: cart.note } : {}),
      }),
    onSuccess: (order) => {
      cart.clear()
      setTendering(false)
      setCartOpen(false)
      setReceipt(order)
      // Takings, stock and the order list all moved. Invalidating broadly is
      // right here: a sale touches more than the caller can name.
      void queryClient.invalidateQueries()
    },
    onError: (error) => {
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
        <CartPanel cart={cart} onTender={() => setTendering(true)} />
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
            <CartPanel cart={cart} onTender={() => setTendering(true)} />
          </div>
        </div>
      )}

      <TenderDialog
        open={tendering}
        due={cart.total.gross}
        onClose={() => setTendering(false)}
        onConfirm={(tenders) => place.mutate(tenders)}
        pending={place.isPending}
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
  cart, onTender,
}: { cart: ReturnType<typeof useCart>; onTender: () => void }) {
  const terms = useTerms()

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {cart.lines.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon="Receipt"
              title="EDIT TEST: nothing on this sale yet"
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
          <Button variant="outline" size="lg" disabled={cart.count === 0} onClick={cart.clear}>
            Clear
          </Button>
          <Button size="lg" className="flex-1" disabled={cart.count === 0} onClick={onTender}>
            Take payment
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
