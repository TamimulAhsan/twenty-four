import { describe, expect, it } from 'vitest'
import { PAPERS, centre, columns, figureRow, rule, wrap } from './paper'

const wide = PAPERS['80mm']
const narrow = PAPERS['58mm']

describe('receipt paper', () => {
  it('lays out to the printable width, not the roll width', () => {
    // An 80mm roll prints 72mm. Laying out to 80 is how the last character of
    // every right-aligned total ends up off the paper.
    expect(wide.printableMm).toBeLessThan(wide.widthMm)
    expect(narrow.printableMm).toBeLessThan(narrow.widthMm)
  })

  it('uses the column counts a printer actually gives at those widths', () => {
    expect(wide.columns).toBe(48)
    expect(narrow.columns).toBe(32)
  })
})

describe('a two-column line', () => {
  it('ends every amount in the same column', () => {
    // This is the whole reason the receipt is a monospaced grid: a column of
    // amounts that does not line up reads as a fault whatever the figures say.
    const lines = [
      columns(wide, 'Cortado', '1 560'),
      columns(wide, 'Sandwich with salad', '890'),
      columns(wide, 'TOTAL', '2 450'),
    ]
    for (const line of lines) expect(line).toHaveLength(wide.columns)
  })

  it('truncates the label rather than pushing the amount off the edge', () => {
    // The amount is the part nobody may lose. A name too long for the paper is
    // a name that gets shortened.
    const line = columns(narrow, 'A product with an extremely long name', '12 000')
    expect(line).toHaveLength(narrow.columns)
    expect(line.endsWith('12 000')).toBe(true)
    expect(line).toContain('…')
  })
})

describe('a rule', () => {
  it('reaches both edges', () => {
    // One that stops short looks like a rendering fault rather than a divider.
    expect(rule(wide, '=')).toHaveLength(wide.columns)
    expect(rule(narrow, '-')).toHaveLength(narrow.columns)
  })
})

describe('centring', () => {
  it('centres within the paper', () => {
    const line = centre(wide, 'THANK YOU')
    expect(line.trimStart()).toBe('THANK YOU')
    // Within a character of centre, since an odd remainder has to go somewhere.
    const padding = line.length - line.trimStart().length
    expect(Math.abs(padding - (wide.columns - 'THANK YOU'.length) / 2)).toBeLessThanOrEqual(1)
  })

  it('leaves a line alone when it is already too wide to centre', () => {
    const long = 'X'.repeat(narrow.columns + 5)
    expect(centre(narrow, long)).toBe(long)
  })
})

describe('wrapping an item name', () => {
  it('breaks on words', () => {
    expect(wrap('Flat white with oat milk', 12)).toEqual(['Flat white', 'with oat', 'milk'])
  })

  it('breaks mid-word only when a word is wider than the paper', () => {
    // Hyphenating "Cappuccino" reads as a fault. A forty-character product
    // code has no other option.
    expect(wrap('Cappuccino', 20)).toEqual(['Cappuccino'])
    expect(wrap('ABCDEFGHIJKLMNOP', 8)).toEqual(['ABCDEFGH', 'IJKLMNOP'])
  })

  it('never returns nothing, so a blank name still occupies its line', () => {
    expect(wrap('', 10)).toEqual([''])
  })
})

describe('a row of figures', () => {
  it('ends the last column at the edge', () => {
    // Dividing the width evenly and living with the leftover leaves a tax table
    // floating short of the margin while every other amount reaches it, which
    // is the sort of thing that makes a receipt look homemade.
    for (const paper of [wide, narrow]) {
      const head = figureRow(paper, 'RATE  ', ['NET', 'TAX', 'GROSS'])
      const row = figureRow(paper, '27%'.padEnd(6), ['5 929', '1 601', '7 530'])
      expect(head).toHaveLength(paper.columns)
      expect(row).toHaveLength(paper.columns)
      expect(head.endsWith('GROSS')).toBe(true)
      expect(row.endsWith('7 530')).toBe(true)
    }
  })
})
