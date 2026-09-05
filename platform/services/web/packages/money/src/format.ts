/**
 * Display formatting for amounts.
 *
 * Locale is always passed in. It comes from the tenant's business profile,
 * never from a country check and never from the browser: a Hungarian merchant
 * serving a German tourist still reads their own till in Hungarian. There is
 * no market branch anywhere in this file.
 */
import { exponentOf } from './currency'
import { toDecimalString, type Money } from './money'

export interface FormatMoneyOptions {
  /** BCP 47 tag from the tenant profile, e.g. "hu-HU". */
  locale: string
  /** "symbol" gives "1 270 Ft", "code" gives "1 270 HUF", "none" gives "1 270". */
  display?: 'symbol' | 'code' | 'none'
  /** Renders 1 240 000 as "1,24 M". For stat tiles only: a figure a merchant
   *  might reconcile against their bank must never be abbreviated. */
  compact?: boolean
  /** Prefixes a non-negative amount with "+". Used on adjustments and refunds
   *  where direction matters more than magnitude. */
  signed?: boolean
}

function fractionDigits(currency: string): number {
  const exponent = exponentOf(currency)
  if (exponent === undefined) {
    throw new Error(`unknown currency ${JSON.stringify(currency)}`)
  }
  return exponent
}

function baseOptions(value: Money, options: FormatMoneyOptions): Intl.NumberFormatOptions {
  const digits = fractionDigits(value.currency)
  const display = options.display ?? 'symbol'

  const shared: Intl.NumberFormatOptions = {
    // Overriding both is deliberate. Intl believes HUF has two decimals
    // because ISO 4217 says so on paper, but the fillér is not in
    // circulation, so a Hungarian till showing "1 270,00 Ft" is wrong.
    // The exponent table is the authority here, not the runtime's.
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }

  if (options.compact) {
    shared.notation = 'compact'
    shared.compactDisplay = 'short'
    shared.maximumFractionDigits = 1
    shared.minimumFractionDigits = 0
  }

  if (display === 'none') return shared
  return {
    ...shared,
    style: 'currency',
    currency: value.currency,
    currencyDisplay: display === 'code' ? 'code' : 'narrowSymbol',
  }
}

/**
 * Formats from the exact decimal string rather than a divided number.
 *
 * Intl.NumberFormat accepts a string and formats it without going through a
 * double, so nothing here can lose a digit. Older runtimes that reject the
 * string argument fall back to a number, which is accurate for every amount a
 * merchant will realistically see and is the only lossy path in the package.
 */
function formatExact(decimal: string, locale: string, options: Intl.NumberFormatOptions): string {
  const formatter = new Intl.NumberFormat(locale, options)
  try {
    return formatter.format(decimal as unknown as number)
  } catch {
    return formatter.format(Number(decimal))
  }
}

export function formatMoney(value: Money, options: FormatMoneyOptions): string {
  const decimal = toDecimalString(value)
  const formatted = formatExact(decimal, options.locale, baseOptions(value, options))
  if (options.signed && value.minor > 0) return `+${formatted}`
  return formatted
}

/**
 * Splits a formatted amount so a till can set the currency symbol at a
 * different size from the figure. Order is preserved, so it stays correct in
 * a locale that leads with the symbol and one that trails it.
 */
export function formatMoneyParts(
  value: Money,
  options: FormatMoneyOptions,
): Array<{ type: Intl.NumberFormatPartTypes; value: string }> {
  const decimal = toDecimalString(value)
  const formatter = new Intl.NumberFormat(options.locale, baseOptions(value, options))
  try {
    return formatter.formatToParts(decimal as unknown as number)
  } catch {
    return formatter.formatToParts(Number(decimal))
  }
}

export function formatNumber(
  value: number,
  locale: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

/** Takes a fraction, so 0.62 renders as "62%". */
export function formatPercent(fraction: number, locale: string, digits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction)
}

/** Change owed on a cash tender. Throws if the tender does not cover the sale,
 *  because that is a POS bug and must not be shown as negative change. */
export function changeDue(tendered: Money, due: Money): Money {
  if (tendered.currency !== due.currency) {
    throw new Error(`cannot tender ${tendered.currency} against a ${due.currency} sale`)
  }
  if (tendered.minor < due.minor) {
    throw new Error('tendered amount does not cover the amount due')
  }
  return { minor: (tendered.minor - due.minor) as Money['minor'], currency: due.currency }
}
