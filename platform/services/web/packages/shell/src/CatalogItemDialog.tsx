import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  catalog, queryKeys, type CatalogItem, type CatalogItemInput, type ItemKind,
} from '@twentyfour/api'
import {
  MoneyError, formatMoney, money, parseDecimalInput, serialiseMoney, toDecimalString,
} from '@twentyfour/money'
import { useTerms } from '@twentyfour/terms'
import { useBootstrap } from '@twentyfour/runtime'
import {
  Button, Card, Dialog, Field, Icon, Input, Select, Switch, cn, useFormat, useToast,
} from '@twentyfour/ui'

interface Draft {
  name: string
  sku: string
  kind: ItemKind
  price: string
  cost: string
  taxBasisPoints: number
  taxIncluded: boolean
  categoryId: string
  trackStock: boolean
  durationMinutes: string
  active: boolean
}

const EMPTY: Draft = {
  name: '', sku: '', kind: 'product', price: '', cost: '',
  taxBasisPoints: 2700, taxIncluded: true, categoryId: '',
  trackStock: false, durationMinutes: '', active: true,
}

/**
 * Creating and editing what you sell.
 *
 * Two things here are load-bearing. Prices are typed as decimals and parsed
 * into minor units, which refuses more precision than the currency has rather
 * than rounding it away: a mistyped price should be a visible error, not a
 * quietly different price. And cost is asked for every time, because an item
 * with no cost has no margin, and a catalog half-costed makes every margin
 * figure on every screen refuse to answer.
 */
