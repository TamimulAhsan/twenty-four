import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { documents, queryKeys, type FiscalDocument } from '@twentyfour/api'
import { OrderDetailDialog } from '../components/OrderDetailDialog'
import { DocumentDetailDialog } from './DocumentDetailDialog'
import {
  Badge, Button, Card, EmptyState, ErrorState, Icon, MoneyText, PageHeader, Select,
  Skeleton, Table, TableScroll, Td, Th, Tr, useDateFormat,
} from '@twentyfour/ui'

const KIND_LABEL = { invoice: 'Invoice', receipt: 'Receipt', credit_note: 'Credit note' } as const

/** Generic by design: no tax authority is named in shared code, because the
 *  service that reports to one is swapped per market. */
const REPORTING = {
  not_required: { label: 'Not reportable', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'warning' },
  reported: { label: 'Reported', tone: 'success' },
  retrying: { label: 'Retrying', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
} as const

export function DocumentsPage() {
  const dates = useDateFormat()
  const [kind, setKind] = useState('')
  const [open, setOpen] = useState<FiscalDocument | null>(null)
  const [openOrder, setOpenOrder] = useState<string | null>(null)

  const list = useQuery({
    queryKey: queryKeys.documents.list({ kind }),
    queryFn: () => documents.list(kind ? { kind } : {}),
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices and receipts"
        description="Every document you have issued, exactly as it was issued."
      />

      {/* The immutability rule is a legal one, not a UI preference, so it is
          stated on the page rather than discovered when someone looks for an
          edit button that is not there. */}
      <Card className="border-accent-border bg-accent-subtle">
        <div className="flex gap-3">
          <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
          <div>
            <p className="text-base font-medium text-text">Issued documents cannot be changed</p>
            <p className="mt-0.5 text-base text-text-muted">
              A correction is a new document that references the original, and the original stays
              as it was. What you see here is the stored file, not a fresh render, so a document
              from last year still shows last year’s prices and tax rates.
            </p>
          </div>
        </div>
      </Card>

      <Select
        className="sm:max-w-xs"
        label="Type"
        value={kind}
        onChange={(event) => setKind(event.target.value)}
      >
        <option value="">All documents</option>
        <option value="receipt">Receipts</option>
        <option value="invoice">Invoices</option>
        <option value="credit_note">Credit notes</option>
      </Select>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
          </div>
        </Card>
      ) : list.data.length === 0 ? (
        <EmptyState icon="FileText" title="No documents of that type yet" />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Number</Th>
                  <Th>Type</Th>
                  <Th>Issued</Th>
                  <Th className="hidden md:table-cell">Reporting</Th>
                  <Th numeric className="hidden sm:table-cell">Net</Th>
                  <Th numeric className="hidden sm:table-cell">Tax</Th>
                  <Th numeric>Total</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((document) => {
                  const reporting = REPORTING[document.reportingStatus]
                  return (
                    <Tr key={document.id} interactive onClick={() => setOpen(document)}>
                      <Td className="font-mono text-sm">{document.number}</Td>
                      <Td>
                        <Badge tone={document.kind === 'credit_note' ? 'warning' : 'neutral'}>
                          {KIND_LABEL[document.kind]}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(document.issuedAt)}</Td>
                      <Td className="hidden md:table-cell">
                        <Badge dot tone={reporting.tone}>{reporting.label}</Badge>
                      </Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        <MoneyText value={document.net} display="none" />
                      </Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        <MoneyText value={document.tax} display="none" />
                      </Td>
                      <Td numeric className="font-medium"><MoneyText value={document.gross} /></Td>
                      <Td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          iconStart="FileText"
                          onClick={(event) => {
                            event.stopPropagation()
                            setOpen(document)
                          }}
                        >
                          <span className="hidden sm:inline">Open</span>
                        </Button>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <DocumentDetailDialog
        document={open}
        onClose={() => setOpen(null)}
        onOpenOrder={(id) => {
          setOpen(null)
          setOpenOrder(id)
        }}
      />
      <OrderDetailDialog orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </div>
  )
}
