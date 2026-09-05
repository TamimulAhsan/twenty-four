import { useCallback, useMemo, useState } from 'react'
import {
  money,
  priceLine,
  taxBreakdown,
  totalOf,
  zero,
  type Amounts,
  type Line,
  type Money,
} from '@twentyfour/money'
import type { CatalogItem, Order } from '@twentyfour/api'

export interface CartLine {
  readonly key: string
  readonly item: CatalogItem
  readonly quantity: number
  readonly discount: Money | null
}

/**
 * The cart.
 *
 * Prices with the same code the catalog service uses, so the figure on the
 * screen is the figure the receipt will carry. Nothing here divides, rounds or
 * formats: it builds lines and hands them to the pricing module.
 */
export function useCart(currency: string) {
  const [lines, setLines] = useState<CartLine[]>([])
  const [note, setNote] = useState('')

  const add = useCallback((item: CatalogItem) => {
    setLines((current) => {
      const existing = current.find((line) => line.item.id === item.id && line.discount === null)
      if (existing) {
        return current.map((line) =>
          line.key === existing.key ? { ...line, quantity: line.quantity + 1 } : line,
        )
      }
      return [...current, { key: `${item.id}-${current.length}`, item, quantity: 1, discount: null }]
    })
  }, [])

  const setQuantity = useCallback((key: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((line) => line.key !== key)
        : current.map((line) => (line.key === key ? { ...line, quantity } : line)),
    )
  }, [])

  const remove = useCallback((key: string) => {
    setLines((current) => current.filter((line) => line.key !== key))
  }, [])

  const clear = useCallback(() => {
    setLines([])
    setNote('')
  }, [])

  /** Replaces the whole cart, for resuming a parked sale. */
  const load = useCallback((next: CartLine[], nextNote: string) => {
    setLines(next)
    setNote(nextNote)
  }, [])

  const priced = useMemo(() => {
    const pricingLines: Line[] = lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.item.unitPrice,
      taxBasisPoints: line.item.taxBasisPoints,
      taxIncluded: line.item.taxIncluded,
      ...(line.discount ? { discount: line.discount } : {}),
    }))

    const perLine: Amounts[] = pricingLines.map(priceLine)
    const total: Amounts =
      perLine.length > 0
        ? totalOf(perLine)
        : { gross: zero(currency), net: zero(currency), tax: zero(currency) }

    return {
      perLine,
      total,
      // Split by rate, which is what a receipt has to print separately in
      // most jurisdictions and what the day's takings totals against.
      bands: pricingLines.length > 0 ? taxBreakdown(pricingLines) : [],
      count: lines.reduce((sum, line) => sum + line.quantity, 0),
    }
  }, [lines, currency])

  return { lines, note, setNote, add, setQuantity, remove, clear, load, ...priced }
}

/**
 * Rebuilds cart lines from a parked sale.
 *
 * The catalog item is looked up rather than reconstructed from the order line,
 * because the cart prices from the catalog. A line carrying its own copy of a
 * price would keep charging yesterday's figure after somebody corrected it.
 *
 * An item archived since the sale was parked cannot be rebuilt, so it is
 * reported rather than dropped: a tab that quietly comes back one item shorter
 * is worse than one that says what it lost.
 */
export function cartLinesFromOrder(
  order: Order,
  items: readonly CatalogItem[],
): { lines: CartLine[]; missing: string[] } {
  const lines: CartLine[] = []
  const missing: string[] = []

  for (const [index, line] of order.lines.entries()) {
    const item = items.find((candidate) => candidate.id === line.itemId)
    if (!item) {
      missing.push(line.name)
      continue
    }
    lines.push({
      key: `${item.id}-${index}`,
      item,
      quantity: line.quantity,
      discount: line.discount,
    })
  }

  return { lines, missing }
}

/** Sensible cash buttons above the amount due: the exact figure, then the next
 *  round notes a customer is likely to hand over. */
export function cashSuggestions(due: Money, currency: string): Money[] {
  const steps = currency === 'HUF' ? [500, 1000, 2000, 5000, 10_000] : [5_00, 10_00, 20_00, 50_00]
  const out: Money[] = [due]
  for (const step of steps) {
    const rounded = Math.ceil(due.minor / step) * step
    if (rounded > due.minor && !out.some((entry) => entry.minor === rounded)) {
      out.push(money(rounded, currency))
    }
    if (out.length >= 4) break
  }
  return out
}
