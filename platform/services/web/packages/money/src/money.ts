import { exponentOf, isKnownCurrency, type CurrencyCode } from './currency'

/**
 * An amount in a currency's smallest unit.
 *
 * Branded so a plain number cannot be passed where an amount is expected.
 * That is the whole defence: the compiler refuses `total + 0.1` and refuses a
 * value that arrived from JSON without going through `parseMinor`.
 */
declare const MinorUnitsBrand: unique symbol
export type MinorUnits = number & { readonly [MinorUnitsBrand]: true }

export interface Money {
  readonly minor: MinorUnits
  readonly currency: CurrencyCode
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * Constructs an amount from a number already known to be an integer count of
 * minor units. Throws rather than coercing, because a fractional minor unit is
 * always a bug upstream and rounding it here would hide the bug.
 */
export function minor(value: number): MinorUnits {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`amount must be a whole number of minor units, got ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`amount ${value} exceeds the safe integer range`)
  }
  return value as MinorUnits
}

export function money(value: number, currency: CurrencyCode): Money {
  if (!isKnownCurrency(currency)) {
    throw new MoneyError(`unknown currency ${JSON.stringify(currency)}`)
  }
  return { minor: minor(value), currency }
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency)
}

/**
 * Parses an amount arriving from the API.
 *
 * The wire form is a string. Protobuf's JSON mapping encodes int64 as a string
 * precisely because JSON numbers are doubles, and a large amount parsed as a
 * double loses its last digits with no error raised. Anything that is not an
 * exact integer within the safe range is rejected here, at the boundary, where
 * the request is still identifiable.
 */
export function parseMinor(value: unknown): MinorUnits {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MoneyError(`amount ${value} is not a whole number of minor units`)
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`amount ${value} exceeds the safe integer range`)
    }
    return value as MinorUnits
  }

  if (typeof value !== 'string') {
    throw new MoneyError(`amount must be a string or integer, got ${typeof value}`)
  }

  const text = value.trim()
  if (!/^-?\d+$/.test(text)) {
    throw new MoneyError(`amount ${JSON.stringify(value)} is not an integer string`)
  }

  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) {
    // Reachable only above 9,007,199,254,740,991 minor units. Guarded anyway:
    // if a market ever mints a currency where that is a plausible total, the
    // failure must be an exception and not a silently wrong receipt.
    throw new MoneyError(`amount ${text} exceeds the safe integer range`)
  }
  return parsed as MinorUnits
}

export function parseMoney(value: unknown): Money {
  if (typeof value !== 'object' || value === null) {
    throw new MoneyError('money must be an object with minor and currency')
  }
  const record = value as Record<string, unknown>
  const currency = record['currency']
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new MoneyError('money is missing its currency code')
  }
  if (!isKnownCurrency(currency)) {
    throw new MoneyError(`unknown currency ${JSON.stringify(currency)}`)
  }
  return { minor: parseMinor(record['minor']), currency }
}

/** Serialises back to the wire form: minor units as a string. */
export function serialiseMoney(value: Money): { minor: string; currency: string } {
  return { minor: String(value.minor), currency: value.currency }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} and ${b.currency}`)
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { minor: minor(a.minor + b.minor), currency: a.currency }
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { minor: minor(a.minor - b.minor), currency: a.currency }
}

export function negateMoney(a: Money): Money {
  return { minor: minor(-a.minor), currency: a.currency }
}

/** Multiplies by a whole count, such as a line quantity. Never by a rate:
 *  rates are basis points and live in the pricing module, which rounds. */
export function multiplyMoney(a: Money, count: number): Money {
  if (!Number.isInteger(count)) {
    throw new MoneyError(`count must be a whole number, got ${count}`)
  }
  return { minor: minor(a.minor * count), currency: a.currency }
}

export function sumMoney(values: readonly Money[], currency?: CurrencyCode): Money {
  if (values.length === 0) {
    if (!currency) throw new MoneyError('cannot sum an empty list without a currency')
    return zero(currency)
  }
  const first = values[0] as Money
  let total = 0
  for (const value of values) {
    assertSameCurrency(first, value)
    total += value.minor
  }
  return { minor: minor(total), currency: first.currency }
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b)
  if (a.minor < b.minor) return -1
  if (a.minor > b.minor) return 1
  return 0
}

export const isZero = (a: Money): boolean => a.minor === 0
export const isNegative = (a: Money): boolean => a.minor < 0
export const isPositive = (a: Money): boolean => a.minor > 0

/**
 * Turns an amount into its exact decimal string, e.g. 1150 BDT -> "11.50",
 * 1270 HUF -> "1270".
 *
 * Done with string surgery rather than division. `minor / 100` is a float
 * operation, and while it is accurate for realistic amounts, allowing it here
 * would put the one division in the codebase in the one file whose job is to
 * not have any.
 */
export function toDecimalString(value: Money): string {
  const exponent = exponentOf(value.currency)
  if (exponent === undefined) {
    throw new MoneyError(`unknown currency ${JSON.stringify(value.currency)}`)
  }
  const sign = value.minor < 0 ? '-' : ''
  const digits = Math.abs(value.minor).toString()
  if (exponent === 0) return sign + digits
  const padded = digits.padStart(exponent + 1, '0')
  const whole = padded.slice(0, padded.length - exponent)
  const fraction = padded.slice(padded.length - exponent)
  return `${sign}${whole}.${fraction}`
}

/**
 * Parses what a merchant typed into a price field.
 *
 * Accepts both separators because a Hungarian keyboard produces "1 270,50" and
 * a numeric keypad produces "1270.50". Rejects more precision than the currency
 * has, rather than rounding it away, so a mistyped price is a visible error
 * instead of a quietly different price.
 */
export function parseDecimalInput(input: string, currency: CurrencyCode): Money {
  const exponent = exponentOf(currency)
  if (exponent === undefined) {
    throw new MoneyError(`unknown currency ${JSON.stringify(currency)}`)
  }

  const cleaned = input.replace(/[\s  ]/g, '').replace(',', '.')
  if (cleaned === '' || cleaned === '-') throw new MoneyError('enter an amount')
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) {
    throw new MoneyError(`${JSON.stringify(input)} is not a valid amount`)
  }

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [wholeRaw = '', fractionRaw = ''] = unsigned.split('.')

  if (fractionRaw.length > exponent) {
    throw new MoneyError(
      exponent === 0
        ? `${currency} has no decimal places`
        : `${currency} has at most ${exponent} decimal place${exponent === 1 ? '' : 's'}`,
    )
  }

  const whole = wholeRaw === '' ? '0' : wholeRaw
  const fraction = fractionRaw.padEnd(exponent, '0')
  const combined = Number(`${whole}${fraction}`)
  if (!Number.isSafeInteger(combined)) {
    throw new MoneyError('amount is too large')
  }
  return money(negative ? -combined : combined, currency)
}
