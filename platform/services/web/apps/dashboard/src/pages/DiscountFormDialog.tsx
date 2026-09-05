import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  HttpError, discounts, type Discount, type DiscountInput, type DiscountKind, type DiscountScope,
} from '@twentyfour/api'
import { MoneyError, parseDecimalInput, serialiseMoney, toDecimalString } from '@twentyfour/money'
import {
  Button, Card, Dialog, Field, Icon, Input, Select, Switch, useFormat, useToast,
} from '@twentyfour/ui'

interface Draft {
  code: string
  name: string
  kind: DiscountKind
  value: string
  scope: DiscountScope
  startsAt: string
  endsAt: string
  usageLimit: string
  perCustomerLimit: string
  minimumBasket: string
  stackable: boolean
  live: boolean
}

const today = () => new Date().toISOString().slice(0, 10)

const EMPTY: Draft = {
  code: '', name: '', kind: 'percent', value: '', scope: 'order',
  startsAt: today(), endsAt: '', usageLimit: '', perCustomerLimit: '',
  minimumBasket: '', stackable: false, live: true,
}

/**
 * Creating and editing a code.
 *
 * The limits are not optional detail: a percentage with no minimum basket can
 * be spent on a coffee to unlock a discount worth more than the sale, and a
 * code with no per-customer limit is a permanent price cut for whoever finds
 * it first. Both are asked for, with the reason stated.
 */
