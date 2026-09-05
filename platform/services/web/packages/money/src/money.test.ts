import { describe, expect, it } from 'vitest'
import {
  addMoney,
  formatMoney,
  formatMoneyParts,
  changeDue,
  money,
  MoneyError,
  parseDecimalInput,
  parseMinor,
  parseMoney,
  serialiseMoney,
  sumMoney,
  toDecimalString,
} from './index'

describe('parseMinor', () => {
  // Protobuf's JSON mapping sends int64 as a string, which is the whole reason
  // this function exists rather than a JSON.parse.
  it('accepts the wire form, an integer string', () => {
    expect(parseMinor('1270')).toBe(1270)
    expect(parseMinor('-450')).toBe(-450)
    expect(parseMinor('0')).toBe(0)
  })

  it('accepts a plain integer', () => {
    expect(parseMinor(1270)).toBe(1270)
  })

  it('rejects a decimal string, which is a float that got this far', () => {
    expect(() => parseMinor('12.70')).toThrow(MoneyError)
  })

  it('rejects a fractional number', () => {
    expect(() => parseMinor(12.7)).toThrow(MoneyError)
  })

  it('rejects anything unparseable rather than returning NaN', () => {
    expect(() => parseMinor('abc')).toThrow(MoneyError)
    expect(() => parseMinor('')).toThrow(MoneyError)
    expect(() => parseMinor(null)).toThrow(MoneyError)
    expect(() => parseMinor(undefined)).toThrow(MoneyError)
    expect(() => parseMinor({})).toThrow(MoneyError)
  })

  it('rejects a value that would lose digits as a double', () => {
    expect(() => parseMinor('9007199254740993')).toThrow(MoneyError)
  })
})

describe('parseMoney', () => {
  it('round-trips through the wire form', () => {
    const parsed = parseMoney({ minor: '1270', currency: 'HUF' })
    expect(parsed).toEqual({ minor: 1270, currency: 'HUF' })
    expect(serialiseMoney(parsed)).toEqual({ minor: '1270', currency: 'HUF' })
  })

  it('rejects a currency this build does not know', () => {
    expect(() => parseMoney({ minor: '100', currency: 'XYZ' })).toThrow(MoneyError)
  })

  it('rejects a missing currency rather than assuming one', () => {
    expect(() => parseMoney({ minor: '100' })).toThrow(MoneyError)
  })
})

describe('toDecimalString', () => {
  // HUF has no minor unit in circulation, so 1270 minor units is 1270 forint.
  it('leaves a zero-exponent currency whole', () => {
    expect(toDecimalString(money(1270, 'HUF'))).toBe('1270')
  })

  it('places the point for a two-exponent currency', () => {
    expect(toDecimalString(money(1150, 'BDT'))).toBe('11.50')
    expect(toDecimalString(money(5, 'BDT'))).toBe('0.05')
    expect(toDecimalString(money(-5, 'BDT'))).toBe('-0.05')
    expect(toDecimalString(money(0, 'BDT'))).toBe('0.00')
  })
})

describe('parseDecimalInput', () => {
  it('accepts either separator, because keyboards differ', () => {
    expect(parseDecimalInput('11,50', 'BDT').minor).toBe(1150)
    expect(parseDecimalInput('11.50', 'BDT').minor).toBe(1150)
  })

  it('ignores grouping spaces as typed', () => {
    expect(parseDecimalInput('1 270', 'HUF').minor).toBe(1270)
  })

  it('pads a short fraction', () => {
    expect(parseDecimalInput('11.5', 'BDT').minor).toBe(1150)
  })

  // Rounding a mistyped price would change the price silently. Refusing it
  // shows the merchant what they typed.
  it('rejects more precision than the currency has', () => {
    expect(() => parseDecimalInput('11.505', 'BDT')).toThrow(MoneyError)
    expect(() => parseDecimalInput('1270.5', 'HUF')).toThrow(MoneyError)
  })

  it('rejects text', () => {
    expect(() => parseDecimalInput('free', 'HUF')).toThrow(MoneyError)
    expect(() => parseDecimalInput('', 'HUF')).toThrow(MoneyError)
  })
})

describe('arithmetic', () => {
  it('refuses to mix currencies', () => {
    expect(() => addMoney(money(100, 'HUF'), money(100, 'BDT'))).toThrow(MoneyError)
  })

  it('sums a list', () => {
    expect(sumMoney([money(100, 'HUF'), money(250, 'HUF')]).minor).toBe(350)
  })

  it('needs a currency to sum an empty list', () => {
    expect(sumMoney([], 'HUF').minor).toBe(0)
    expect(() => sumMoney([])).toThrow(MoneyError)
  })
})

describe('changeDue', () => {
  it('returns what the customer gets back', () => {
    expect(changeDue(money(2000, 'HUF'), money(1270, 'HUF')).minor).toBe(730)
  })

  // Negative change is not change, it is a POS bug, and showing it would have
  // a cashier hand over money that was never tendered.
  it('refuses a tender that does not cover the sale', () => {
    expect(() => changeDue(money(1000, 'HUF'), money(1270, 'HUF'))).toThrow()
  })
})

describe('formatMoney', () => {
  it('shows no decimals for HUF, whatever Intl believes ISO 4217 says', () => {
    const formatted = formatMoney(money(1270, 'HUF'), { locale: 'hu-HU' })
    expect(formatted).not.toContain(',00')
    expect(formatted).toMatch(/1.?270/)
  })

  // bn-BD renders Bengali numerals, which is correct for the locale and is
  // what a Bangladeshi merchant expects to read. Pinned here because it is a
  // surprise the first time it appears on a receipt, and because it means
  // digit width cannot be assumed when laying out a printed document.
  it('renders BDT in the locale native numerals', () => {
    const formatted = formatMoney(money(1150, 'BDT'), { locale: 'bn-BD', display: 'code' })
    expect(formatted).toContain('\u09e7\u09e7.\u09eb\u09e6')
  })

  // A merchant who wants Latin digits asks for them through the locale tag,
  // not through a market check in a component.
  it('honours a numbering-system override on the locale tag', () => {
    const formatted = formatMoney(money(1150, 'BDT'), {
      locale: 'bn-BD-u-nu-latn',
      display: 'code',
    })
    expect(formatted).toContain('11.50')
  })

  it('can drop the currency entirely for a column that is already labelled', () => {
    const formatted = formatMoney(money(1270, 'HUF'), { locale: 'hu-HU', display: 'none' })
    expect(formatted).not.toMatch(/Ft|HUF/)
  })

  it('splits into parts so a till can size the symbol separately', () => {
    const parts = formatMoneyParts(money(1270, 'HUF'), { locale: 'hu-HU' })
    expect(parts.some((part) => part.type === 'currency')).toBe(true)
    expect(parts.map((part) => part.value).join('')).toBe(
      formatMoney(money(1270, 'HUF'), { locale: 'hu-HU' }),
    )
  })
})
