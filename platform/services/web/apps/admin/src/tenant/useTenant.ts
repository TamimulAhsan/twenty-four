import { useParams } from 'react-router'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { adminKeys, adminTenants, type TenantDetail } from '@twentyfour/api'

/**
 * The tenant the page is about.
 *
 * Each tab asks for it rather than being handed it down through an outlet
 * context. The query cache answers all of them from one request, so the wiring
 * buys nothing, and a tab that can fetch on its own is a tab that still works
 * when somebody opens its URL directly.
 */
export function useTenantId(): string {
  const { tenantId } = useParams<{ tenantId: string }>()
  return tenantId ?? ''
}

export function useTenant(): UseQueryResult<TenantDetail> {
  const tenantId = useTenantId()
  return useQuery({
    queryKey: adminKeys.tenants.detail(tenantId),
    queryFn: () => adminTenants.get(tenantId),
    enabled: tenantId.length > 0,
  })
}