export function DiscountFormDialog({
  discount,
  open,
  onClose,
}: {
  /** null creates a new one. */
  discount: Discount | null
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { currency } = useFormat()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setDraft(
      discount
        ? {
            code: discount.code,
            name: discount.name,
            kind: discount.kind,
            value:
              discount.kind === 'percent'
                ? String(discount.value / 100)
                : discount.kind === 'fixed'
                  ? String(discount.value)
                  : String(discount.value),
            scope: discount.scope,
            startsAt: discount.startsAt.slice(0, 10),
            endsAt: discount.endsAt ? discount.endsAt.slice(0, 10) : '',
            usageLimit: discount.usageLimit === null ? '' : String(discount.usageLimit),
            perCustomerLimit:
              discount.perCustomerLimit === null ? '' : String(discount.perCustomerLimit),
            minimumBasket: discount.minimumBasket ? toDecimalString(discount.minimumBasket) : '',
            stackable: discount.stackable,
            live: discount.status === 'live',
          }
        : EMPTY,
    )
  }, [open, discount])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  const save = useMutation({
    mutationFn: (input: DiscountInput & { status?: Discount['status'] }) =>
      discount ? discounts.update(discount.id, input) : discounts.create(input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: discount ? `${saved.code} saved` : `${saved.code} created`,
        description: saved.status === 'live' ? 'It works at the till now.' : 'Saved as a draft.',
      })
      onClose()
    },
    onError: (error) => {
      if (error instanceof HttpError && error.code === 'code_taken') {
        setErrors((current) => ({ ...current, code: error.message }))
        return
      }
      toast.show({ tone: 'danger', title: 'That did not save', description: error.message })
    },
  })

  const submit = () => {
    const next: Partial<Record<keyof Draft, string>> = {}
    const code = draft.code.trim().toUpperCase()
    if (!code) next.code = 'A code needs something to type.'
    else if (!/^[A-Z0-9]{3,20}$/.test(code)) {
      next.code = 'Letters and numbers only, three to twenty of them.'
    }
    if (!draft.name.trim()) next.name = 'Name it, so you know what it was for later.'

    const raw = Number(draft.value)
    if (!draft.value.trim() || Number.isNaN(raw) || raw <= 0) {
      next.value = 'Enter how much comes off.'
    } else if (draft.kind === 'percent' && raw > 90) {
      next.value = 'Above ninety percent is almost certainly a typo.'
    }

    let minimum = null
    if (draft.minimumBasket.trim()) {
      try {
        minimum = parseDecimalInput(draft.minimumBasket, currency)
      } catch (error) {
        next.minimumBasket = error instanceof MoneyError ? error.message : 'Enter an amount.'
      }
    }

    if (draft.endsAt && draft.endsAt < draft.startsAt) {
      next.endsAt = 'It cannot end before it starts.'
    }

    setErrors(next)
    if (Object.keys(next).length > 0) return

    let value = raw
    if (draft.kind === 'percent') value = Math.round(raw * 100)
    else if (draft.kind === 'fixed') {
      try {
        value = parseDecimalInput(draft.value, currency).minor
      } catch {
        setErrors({ value: 'Enter an amount.' })
        return
      }
    }

    save.mutate({
      code,
      name: draft.name.trim(),
      kind: draft.kind,
      value,
      scope: draft.scope,
      appliesTo: [],
      startsAt: new Date(draft.startsAt).toISOString(),
      endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
      usageLimit: draft.usageLimit.trim() ? Number(draft.usageLimit) : null,
      perCustomerLimit: draft.perCustomerLimit.trim() ? Number(draft.perCustomerLimit) : null,
      minimumBasket: minimum ? serialiseMoney(minimum) : null,
      stackable: draft.stackable,
      status: draft.live ? 'live' : 'draft',
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={discount ? `Edit ${discount.code}` : 'New code'}
      description="Anything you can measure afterwards, you can decide about. Set the limits now."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={submit}>
            {discount ? 'Save changes' : 'Create the code'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1.6fr]">
          <Input
            label="Code"
            required
            className="font-mono"
            value={draft.code}
            onChange={(event) => set('code', event.target.value.toUpperCase())}
            hint="What the customer types"
            error={errors.code}
          />
          <Input
            label="Name"
            required
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            hint="For you, not for them"
            error={errors.name}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Takes off" htmlFor="kind">
            <Select
              id="kind"
              value={draft.kind}
              onChange={(event) => set('kind', event.target.value as DiscountKind)}
            >
              <option value="percent">A percentage</option>
              <option value="fixed">A fixed amount</option>
              <option value="free_item">Buy some, one free</option>
            </Select>
          </Field>
          <Input
            label={draft.kind === 'percent' ? 'How much' : draft.kind === 'fixed' ? 'Amount' : 'Buy how many'}
            required
            numeric
            inputMode="decimal"
            suffix={draft.kind === 'percent' ? '%' : draft.kind === 'fixed' ? currency : undefined}
            value={draft.value}
            onChange={(event) => set('value', event.target.value)}
            error={errors.value}
          />
          <Field label="Applies to" htmlFor="scope">
            <Select
              id="scope"
              value={draft.scope}
              onChange={(event) => set('scope', event.target.value as DiscountScope)}
            >
              <option value="order">The whole basket</option>
              <option value="category">One category</option>
              <option value="item">Chosen items</option>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Starts"
            type="date"
            value={draft.startsAt}
            onChange={(event) => set('startsAt', event.target.value)}
          />
          <Input
            label="Ends"
            type="date"
            value={draft.endsAt}
            onChange={(event) => set('endsAt', event.target.value)}
            hint="Leave blank to run until you stop it"
            error={errors.endsAt}
          />
        </div>

        {/* The three limits that decide whether this is a promotion or a
            permanent price cut. Stated with the reason, because they read like
            optional detail and are not. */}
        <Card className="bg-surface-sunken" padded={false}>
          <p className="border-b border-border px-4 py-2.5 text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
            Limits
          </p>
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
            <Input
              label="Minimum basket"
              numeric
              inputMode="decimal"
              suffix={currency}
              value={draft.minimumBasket}
              onChange={(event) => set('minimumBasket', event.target.value)}
              hint="Stops it being spent on the cheapest thing you sell"
              error={errors.minimumBasket}
            />
            <Input
              label="Total uses"
              numeric
              inputMode="numeric"
              value={draft.usageLimit}
              onChange={(event) => set('usageLimit', event.target.value)}
              hint="Blank is unlimited"
            />
            <Input
              label="Uses per person"
              numeric
              inputMode="numeric"
              value={draft.perCustomerLimit}
              onChange={(event) => set('perCustomerLimit', event.target.value)}
              hint="One makes it a welcome, blank makes it a price"
            />
          </div>
        </Card>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <Switch
            checked={draft.live}
            onChange={(value) => set('live', value)}
            label="Live at the till"
            description="Off saves it as a draft, so you can set it up before it runs."
          />
          <Switch
            checked={draft.stackable}
            onChange={(value) => set('stackable', value)}
            label="Can be combined with another code"
            description="Rarely what you want. Two codes on one basket compound."
          />
        </div>

        {draft.kind === 'percent' && !draft.minimumBasket.trim() && (
          <p className="flex items-start gap-2 text-sm text-warning-text">
            <Icon name="TriangleAlert" size="sm" className="mt-0.5 shrink-0" />
            A percentage with no minimum can be used on your cheapest line. Most codes want a floor.
          </p>
        )}
      </div>
    </Dialog>
  )
}
