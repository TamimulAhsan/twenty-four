/**
 * Ported from platform/services/catalog/internal/pricing/pricing_test.go.
 *
 * These are the same cases with the same expected figures. They exist twice on
 * purpose: the till prices a cart with this code and the receipt is issued by
 * that code, and a customer holding the printout next to the screen is
 * entitled to see one number. If one suite is changed without the other, that
 * guarantee is gone and nothing else will notice.
 */
import { describe, expect, it } from 'vitest'
import { money, MoneyError } from './money'
import { priceLine, PricingError, taxBreakdown, totalOf, type Amounts } from './pricing'

const huf = (amount: number) => money(amount, 'HUF')
const bdt = (amount: number) => money(amount, 'BDT')

describe('priceLine', () => {
  // Hungarian menu prices are gross: the customer sees 1270 HUF and 27% VAT is
  // already inside it. HUF has no minor unit, so these are whole forint.
  it('derives net from a tax-inclusive HUF price', () => {
    const amounts = priceLine({
      quantity: 1,
      unitPrice: huf(1270),
      taxBasisPoints: 2700,
      taxIncluded: true,
    })
    // 1270 / 1.27 = 1000 exactly.
    expect(amounts.gross.minor).toBe(1270)
    expect(amounts.net.minor).toBe(1000)
    expect(amounts.tax.minor).toBe(270)
  })

  it('adds tax to a tax-exclusive price', () => {
    const amounts = priceLine({
      quantity: 2,
      unitPrice: bdt(500),
      taxBasisPoints: 1500,
      taxIncluded: false,
    })
    expect(amounts.net.minor).toBe(1000)
    expect(amounts.tax.minor).toBe(150)
    expect(amounts.gross.minor).toBe(1150)
  })

  // The rounding rule is the point of this test: truncation returns 786.
  it('rounds half away from zero', () => {
    const amounts = priceLine({
      quantity: 1,
      unitPrice: huf(999),
      taxBasisPoints: 2700,
      taxIncluded: true,
    })
    // 999 * 10000 / 12700 = 786.61... so net is 787 and tax is 212.
    expect(amounts.net.minor).toBe(787)
    expect(amounts.tax.minor).toBe(212)
    expect(amounts.net.minor + amounts.tax.minor).toBe(amounts.gross.minor)
  })

  // Whatever the rounding, a line must always reconcile internally.
  it('always reconciles net plus tax to gross', () => {
    for (let price = 1; price <= 3000; price++) {
      for (const rate of [0, 500, 1800, 2700]) {
        const amounts = priceLine({
          quantity: 1,
          unitPrice: huf(price),
          taxBasisPoints: rate,
          taxIncluded: true,
        })
        expect(
          amounts.net.minor + amounts.tax.minor,
          `price ${price} at ${rate}bp`,
        ).toBe(amounts.gross.minor)
      }
    }
  })

  it('applies a discount before tax is derived', () => {
    const amounts = priceLine({
      quantity: 2,
      unitPrice: huf(1000),
      taxBasisPoints: 2700,
      taxIncluded: true,
      discount: huf(500),
    })
    expect(amounts.gross.minor).toBe(1500)
  })

  it('rejects a zero quantity', () => {
    expect(() =>
      priceLine({ quantity: 0, unitPrice: huf(100), taxBasisPoints: 0, taxIncluded: true }),
    ).toThrow(PricingError)
  })

  it('rejects a fractional quantity', () => {
    expect(() =>
      priceLine({ quantity: 1.5, unitPrice: huf(100), taxBasisPoints: 0, taxIncluded: true }),
    ).toThrow(PricingError)
  })

  it('rejects an unknown currency', () => {
    // Construction refuses it first, which is the boundary that matters.
    expect(() => money(100, 'XYZ')).toThrow(MoneyError)
    // And priceLine refuses it too, for a value that reached it another way.
    const smuggled = { minor: 100, currency: 'XYZ' } as ReturnType<typeof huf>
    expect(() =>
      priceLine({ quantity: 1, unitPrice: smuggled, taxBasisPoints: 0, taxIncluded: true }),
    ).toThrow(PricingError)
  })

  it('rejects a discount larger than the line', () => {
    expect(() =>
      priceLine({
        quantity: 1,
        unitPrice: huf(100),
        taxBasisPoints: 0,
        taxIncluded: true,
        discount: huf(500),
      }),
    ).toThrow(PricingError)
  })

  it('rejects an absurd tax rate', () => {
    expect(() =>
      priceLine({
        quantity: 1,
        unitPrice: huf(100),
        taxBasisPoints: 200_000,
        taxIncluded: true,
      }),
    ).toThrow(PricingError)
  })

  it('rejects a discount in a different currency from the line', () => {
    expect(() =>
      priceLine({
        quantity: 1,
        unitPrice: huf(1000),
        taxBasisPoints: 2700,
        taxIncluded: true,
        discount: bdt(100),
      }),
    ).toThrow(PricingError)
  })
})

describe('totalOf', () => {
  // Summing rounded lines is what makes a receipt add up. Deriving tax from the
  // gross total instead can differ by a unit or two, which is enough to fail
  // an audit.
  it('sums rounded lines rather than re-deriving from the total', () => {
    const lines: Amounts[] = Array.from({ length: 3 }, () =>
      priceLine({
        quantity: 1,
        unitPrice: huf(999),
        taxBasisPoints: 2700,
        taxIncluded: true,
      }),
    )
    const total = totalOf(lines)
    expect(total.gross.minor).toBe(2997)
    expect(total.net.minor).toBe(2361)
    expect(total.tax.minor).toBe(636)
    expect(total.net.minor + total.tax.minor).toBe(total.gross.minor)
  })

  it('rejects a mixed-currency total', () => {
    const hufLine = priceLine({
      quantity: 1,
      unitPrice: huf(100),
      taxBasisPoints: 0,
      taxIncluded: true,
    })
    const bdtLine = priceLine({
      quantity: 1,
      unitPrice: bdt(100),
      taxBasisPoints: 0,
      taxIncluded: true,
    })
    expect(() => totalOf([hufLine, bdtLine])).toThrow(PricingError)
  })

  it('rejects an empty total', () => {
    expect(() => totalOf([])).toThrow(PricingError)
  })
})

describe('taxBreakdown', () => {
  it('groups by rate and sorts ascending', () => {
    const breakdown = taxBreakdown([
      { quantity: 1, unitPrice: huf(1270), taxBasisPoints: 2700, taxIncluded: true },
      { quantity: 1, unitPrice: huf(1050), taxBasisPoints: 500, taxIncluded: true },
      { quantity: 2, unitPrice: huf(1270), taxBasisPoints: 2700, taxIncluded: true },
    ])
    expect(breakdown.map((band) => band.basisPoints)).toEqual([500, 2700])
    // 1270 + 2540 gross at 27%.
    expect(breakdown[1]?.gross.minor).toBe(3810)
  })
})
