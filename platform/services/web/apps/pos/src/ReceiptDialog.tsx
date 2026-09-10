import type { Order } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import { useState } from 'react'
import { Button, Dialog, Input, Select, useToast } from '@twentyfour/ui'
import {
  PAPERS,
  DEFAULT_PAPER,
  PrintableReceipt,
  ReceiptPreview,
  printReceipt,
  type PaperId,
} from '@twentyfour/shell'

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
  const [emailing, setEmailing] = useState(false)
  const [address, setAddress] = useState('')
  // Which roll is in the machine. A till setting rather than a per-sale one in
  // the end, but a cashier who has just swapped to a handheld should not have
  // to go and find a settings screen mid-queue.
  const [paper, setPaper] = useState<PaperId>(DEFAULT_PAPER)

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

  return (
    <Dialog
      open={order !== null}
      onClose={onClose}
      title="Sale complete"
      size="sm"
      footer={
        <>
          <Button variant="outline" size="lg" iconStart="Printer" onClick={() => printReceipt(paper)}>
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
        <div className="flex flex-col gap-4">
          {emailing && (
            <div className="flex items-end gap-2">
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

          {PAPERS[paper] && (
            <Select
              label="Paper"
              value={paper}
              onChange={(event) => setPaper(event.target.value as PaperId)}
              className="w-44"
            >
              {Object.values(PAPERS).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </Select>
          )}

          {/*
            The same grid on screen as on paper, at the roll's real width, so
            what a cashier checks before pressing print is what comes out of the
            machine. The frame is the paper; the receipt inside it is the
            document, and only that subtree survives the print stylesheet.
          */}
          <div className="flex justify-center rounded-lg bg-white p-3 text-black shadow-inner">
            <ReceiptPreview order={order} paper={paper} />
          </div>

          {/* The copy that prints, at the end of body rather than in here. */}
          <PrintableReceipt order={order} paper={paper} />
        </div>
      )}
    </Dialog>
  )
}
