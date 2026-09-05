import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HttpError, inventory, queryKeys, type StockLevel } from '@twentyfour/api'
import { useTerms } from '@twentyfour/terms'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  useToast,
} from '@twentyfour/ui'

/** Every reason a count changes outside a sale. The list is deliberately
 *  short: a free-text-only reason produces a movement log nobody can total. */
const REASONS = [
  { value: 'delivery', label: 'Delivery received' },
  { value: 'count', label: 'Stock count correction' },
  { value: 'waste', label: 'Waste or breakage' },
  { value: 'staff', label: 'Staff use' },
  { value: 'return', label: 'Returned to supplier' },
]

export function InventoryPage() {
  const terms = useTerms()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [adjusting, setAdjusting] = useState<StockLevel | null>(null)

  const levels = useQuery({ queryKey: queryKeys.inventory.levels(), queryFn: inventory.levels })

  const low = (levels.data ?? []).filter(
    (row) => row.lowStockThreshold !== null && row.onHand <= row.lowStockThreshold,
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory"
        description={`Live counts for every ${terms.t('catalog_item', { case: 'lower' })} you track.`}
      />

      {/* Stock moves on the sale, not on the payment. A cash sale, a comped
          item and a manual correction all move it, which is why adjustments
          live here and carry a reason of their own. */}
      {low.length > 0 && (
        <Card className="border-warning-border bg-warning-subtle">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone="warning" icon="TriangleAlert">
              {low.length} running low
            </Badge>
            <p className="text-base text-text-muted">
              {low.map((row) => row.itemName).slice(0, 4).join(', ')}
              {low.length > 4 && ` and ${low.length - 4} more`}
            </p>
          </div>
        </Card>
      )}

      {levels.isError ? (
        <ErrorState description="Stock levels did not load." onRetry={() => void levels.refetch()} />
      ) : levels.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        </Card>
      ) : levels.data.length === 0 ? (
        <EmptyState
          icon="Boxes"
          title="Nothing is stock tracked yet"
          description={`Turn on stock tracking for ${terms.a('catalog_item', { case: 'lower' })} and its count appears here.`}
        />
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>{terms.t('catalog_item')}</Th>
                  <Th numeric>On hand</Th>
                  <Th numeric className="hidden sm:table-cell">Reserved</Th>
                  <Th numeric className="hidden sm:table-cell">Reorder at</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {levels.data.map((row) => {
                  const isLow = row.lowStockThreshold !== null && row.onHand <= row.lowStockThreshold
                  return (
                    <Tr key={row.itemId}>
                      <Td className="font-medium">{row.itemName}</Td>
                      <Td numeric className="font-medium">{row.onHand}</Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">{row.reserved}</Td>
                      <Td numeric className="hidden text-text-muted sm:table-cell">
                        {row.lowStockThreshold ?? '—'}
                      </Td>
                      <Td>
                        {row.onHand <= 0 ? (
                          <Badge tone="danger" dot>Out of stock</Badge>
                        ) : isLow ? (
                          <Badge tone="warning" dot>Low</Badge>
                        ) : (
                          <Badge tone="success" dot>In stock</Badge>
                        )}
                      </Td>
                      <Td className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setAdjusting(row)}>
                          Adjust
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

      <AdjustDialog
        row={adjusting}
        onClose={() => setAdjusting(null)}
        onDone={(row, delta) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.inventory.levels() })
          toast.show({
            tone: 'success',
            title: `${row.itemName} adjusted`,
            description: `${delta > 0 ? '+' : ''}${delta}, now ${row.onHand}.`,
          })
          setAdjusting(null)
        }}
      />
    </div>
  )
}

function AdjustDialog({
  row,
  onClose,
  onDone,
}: {
  row: StockLevel | null
  onClose: () => void
  onDone: (row: StockLevel, delta: number) => void
}) {
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState(REASONS[0]!.value)

  const adjust = useMutation({
    mutationFn: () =>
      inventory.adjust({ itemId: row!.itemId, delta: Number(delta), reason }),
    onSuccess: (updated) => {
      onDone(updated, Number(delta))
      setDelta('')
    },
  })

  const parsed = Number(delta)
  const invalid = delta.trim() === '' || !Number.isInteger(parsed) || parsed === 0

  return (
    <Dialog
      open={row !== null}
      onClose={onClose}
      title={row ? `Adjust ${row.itemName}` : 'Adjust'}
      description={row ? `${row.onHand} on hand right now.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={adjust.isPending} disabled={invalid} onClick={() => adjust.mutate()}>
            Record adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Change"
          hint="A positive number adds stock, a negative number removes it."
          inputMode="numeric"
          numeric
          value={delta}
          onChange={(event) => setDelta(event.target.value)}
          error={
            adjust.error instanceof HttpError
              ? adjust.error.message
              : delta.trim() !== '' && invalid
                ? 'Enter a whole number that is not zero.'
                : undefined
          }
        />
        <Field label="Reason" htmlFor="reason" hint="Recorded against the movement so the count can always be explained.">
          <Select id="reason" value={reason} onChange={(event) => setReason(event.target.value)}>
            {REASONS.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  )
}
