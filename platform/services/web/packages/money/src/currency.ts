/**
 * How many decimal places a currency's minor unit represents.
 *
 * Mirrors `exponent` in platform/services/catalog/internal/pricing/pricing.go.
 * The two tables must agree; a currency present in one and not the other is a
 * bug in whichever was edited last.
 *
 * HUF is 0. The fillér left circulation, so a forint has no subunit and
 * "minor units" for HUF are just forint. Treating it as 2 overstates every
 * amount by a factor of one hundred, and does so silently.
 */
const EXPONENT: Readonly<Record<string, number>> = {
  HUF: 0,
  BDT: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
}

/** ISO 4217 alphabetic code. Not narrowed to the known set: an environment
 *  may be stood up for a market whose currency this build predates, and that
 *  must fail loudly at the boundary rather than at compile time. */
export type CurrencyCode = string

export function exponentOf(currency: CurrencyCode): number | undefined {
  return EXPONENT[currency]
}

export function isKnownCurrency(currency: CurrencyCode): boolean {
  return currency in EXPONENT
}

export function knownCurrencies(): CurrencyCode[] {
  return Object.keys(EXPONENT)
}
