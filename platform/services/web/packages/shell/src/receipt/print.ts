import { PAPERS, type PaperId } from './paper'

/**
 * Prints the receipt, at the length of the receipt.
 *
 * Two things here are not obvious and both were bugs.
 *
 * `size: 80mm auto` is invalid CSS and browsers drop the whole declaration.
 * The `size` property takes `auto`, one length, or two: a length paired with
 * `auto` is not a form it has. Written that way the rule parses to nothing but
 * a margin, no page size is applied at all, and the receipt prints on whatever
 * paper the driver last used. It looks right in the stylesheet and does
 * nothing, which is the worst kind of wrong.
 *
 * So the height is measured and written in. That is better than a guess in any
 * case: a fixed page long enough for the longest sale would feed a foot of blank
 * roll after a two-line one, and on a thermal printer that blank is paper the
 * shop paid for.
 */
export function printReceipt(paper: PaperId): void {
  const element = document.querySelector<HTMLElement>('[data-print]')
  const sheet = PAPERS[paper]
  if (!element || !sheet) {
    // Nothing marked for paper. Printing anyway would send the application,
    // which is what this whole module exists to stop.
    return
  }

  // CSS pixels to millimetres, at the 96dpi the CSS unit is defined against.
  // The element is laid out off-screen rather than hidden, which is what makes
  // it measurable at all.
  const mm = element.getBoundingClientRect().height / (96 / 25.4)
  // A floor, so a one-line receipt still produces a page the driver accepts,
  // and a ceiling on the rounding so the last line is never clipped.
  const height = Math.max(40, Math.ceil(mm) + 4)

  const style = document.createElement('style')
  style.setAttribute('data-receipt-page', '')
  style.textContent = `@page receipt { size: ${sheet.widthMm}mm ${height}mm; margin: 0; }`
  document.head.appendChild(style)

  try {
    window.print()
  } finally {
    // Removed straight away: a page size left behind would apply to the next
    // thing printed from this screen, which is how an invoice ends up on a
    // receipt roll.
    style.remove()
  }
}

/**
 * Prints a document at its own page size.
 *
 * Separate from the receipt because an invoice is A4 and goes in an envelope,
 * and because A4 is a page size the stylesheet can state statically: it does
 * not depend on how long the document turned out to be.
 */
export function printDocument(): void {
  if (!document.querySelector('[data-print]')) return
  window.print()
}
