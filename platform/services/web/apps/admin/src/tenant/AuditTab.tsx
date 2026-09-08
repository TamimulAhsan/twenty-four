import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminTenants } from '@twentyfour/api'
import { Card, Skeleton } from '@twentyfour/ui'
import { AuditTable } from '../AuditTable'
import { Preamble, Section } from '../common'
import { useEnvironment } from '../session'
import { useTenantId } from './useTenant'

/**
 * Everything that has happened to this tenant.
 *
 * The same rows as the global log, filtered to one business. The tenant column
 * is dropped because every row would carry the same value, and a column that
 * never varies is a column that costs width and says nothing.
 */
export function AuditTab() {
  const tenantId = useTenantId()
  const environment = useEnvironment()
  const query = useQuery({
    queryKey: adminKeys.tenants.audit(tenantId),
    queryFn: () => adminTenants.audit(tenantId),
    enabled: tenantId.length > 0,
  })

  return (
    <div className="flex flex-col gap-5">
      <Preamble>
        Append-only, consumed from the event bus, and kept for{' '}
        {environment.auditRetentionYears} years. Nothing in this console can delete a line of it,
        including this console.
      </Preamble>

      <Section title="Audit trail">
        {query.isPending ? (
          <Skeleton className="h-96" />
        ) : (
          <Card padded={false}>
            <AuditTable rows={query.data ?? []} showTenant={false} />
          </Card>
        )}
      </Section>
    </div>
  )
}
