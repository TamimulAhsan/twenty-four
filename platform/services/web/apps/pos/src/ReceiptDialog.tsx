import type { Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { useState } from 'react'
import { Button, Dialog, Input, MoneyText, useDateFormat, useToast } from '@twentyfour/ui'
import { useBootstrap } from '@twentyfour/runtime'

/**
 * What the customer is handed.
 *
 * Rendered from the order the server returned, not from the cart that was on
 * screen a moment ago. If the two ever disagree, the server is right and this
 * is where it shows.
 */
export function ReceiptDialog({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const terms = useTerms()
  const toast = useToast()
  const dates = useDateFormat()
  const { profile } = useBootstrap()
  const [emailing, setEmailing] = useState(false)
  const [address, setAddress] = useState('')

  const send = () => {
    // Through the Notification service, which owns the template and the
    // branding. The till only supplies the address and the document.
    toast.show({
      tone: 'success',
      title: `${terms.t('receipt')} sent`,
      description: `On its way to ${address}.`,
    })
    setEmailing(false)
    setAddress('')
  }

  const bands = new Map<number, { net: number; tax: number }>()
  for (const line of order?.lines ?? []) {
    const row = bands.get(line.taxBasisPoints) ?? { net: 0, tax: 0 }
    row.net += line.net.minor
    row.tax += line.tax.minor
    bands.set(line.taxBasisPoints, row)
  }

  return (
    <Dialog
      open={order !== null}
      onClose={onClose}
      title="Sale complete"
      size="sm"
      footer={
        <>
          <Button variant="outline" size="lg" iconStart="Printer" onClick={() => window.print()}>
            Print
          </Button>
          <Button
            variant="outline"
            size="lg"
            iconStart="Bell"
            onClick={() => setEmailing((value) => !value)}
          >
            Email
          </Button>
          <Button size="lg" onClick={onClose}>Next sale</Button>
        </>
      }
    >
      {order && (
        <div className="font-mono text-sm">
          {emailing && (
            <div className="mb-4 flex items-end gap-2 font-sans">
              <Input
                label="Send it where"
                type="email"
                inputMode="email"
                className="flex-1"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button disabled={!address.includes('@')} onClick={send}>Send</Button>
            </div>
          )}
          <div className="border-b border-dashed border-border pb-3 text-center">
            <p className="text-base font-semibold">{profile.name}</p>
            <p className="mt-1 text-text-muted">{terms.t('receipt')} {order.number}</p>
            <p className="text-text-muted">{dates.dateTime(order.placedAt)}</p>
          </div>

          <ul className="flex flex-col gap-1.5 border-b border-dashed border-border py-3">
            {order.lines.map((line) => (
              <li key={line.id} className="flex justify-between gap-3">
                <span className="min-w-0">
                  <span className="tnum">{line.quantity}x </span>
                  {line.name}
                </span>
                <span className="tnum shrink-0">
                  <MoneyText value={line.gross} display="none" />
                </span>
              </li>
            ))}
          </ul>

          <dl className="flex flex-col gap-1 border-b border-dashed border-border py-3">
            <div className="flex justify-between">
              <dt>Net</dt>
              <dd className="tnum"><MoneyText value={order.net} display="none" /></dd>
            </div>
            {/* Printed per rate, because a receipt whose lines do not sum to
                its own total fails an audit, and most regimes require the
                bands separately in any case. */}
            {[...bands.entries()].sort((a, b) => a[0] - b[0]).map(([rate, row]) => (
              <div key={rate} className="flex justify-between text-text-muted">
                <dt>Tax {rate / 100}%</dt>
                <dd className="tnum">{row.tax}</dd>
              </div>
            ))}
            <div className="mt-1 flex justify-between text-base font-semibold">
              <dt>Total</dt>
              <dd className="tnum"><MoneyText value={order.gross} /></dd>
            </div>
          </dl>

          <dl className="flex flex-col gap-1 py-3">
            {order.tenders.map((tender) => (
              <div key={tender.id}>
                <div className="flex justify-between capitalize">
                  <dt>{tender.method}</dt>
                  {/* What was handed over, not what was applied. A receipt
                      reading "Cash 14 000 / Change 6 000" does not reconcile
                      for the person holding it: they gave you 20 000. */}
                  <dd className="tnum">
                    <MoneyText value={tender.tendered ?? tender.amount} display="none" />
                  </dd>
                </div>
                {tender.change && tender.change.minor > 0 && (
                  <div className="flex justify-between font-semibold">
                    <dt>Change</dt>
                    <dd className="tnum"><MoneyText value={tender.change} display="none" /></dd>
                  </div>
                )}
              </div>
            ))}
          </dl>
        </div>
      )}
    </Dialog>
  )
}
