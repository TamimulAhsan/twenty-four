/**
 * Turns catalog prices into the exact figures a sale is made of.
 *
 * A line-for-line port of platform/services/catalog/internal/pricing/pricing.go.
 * The two implementations must return identical figures for identical input:
 * the till shows this one and the receipt is issued from that one, and a
 * customer comparing them is entitled to see the same number.
 *
 * The Go test cases are ported alongside in pricing.test.ts for that reason.
 * If you change a rule here, change it there, and run both suites.
 */
import { exponentOf, type CurrencyCode } from './currency'
import { minor, money, type Money, type MinorUnits } from './money'

export type PricingErrorCode =
  | 'currency'
  | 'mismatch'
  | 'quantity'
  | 'tax_rate'
  | 'discount_high'
  | 'discount_negative'
  | 'empty'

export class PricingError extends Error {
  readonly code: PricingErrorCode
  constructor(code: PricingErrorCode, message: string) {
    super(message)
    this.name = 'PricingError'
    this.code = code
  }
}

/** One row of a sale, priced from a catalog item. */
export interface Line {
  readonly quantity: number
  readonly unitPrice: Money
  /** Basis points, so 27% is 2700. Integers avoid the float problem in the
   *  multiplier as well as in the amount. */
  readonly taxBasisPoints: number
  /** Whether unitPrice already contains the tax. */
  readonly taxIncluded: boolean
  /** Applied to the line before tax is derived. Same currency as unitPrice. */
  readonly discount?: Money
}

/** The derived figures for a line or for a whole sale. */
export interface Amounts {
  /** What the customer pays. */
  readonly gross: Money
  /** Gross less tax. */
  readonly net: Money
  readonly tax: Money
}

/**
 * Divides and rounds half away from zero, which is the rule most European tax
 * regimes state. Truncation would quietly under-collect tax on roughly half of
 * all lines.
 *
 * Arithmetic is in BigInt because the intermediate `gross * 10000` can leave
 * the double-safe range for a large amount in a zero-exponent currency, and an
 * amount that silently loses its last digits is exactly what this file exists
 * to prevent.
 */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new PricingError('tax_rate', 'division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const num = numerator < 0n ? -numerator : numerator
  const den = denominator < 0n ? -denominator : denominator
  const quotient = (num + den / 2n) / den
  return negative ? -quotient : quotient
}

function toSafe(value: bigint): MinorUnits {
  const asNumber = Number(value)
  if (!Number.isSafeInteger(asNumber)) {
    throw new PricingError('currency', `computed amount ${value} exceeds the safe integer range`)
  }
  return minor(asNumber)
}

/**
 * Computes one line's amounts.
 *
 * Rounding happens exactly once, at the line, on the tax figure. Rounding per
 * line and then summing is what a tax authority expects and what a printed
 * receipt has to add up to. Deriving tax from an order total instead produces
 * receipts whose lines do not sum to their own total.
 */
export function priceLine(line: Line): Amounts {
  const currency = line.unitPrice.currency
  if (exponentOf(currency) === undefined) {
    throw new PricingError('currency', `unknown currency ${JSON.stringify(currency)}`)
  }
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new PricingError('quantity', 'quantity must be a positive whole number')
  }
  if (
    !Number.isInteger(line.taxBasisPoints) ||
    line.taxBasisPoints < 0 ||
    line.taxBasisPoints > 100_000
  ) {
    throw new PricingError('tax_rate', `tax rate out of range: ${line.taxBasisPoints}`)
  }

  const discount = line.discount
  if (discount) {
    if (discount.currency !== currency) {
      throw new PricingError(
        'mismatch',
        `discount is ${discount.currency} on a ${currency} line`,
      )
    }
    if (discount.minor < 0) {
      throw new PricingError('discount_negative', 'discount must not be negative')
    }
  }

  const base = BigInt(line.unitPrice.minor) * BigInt(line.quantity)
  const discountMinor = BigInt(discount?.minor ?? 0)
  if (discountMinor > base) {
    throw new PricingError(
      'discount_high',
      `discount ${discountMinor} exceeds line total ${base}`,
    )
  }

  const subject = base - discountMinor
  const rate = BigInt(line.taxBasisPoints)

  let gross: bigint
  let net: bigint
  let tax: bigint

  if (line.taxIncluded) {
    // The price already contains tax: net = gross * 10000 / (10000 + rate).
    gross = subject
    net = divRoundHalfUp(gross * 10_000n, 10_000n + rate)
    tax = gross - net
  } else {
    net = subject
    tax = divRoundHalfUp(net * rate, 10_000n)
    gross = net + tax
  }

  return {
    gross: { minor: toSafe(gross), currency },
    net: { minor: toSafe(net), currency },
    tax: { minor: toSafe(tax), currency },
  }
}

/**
 * Sums already-priced lines.
 *
 * Summing rounded lines, rather than re-deriving tax from the gross total, is
 * what keeps a receipt's lines adding up to its total. The two can differ by a
 * unit or two, which is enough to fail an audit.
 */
export function totalOf(amounts: readonly Amounts[]): Amounts {
  const first = amounts[0]
  if (!first) throw new PricingError('empty', 'no lines to total')

  const currency = first.gross.currency
  let gross = 0
  let net = 0
  let tax = 0

  for (const amount of amounts) {
    if (
      amount.gross.currency !== currency ||
      amount.net.currency !== currency ||
      amount.tax.currency !== currency
    ) {
      throw new PricingError('mismatch', `cannot total ${currency} with ${amount.gross.currency}`)
    }
    gross += amount.gross.minor
    net += amount.net.minor
    tax += amount.tax.minor
  }

  return {
    gross: money(gross, currency),
    net: money(net, currency),
    tax: money(tax, currency),
  }
}

/** Prices every line and returns both the lines and their total, which is what
 *  a cart, a quote and an invoice preview all need at once. */
export function priceLines(lines: readonly Line[]): { lines: Amounts[]; total: Amounts } {
  const priced = lines.map(priceLine)
  return { lines: priced, total: totalOf(priced) }
}

/** Splits a total by tax rate, which is what a receipt's tax summary shows and
 *  what most tax authorities require to be printed separately. */
export function taxBreakdown(
  lines: readonly Line[],
): Array<{ basisPoints: number; net: Money; tax: Money; gross: Money }> {
  const byRate = new Map<number, Amounts[]>()
  for (const line of lines) {
    const bucket = byRate.get(line.taxBasisPoints)
    const amounts = priceLine(line)
    if (bucket) bucket.push(amounts)
    else byRate.set(line.taxBasisPoints, [amounts])
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([basisPoints, amounts]) => {
      const summed = totalOf(amounts)
      return { basisPoints, net: summed.net, tax: summed.tax, gross: summed.gross }
    })
}

/** Formats a rate for display: 2700 becomes "27%", 1250 becomes "12.5%". */
export function formatTaxRate(basisPoints: number, locale: string): string {
  const percent = basisPoints / 100
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(percent)}%`
}

export type { CurrencyCode }
