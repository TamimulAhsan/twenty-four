import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { documents, queryKeys, type FiscalDocument } from '@twentyfour/api'

/**
 * An issued document, printed exactly as it was issued.
 *
 * The artifact is fetched rather than composed. That is the whole point of the
 * Invoicing service storing it: a document has to re-render as it was issued,
 * and building it again from current prices, current tax rates and the
 * business's current name would answer a different question convincingly
 * enough that nobody would notice it was the wrong one.
 *
 * A4 rather than a receipt roll, because an invoice goes in a folder or an
 * envelope. Monospaced because that is how the service laid it out, and
 * proportional type would collapse its columns.
 */
export function PrintableDocument({ document: doc }: { document: FiscalDocument }) {
  const artifact = useQuery({
    queryKey: queryKeys.documents.artifact(doc.id),
    queryFn: () => documents.artifact(doc.id),
    // An issued document never changes, so this is the one thing in the
    // product that can be cached without a second thought.
    staleTime: Infinity,
  })

  if (!artifact.data) return null

  return createPortal(
    <pre
      data-print
      data-paper="a4"
      className="receipt-paper"
      aria-hidden="true"
    >
      {artifact.data}
    </pre>,
    window.document.body,
  )
}
