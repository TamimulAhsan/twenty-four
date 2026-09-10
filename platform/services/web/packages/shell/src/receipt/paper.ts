/**
 * Receipt paper, and why these numbers.
 *
 * Thermal till printers come in two widths and the trade has settled on both:
 * 80mm for a countertop machine and 58mm for a handheld or a mobile card
 * reader. 80mm is the default here because that is what sits next to a till.
 *
 * The printable width is not the paper width. An 80mm roll prints 72mm and a
 * 58mm roll prints 48mm, the rest being the margin the mechanism cannot reach.
 * Laying out to the paper width instead of the printable one is the classic
 * way to lose the last character of every right-aligned total.
 *
 * The column counts are what a printer's own font gives at those widths: 48
 * characters at 80mm and 32 at 58mm, in the condensed font every driver calls
 * Font B. Matching them matters even though a browser is rendering this rather
 * than the printer's ROM, because a receipt is read as a monospaced grid and
 * dividers that do not reach both edges look like a fault.
 */
export interface Paper {
  readonly id: PaperId
  readonly label: string
  /** Physical roll width, which is what the page size has to be. */
  readonly widthMm: number
  /** What the mechanism can actually mark. */
  readonly printableMm: number
  /** Characters per line in the printer's condensed font. */
  readonly columns: number
}

export type PaperId = '80mm' | '58mm'

export const PAPERS: Record<PaperId, Paper> = {
  '80mm': { id: '80mm', label: '80mm roll', widthMm: 80, printableMm: 72, columns: 48 },
  '58mm': { id: '58mm', label: '58mm roll', widthMm: 58, printableMm: 48, columns: 32 },
}

/** What a countertop till prints unless somebody says otherwise. */
export const DEFAULT_PAPER: PaperId = '80mm'

/** A full-width rule, in the character the trade uses for it. */
export function rule(paper: Paper, char: '=' | '-' = '-'): string {
  return char.repeat(paper.columns)
}

/**
 * One line with something on the left and something on the right.
 *
 * Padded to the column count rather than laid out with flexbox, because that
 * is what makes the decimal points line up down the page and what a receipt
 * looks wrong without. A label too long for the space is truncated rather than
 * allowed to push the amount off the edge: the amount is the part nobody may
 * lose.
 */
export function columns(paper: Paper, left: string, right: string): string {
  const room = paper.columns - right.length - 1
  const label = left.length > room ? `${left.slice(0, Math.max(0, room - 1))}…` : left
  return label.padEnd(Math.max(0, room)) + ' ' + right
}

/** Centres a line, and leaves it alone if it is already too wide to centre. */
export function centre(paper: Paper, text: string): string {
  if (text.length >= paper.columns) return text
  return ' '.repeat(Math.floor((paper.columns - text.length) / 2)) + text
}

/**
 * A row of right-aligned figures under a left-aligned heading.
 *
 * The remainder goes to the last column rather than being left over, so the
 * final figure ends at the paper's edge like every other amount on the receipt.
 * Dividing the width evenly and living with the leftover is what leaves a tax
 * table floating two characters short of the margin, which is exactly the sort
 * of thing that makes a receipt look homemade.
 */
export function figureRow(paper: Paper, heading: string, figures: readonly string[]): string {
  const room = paper.columns - heading.length
  const each = Math.floor(room / figures.length)
  return (
    heading +
    figures
      .map((figure, index) =>
        // The last one absorbs whatever the division left behind.
        figure.padStart(index === figures.length - 1 ? room - each * (figures.length - 1) : each),
      )
      .join('')
  )
}

/**
 * Wraps an item name across lines at the printer's width.
 *
 * On the word where possible, and mid-word only for a word longer than the
 * paper, because a receipt that hyphenates "Cappuccino" reads as a fault while
 * one that wraps a forty-character product code has no other option.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (line) {
        out.push(line)
        line = ''
      }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width))
      continue
    }
    if (!line) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`
    } else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out.length > 0 ? out : ['']
}
