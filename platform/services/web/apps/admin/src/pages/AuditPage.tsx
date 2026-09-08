import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminAudit, adminKeys } from '@twentyfour/api'
import { Button, Card, ErrorState, PageHeader, Skeleton, cn } from '@twentyfour/ui'
import { AuditTable } from '../AuditTable'
import { Preamble, errorMessage } from '../common'
import { useEnvironment } from '../session'

/**
 * Everything that happened, everywhere in this environment.
 *
 * The filters are event prefixes rather than free text, because the events are
 * a namespaced vocabulary and searching a namespace by substring finds
 * "tenant.suspended" when you asked for "suspend" and misses it when you asked
 * for "suspension". The one filter that is not a prefix is "refused", which is
 * a result rather than a kind and is the most useful view on the page.
 */
const FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'impersonation', label: 'Impersonation' },
  { id: 'entitlement', label: 'Entitlement' },
  { id: 'provisioning', label: 'Provisioning' },
  { id: 'tenant', label: 'Tenant' },
  { id: 'registry', label: 'Registry' },
  { id: 'denied', label: 'Refused' },
]

export function AuditPage() {
  const environment = useEnvironment()
  const [filter, setFilter] = useState('all')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: adminKeys.audit(filter),
    queryFn: () => adminAudit.list(filter === 'all' ? undefined : filter),
  })

  if (isError) {
    return (
      <ErrorState
        title="The audit log did not load"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every automated and human decision, in the order it happened."
      />

      <Preamble>
        Append-only and kept for {environment.auditRetentionYears} years. Nothing in this console
        can delete a line of it, including the platform owner, and a refused action is recorded
        exactly as carefully as one that succeeded.
      </Preamble>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 p-4">
          {FILTERS.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant={filter === entry.id ? 'secondary' : 'outline'}
              className={cn(entry.id === 'denied' && filter !== entry.id && 'text-danger-text')}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </Button>
          ))}
          <p className="ml-auto text-sm text-text-muted">
            {isPending ? 'loading' : `${data?.length ?? 0} events`}
          </p>
        </div>

        {isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          <div className="border-t border-border">
            <AuditTable rows={data ?? []} />
          </div>
        )}
      </Card>
    </div>
  )
}
