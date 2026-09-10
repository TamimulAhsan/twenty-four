import { createPortal } from 'react-dom'
import { formatMoney, type Money } from '@twentyfour/money'
import { useFormat } from '@twentyfour/ui'
import { useBootstrap } from '@twentyfour/runtime'
import type { Takings } from '@twentyfour/api'
import { PAPERS, centre, columns, figureRow, rule, type PaperId } from './paper'

/**
 * The day's figures, on the same roll as the receipts.
 *
 * A till's day report goes to the printer beside it rather than to an office
 * printer, so it is the same 80mm grid rather than a page. It also has to be
 * kept: this is the sheet that goes in the drawer with the cash, and it is what
 * a manager reconciles against in the morning.
 */
export function PrintableDayReport({
  takings,
  date,
  paper = '80mm',
}: {
  takings: Takings
  date: string
  paper?: PaperId
}) {
  const { profile } = useBootstrap()
  const { locale, currency } = useFormat()
  const sheet = PAPERS[paper]
  const amount = (value: Money) => formatMoney(value, { locale, display: 'none' })

  const lines: string[] = []
  const push = (text = '') => lines.push(text)

  push(centre(sheet, profile.name.toUpperCase()))
  push(centre(sheet, 'DAY REPORT'))
  push(centre(sheet, new Date(date).toLocaleDateString(locale)))
  push()
  push(rule(sheet, '='))

  push(columns(sheet, 'Sales', String(takings.orderCount)))
  push(columns(sheet, 'Taken', `${amount(takings.gross)} ${currency}`))
  if (takings.refunded.minor > 0) {
    push(columns(sheet, 'Refunded', amount(takings.refunded)))
  }
  push(rule(sheet, '-'))

  push('BY METHOD')
  for (const row of takings.byMethod) {
    push(columns(sheet, capitalise(row.method.replace(/_/g, ' ')), amount(row.amount)))
  }

  if (takings.byTaxBand.length > 0) {
    push(rule(sheet, '-'))
    push('BY TAX BAND')
    push(figureRow(sheet, 'RATE  ', ['NET', 'TAX', 'GROSS']))
    for (const band of takings.byTaxBand) {
      push(
        figureRow(sheet, `${band.basisPoints / 100}%`.padEnd(6), [
          amount(band.net),
          amount(band.tax),
          amount(band.gross),
        ]),
      )
    }
  }

  push(rule(sheet, '='))
  // Space to write in, because the drawer is counted by hand and this sheet is
  // what the count is written on before anybody types it into anything.
  push(columns(sheet, 'Cash expected', amount(cashOf(takings))))
  push(columns(sheet, 'Cash counted', '_'.repeat(12)))
  push(columns(sheet, 'Difference', '_'.repeat(12)))
  push()
  push(columns(sheet, 'Counted by', '_'.repeat(16)))
  push()
  push()
  push()

  return createPortal(
    <pre
      data-print
      data-paper={paper}
      className="receipt-paper"
      aria-hidden="true"
    >
      {lines.join('\n')}
    </pre>,
    document.body,
  )
}

/**
 * What should be in the drawer.
 *
 * From what was actually tendered in cash, never from the day's total: a card
 * sale never touched the drawer, and counting it would make every honest till
 * look short by exactly the card takings.
 */
function cashOf(takings: Takings): Money {
  const row = takings.byMethod.find((entry) => entry.method === 'cash')
  return row?.amount ?? takings.gross
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