export function CatalogItemDialog({
  item,
  open,
  onClose,
}: {
  /** null creates a new one. */
  item: CatalogItem | null
  open: boolean
  onClose: () => void
}) {
  const terms = useTerms()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { profile } = useBootstrap()
  const { currency, locale } = useFormat()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})

  const categories = useQuery({
    queryKey: queryKeys.catalog.categories(),
    queryFn: catalog.categories,
    enabled: open,
  })

  useEffect(() => {
    if (!open) return
    setErrors({})
    setDraft(
      item
        ? {
            name: item.name,
            sku: item.sku,
            kind: item.kind,
            price: toDecimalString(item.unitPrice),
            cost: item.costPrice ? toDecimalString(item.costPrice) : '',
            taxBasisPoints: item.taxBasisPoints,
            taxIncluded: item.taxIncluded,
            categoryId: item.categoryId ?? '',
            trackStock: item.trackStock,
            durationMinutes: item.durationMinutes ? String(item.durationMinutes) : '',
            active: item.active,
          }
        : { ...EMPTY, taxIncluded: profile.pricesIncludeTax },
    )
  }, [open, item, profile.pricesIncludeTax])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  const save = useMutation({
    mutationFn: (input: CatalogItemInput) =>
      item ? catalog.updateItem(item.id, input) : catalog.createItem(input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: item ? `${saved.name} saved` : `${saved.name} added`,
        description: item ? undefined : 'It is on the till straight away.',
      })
      onClose()
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That did not save', description: error.message }),
  })

  const submit = () => {
    const next: Partial<Record<keyof Draft, string>> = {}
    if (!draft.name.trim()) next.name = 'Give it a name.'
    if (!draft.sku.trim()) next.sku = 'A code makes it findable on the till.'

    let price
    try {
      price = parseDecimalInput(draft.price, currency)
      if (price.minor < 0) next.price = 'A price cannot be negative.'
    } catch (error) {
      next.price = error instanceof MoneyError ? error.message : 'Enter a price.'
    }

    let cost = null
    if (draft.cost.trim()) {
      try {
        cost = parseDecimalInput(draft.cost, currency)
        if (price && cost.minor > price.minor) {
          next.cost = 'This costs more than you sell it for. Correct if deliberate.'
        }
      } catch (error) {
        next.cost = error instanceof MoneyError ? error.message : 'Enter a cost.'
      }
    }

    if (draft.kind === 'service' && !draft.durationMinutes.trim()) {
      next.durationMinutes = 'A bookable thing needs a length.'
    }

    setErrors(next)
    // The cost warning is advisory: a loss leader is a real decision.
    const blocking = Object.entries(next).filter(([key]) => key !== 'cost')
    if (blocking.length > 0 || !price) return

    save.mutate({
      name: draft.name.trim(),
      sku: draft.sku.trim().toUpperCase(),
      description: '',
      kind: draft.kind,
      unitPrice: serialiseMoney(price),
      costPrice: cost ? serialiseMoney(cost) : null,
      taxBasisPoints: draft.taxBasisPoints,
      taxIncluded: draft.taxIncluded,
      categoryId: draft.categoryId || null,
      trackStock: draft.trackStock,
      durationMinutes: Number(draft.durationMinutes) || 0,
      active: draft.active,
    })
  }

  // Shown live, because the number a merchant cares about is not the price or
  // the cost but what is left, and doing that arithmetic in their head while
  // typing is how items get mispriced.
  const preview = (() => {
    try {
      const price = parseDecimalInput(draft.price, currency)
      const net = draft.taxIncluded
        ? Math.round((price.minor * 10_000) / (10_000 + draft.taxBasisPoints))
        : price.minor
      if (!draft.cost.trim()) return { net, margin: null as number | null, rate: null as number | null }
      const cost = parseDecimalInput(draft.cost, currency)
      return { net, margin: net - cost.minor, rate: net === 0 ? null : (net - cost.minor) / net }
    } catch {
      return null
    }
  })()

  const itemWord = terms.t('catalog_item', { case: 'lower' })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.name}` : `New ${itemWord}`}
      description={`It appears on the till, the calendar and your site the moment you save.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={submit}>
            {item ? 'Save changes' : `Add ${itemWord}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
          <Input
            label="Name"
            required
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            error={errors.name}
          />
          <Input
            label="Code"
            required
            value={draft.sku}
            onChange={(event) => set('sku', event.target.value.toUpperCase())}
            hint="Short, and unique"
            error={errors.sku}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Kind" htmlFor="kind" hint="A service occupies someone for a length of time.">
            <Select
              id="kind"
              value={draft.kind}
              onChange={(event) => set('kind', event.target.value as ItemKind)}
            >
              <option value="product">Product</option>
              <option value="service">Service</option>
            </Select>
          </Field>
          <Field label={terms.t('catalog_category')} htmlFor="category">
            <Select
              id="category"
              value={draft.categoryId}
              onChange={(event) => set('categoryId', event.target.value)}
            >
              <option value="">Uncategorised</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Price"
            required
            numeric
            inputMode="decimal"
            suffix={currency}
            value={draft.price}
            onChange={(event) => set('price', event.target.value)}
            error={errors.price}
          />
          <Input
            label="Costs you"
            numeric
            inputMode="decimal"
            suffix={currency}
            value={draft.cost}
            onChange={(event) => set('cost', event.target.value)}
            hint="Leave blank and margin cannot be worked out"
            error={errors.cost}
          />
          <Field label="Tax" htmlFor="tax">
            <Select
              id="tax"
              value={String(draft.taxBasisPoints)}
              onChange={(event) => set('taxBasisPoints', Number(event.target.value))}
            >
              {profile.taxRates.map((rate) => (
                <option key={rate.id} value={rate.basisPoints}>{rate.label}</option>
              ))}
            </Select>
          </Field>
        </div>

        {preview && (
          <Card className="bg-surface-sunken" padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 p-4">
              <span className="text-sm text-text-muted">
                {draft.taxIncluded ? 'The price includes tax' : 'Tax is added on top'}
              </span>
              <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <div className="flex items-center gap-1.5">
                  <dt className="text-text-muted">Net</dt>
                  <dd className="tnum font-medium">
                    {formatMoney(money(preview.net, currency), { locale, display: 'none' })}
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-text-muted">You keep</dt>
                  <dd className={cn('tnum font-medium', preview.margin !== null && preview.margin < 0 && 'text-danger-text')}>
                    {preview.margin === null
                      ? 'unknown'
                      : `${formatMoney(money(preview.margin, currency), { locale, display: 'none' })} (${Math.round((preview.rate ?? 0) * 100)}%)`}
                  </dd>
                </div>
              </dl>
            </div>
          </Card>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <Switch
            checked={draft.taxIncluded}
            onChange={(value) => set('taxIncluded', value)}
            label="The price above includes tax"
            description="Shelf and menu prices usually do. Trade price lists usually do not."
          />
          {draft.kind === 'product' && (
            <Switch
              checked={draft.trackStock}
              onChange={(value) => set('trackStock', value)}
              label="Track stock"
              description="Counts down on every sale, and warns you before it runs out."
            />
          )}
          {draft.kind === 'service' && (
            <Input
              label="How long it takes"
              required
              numeric
              inputMode="numeric"
              suffix="min"
              value={draft.durationMinutes}
              onChange={(event) => set('durationMinutes', event.target.value)}
              hint="Decides the slots the calendar offers"
              error={errors.durationMinutes}
            />
          )}
          <Switch
            checked={draft.active}
            onChange={(value) => set('active', value)}
            label="Available to sell"
            description="Turn off to take it off the till without losing its history."
          />
        </div>

        {!draft.cost.trim() && (
          <p className="flex items-start gap-2 text-sm text-text-muted">
            <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
            Without a cost this {itemWord} has no margin, and any period containing it reports no
            margin at all rather than a partial one.
          </p>
        )}
      </div>
    </Dialog>
  )
}
