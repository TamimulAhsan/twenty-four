import { createPortal } from 'react-dom'
import { formatMoney, type Money } from '@twentyfour/money'
import { useFormat } from '@twentyfour/ui'
import { useBootstrap } from '@twentyfour/runtime'
import { useTerms } from '@twentyfour/terms'
import type { Order } from '@twentyfour/api'
import { PAPERS, centre, columns, figureRow, rule, wrap, type PaperId } from './paper'

/**
 * The document a customer is handed.
 *
 * Laid out as a monospaced grid at the printer's own column count rather than
 * with the application's type and spacing, because that is what a receipt is:
 * every amount ends in the same column, dividers reach both edges, and the
 * whole thing survives being printed by a mechanism that knows nothing but
 * characters.
 *
 * Rendered from the order the server returned, never from the cart that was on
 * screen a moment ago. If the two disagree the server is right, and this is
 * where that shows.
 */
export function useReceiptLines(order: Order, paper: PaperId): string[] {
  const { profile } = useBootstrap()
  const { locale, currency } = useFormat()
  const terms = useTerms()
  const sheet = PAPERS[paper]

  /** Amounts without the currency symbol: the receipt states it once, at the
   *  foot, which is what keeps the number column narrow enough to read. */
  const amount = (value: Money) => formatMoney(value, { locale, display: 'none' })

  const lines: string[] = []
  const push = (text = '') => lines.push(text)

  // --- who issued it ------------------------------------------------------
  // First, and not decoration: a document that does not say who issued it is
  // not a receipt in any market this platform is deployed in.
  push(centre(sheet, profile.name.toUpperCase()))
  if (profile.address) push(centre(sheet, profile.address))
  if (profile.city) push(centre(sheet, profile.city))
  if (profile.taxId) push(centre(sheet, profile.taxId))
  push()
  push(rule(sheet, '='))

  // --- which sale ---------------------------------------------------------
  const placed = new Date(order.placedAt)
  push(columns(sheet, terms.t('receipt'), order.number))
  push(
    columns(
      sheet,
      placed.toLocaleDateString(locale),
      placed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    ),
  )
  push(rule(sheet, '='))

  // --- what was sold ------------------------------------------------------
  // The quantity leads the name and the amount closes the line, which is the
  // order a person scans in: what, how many, how much.
  for (const line of order.lines) {
    const money = amount(line.gross)
    const head = `${line.quantity} x `
    const room = sheet.columns - money.length - 1 - head.length
    const [first, ...rest] = wrap(line.name, Math.max(8, room))
    push(columns(sheet, head + (first ?? ''), money))
    // A wrapped name is indented under itself so the column of amounts is
    // never interrupted by a stray word starting at the margin.
    for (const part of rest) push(' '.repeat(head.length) + part)
  }
  push(rule(sheet, '-'))

  // --- what it came to ----------------------------------------------------
  const net = amount(order.net)
  const tax = amount(order.tax)
  if (order.tax.minor !== 0) {
    push(columns(sheet, 'Subtotal', net))
    push(columns(sheet, 'Tax', tax))
  }
  push(rule(sheet, '='))
  push(columns(sheet, 'TOTAL', `${amount(order.gross)} ${currency}`))
  push(rule(sheet, '='))

  // --- how it was paid ----------------------------------------------------
  for (const tender of order.tenders) {
    const label = tender.method.replace(/_/g, ' ')
    // What was handed over, not what was applied. A receipt reading
    // "Cash 1 560 / Change 440" does not reconcile for the person holding it:
    // they gave you 2 000.
    push(columns(sheet, capitalise(label), amount(tender.tendered ?? tender.amount)))
    if (tender.change && tender.change.minor > 0) {
      push(columns(sheet, 'Change', amount(tender.change)))
    }
  }

  // --- the tax breakdown --------------------------------------------------
  // Per rate, because a receipt whose bands do not sum to its own total fails
  // an audit, and most regimes require them shown separately in any case.
  const bands = new Map<number, { net: number; tax: number; gross: number }>()
  for (const line of order.lines) {
    const row = bands.get(line.taxBasisPoints) ?? { net: 0, tax: 0, gross: 0 }
    row.net += line.net.minor
    row.tax += line.tax.minor
    row.gross += line.gross.minor
    bands.set(line.taxBasisPoints, row)
  }
  if (bands.size > 0 && order.tax.minor !== 0) {
    push()
    push(rule(sheet, '-'))
    push('TAX BREAKDOWN')
    push(figureRow(sheet, 'RATE  ', ['NET', 'TAX', 'GROSS']))
    for (const [rate, row] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
      const money = (minor: number) =>
        formatMoney({ minor, currency } as Money, { locale, display: 'none' })
      push(
        figureRow(sheet, `${rate / 100}%`.padEnd(6), [
          money(row.net),
          money(row.tax),
          money(row.gross),
        ]),
      )
    }
  }

  // --- the foot -----------------------------------------------------------
  push()
  push(centre(sheet, 'Thank you'))
  if (profile.taxId) push(centre(sheet, 'Please keep this receipt'))
  // Trailing blank lines so the cut falls below the last text rather than
  // through it: a mechanism cuts a fixed distance past the print head.
  push()
  push()
  push()

  return lines
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The receipt as a cashier sees it before printing.
 *
 * Deliberately not marked for print. The copy that prints is the portal below,
 * and marking both would hand the customer the same document twice.
 */
export function ReceiptPreview({ order, paper }: { order: Order; paper: PaperId }) {
  const lines = useReceiptLines(order, paper)
  return (
    <pre className="receipt-paper">
      {lines.join('\n')}
    </pre>
  )
}

/**
 * The copy that actually prints, rendered into the document body rather than
 * into the dialog it was opened from.
 *
 * The dialog is a native <dialog> opened with showModal(), which puts it in the
 * top layer. Printing from inside the top layer is inconsistent between
 * browsers and versions, and an absolutely positioned child of it resolves
 * against the dialog rather than the page. Neither is a thing to discover from
 * a customer holding half a receipt, so the print copy sidesteps both: it lives
 * at the end of body, hidden on screen, and the print stylesheet reveals it.
 */
export function PrintableReceipt({ order, paper }: { order: Order; paper: PaperId }) {
  const lines = useReceiptLines(order, paper)
  return createPortal(
    <pre
      data-print
      data-paper={paper}
      className="receipt-paper"
      // Off the screen rather than display:none, because a browser does not
      // lay out what it is not displaying and the print stylesheet needs
      // something with a size to reveal.
      aria-hidden="true"
    >
      {lines.join('\n')}
    </pre>,
    document.body,
  )
}
