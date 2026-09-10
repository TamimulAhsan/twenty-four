import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, documents, type FiscalDocument } from '@twentyfour/api'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, Dialog, Icon, Input, MoneyText, cn, useDateFormat, useToast,
  type BadgeTone,
} from '@twentyfour/ui'
import { useBootstrap } from '@twentyfour/runtime'
import { PrintableDocument, printDocument } from '@twentyfour/shell'

const REPORTING: Record<FiscalDocument['reportingStatus'], { label: string; tone: BadgeTone }> = {
  not_required: { label: 'Not reportable', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'warning' },
  reported: { label: 'Reported', tone: 'success' },
  retrying: { label: 'Retrying', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
}

const KIND = { invoice: 'Invoice', receipt: 'Receipt', credit_note: 'Credit note' } as const

/**
 * One issued document.
 *
 * The figures shown are the ones recorded when it was issued, not a fresh
 * calculation: a receipt from last year must show last year's prices and tax
 * rates even after both have changed. The stored file itself is behind
 * Download; this is a summary of it, and says so.
 */
export function DocumentDetailDialog({
  document: doc,
  onClose,
  onOpenOrder,
}: {
  document: FiscalDocument | null
  onClose: () => void
  onOpenOrder: (orderId: string) => void
}) {
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const { profile } = useBootstrap()
  const mayCorrect = usePermission('documents.correct')
  const [correcting, setCorrecting] = useState(false)
  const [reason, setReason] = useState('')

  const correct = useMutation({
    mutationFn: () => documents.correct(doc!.id, reason),
    onSuccess: (created) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: `Credit note ${created.number} issued`,
        description: 'It references the original, which is unchanged.',
      })
      setCorrecting(false)
      setReason('')
      onClose()
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'That correction was refused',
        description: error instanceof HttpError ? error.message : undefined,
      }),
  })

  const reporting = doc ? REPORTING[doc.reportingStatus] : null
  const alreadyCorrected = doc?.correctedBy !== null && doc?.correctedBy !== undefined

  return (
    <Dialog
      open={doc !== null}
      onClose={onClose}
      title={doc ? `${KIND[doc.kind]} ${doc.number}` : ''}
      description={doc ? dates.dateTime(doc.issuedAt) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {doc?.orderId && (
            <Button variant="outline" onClick={() => onOpenOrder(doc.orderId as string)}>The sale</Button>
          )}
          {/* Prints the document as it was issued, not this dialog. */}
          <Button variant="outline" iconStart="Printer" onClick={() => printDocument()}>Print</Button>
          {doc && doc.kind !== 'credit_note' && !alreadyCorrected && mayCorrect && (
            <Button variant="danger" onClick={() => setCorrecting(true)}>Issue a correction</Button>
          )}
        </>
      }
    >
      {/*
        The document as it was issued, fetched from the service that stored it
        rather than rebuilt from what is on this screen. An issued document has
        to re-render exactly as issued, and composing it again from current
        prices and the business's current name would answer a different
        question convincingly enough that nobody would notice.
      */}
      {doc && <PrintableDocument document={doc} />}

      {doc && (
        <div className="flex flex-col gap-5">
          {/* Stated on the document itself, not only on the list page. This is
              where someone looks for an edit button. */}
          <Card className="border-accent-border bg-accent-subtle">
            <div className="flex gap-3">
              <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
              <p className="text-base text-text-muted">
                Issued documents cannot be changed. What you see is what was recorded at the time,
                including the prices and tax rates that applied then. A correction is a new
                document that references this one.
              </p>
            </div>
          </Card>

          {correcting && (
            <Card className="border-danger-border bg-danger-subtle">
              <p className="text-base font-medium text-text">Issue a credit note against this?</p>
              <p className="mt-1 text-base text-text-muted">
                A new document is created referencing {doc.number}. This one stays exactly as it is.
              </p>
              <Input
                className="mt-3"
                label="Reason"
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                hint="Recorded on the correction and in the audit log."
              />
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCorrecting(false)}>Cancel</Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={correct.isPending}
                  disabled={!reason.trim()}
                  onClick={() => correct.mutate()}
                >
                  Issue the credit note
                </Button>
              </div>
            </Card>
          )}

          <div className="rounded-xl border border-border bg-surface-sunken p-5 font-mono text-sm">
            <p className="text-center text-base font-semibold">{profile.name}</p>
            <p className="mt-1 text-center text-text-muted">
              {KIND[doc.kind]} {doc.number}
            </p>
            <p className="text-center text-text-muted">{dates.dateTime(doc.issuedAt)}</p>
            {doc.customerName && (
              <p className="mt-2 text-center text-text-muted">{doc.customerName}</p>
            )}
            <dl className="mt-4 flex flex-col gap-1 border-t border-dashed border-border pt-3">
              <div className="flex justify-between">
                <dt>Net</dt>
                <dd className="tnum"><MoneyText value={doc.net} display="none" /></dd>
              </div>
              <div className="flex justify-between text-text-muted">
                <dt>Tax</dt>
                <dd className="tnum"><MoneyText value={doc.tax} display="none" /></dd>
              </div>
              <div className="mt-1 flex justify-between text-base font-semibold">
                <dt>Total</dt>
                <dd className="tnum"><MoneyText value={doc.gross} /></dd>
              </div>
            </dl>
          </div>

          <dl className="flex flex-col divide-y divide-border border-t border-border">
            <Row label="Reporting">
              {reporting && <Badge dot tone={reporting.tone}>{reporting.label}</Badge>}
            </Row>
            {doc.corrects && (
              <Row label="Corrects">
                <span className="font-mono text-sm">{doc.corrects}</span>
              </Row>
            )}
            {doc.correctedBy && (
              <Row label="Corrected by">
                <span className="font-mono text-sm text-warning-text">{doc.correctedBy}</span>
              </Row>
            )}
            <Row label="Stored file">
              <a
                href={doc.artifactUrl}
                className={cn('font-mono text-sm text-accent-text underline-offset-4 hover:underline')}
              >
                Download
              </a>
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-base text-text-muted">{label}</dt>
      <dd className="text-base font-medium text-text">{children}</dd>
    </div>
  )
}
