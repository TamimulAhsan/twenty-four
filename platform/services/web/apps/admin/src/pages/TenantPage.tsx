import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminKeys, adminTenants, type TenantDetail } from '@twentyfour/api'
import { industryProfile } from '@twentyfour/entitlement'
import {
  Button,
  Card,
  ErrorState,
  Icon,
  Skeleton,
  cn,
  useDateFormat,
  useToast,
} from '@twentyfour/ui'
import { HealthNote, ReasonDialog, StatusBadge, TierBadge, errorMessage } from '../common'
import { StartSessionButton } from '../StartSessionButton'
import { useTenant, useTenantId } from '../tenant/useTenant'

const TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: 'overview', label: 'Overview' },
  { to: 'sales', label: 'Sales' },
  { to: 'entitlement', label: 'Modules and tier' },
  { to: 'billing', label: 'Billing' },
  { to: 'provisioning', label: 'Getting live' },
  { to: 'audit', label: 'Audit' },
]

/**
 * One merchant, from the platform's side.
 *
 * The header carries the two things a specialist needs before reading
 * anything else: what state the account is in, and what is wrong with it. The
 * health line is at the top rather than buried in a tab because somebody
 * opening this page has usually been told something is broken and is looking
 * for confirmation.
 */
export function TenantPage() {
  const tenantId = useTenantId()
  const { data, isPending, isError, error, refetch } = useTenant()

  if (isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <ErrorState
        title="That tenant did not load"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Header tenant={data} />

      {data.health !== 'ok' && (
        <Card
          className={cn(
            data.health === 'failing'
              ? 'border-danger-border bg-danger-subtle'
              : 'border-warning-border bg-warning-subtle',
          )}
        >
          <HealthNote health={data.health} note={data.healthNote} />
        </Card>
      )}

      <nav aria-label="This tenant" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={`/tenants/${tenantId}/${tab.to}`}
            className={({ isActive }) =>
              cn(
                'whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-base transition-colors',
                isActive
                  ? 'border-accent font-medium text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  )
}

function Header({ tenant }: { tenant: TenantDetail }) {
  const navigate = useNavigate()
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [asking, setAsking] = useState(false)

  const suspended = tenant.status === 'suspended'

  const setStatus = useMutation({
    mutationFn: (reason: string) =>
      adminTenants.setStatus(tenant.tenantId, suspended ? 'live' : 'suspended', reason),
    onSuccess: (next) => {
      queryClient.setQueryData(adminKeys.tenants.detail(tenant.tenantId), next)
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.list() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.audit(tenant.tenantId) })
      setAsking(false)
      toast.show({
        tone: suspended ? 'success' : 'warning',
        title: suspended ? 'Reinstated' : 'Suspended',
        description: suspended
          ? 'Staff logins work again and the storefront is back.'
          : 'Staff logins are refused at the gateway and the storefront shows a maintenance page.',
      })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) }),
  })

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text"
      >
        <Icon name="ArrowLeft" size="sm" />
        All tenants
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-[-0.025em] text-text sm:text-2xl">
              {tenant.name}
            </h1>
            <TierBadge tier={tenant.tier} />
            <StatusBadge status={tenant.status} />
          </div>
          <p className="mt-1 text-base text-text-muted">
            <span className="font-mono">{tenant.merchantCode}</span> ·{' '}
            {industryProfile(tenant.industry)?.name ?? tenant.industry} · {tenant.address} ·
            onboarded {dates.date(tenant.onboardedAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <StartSessionButton tenant={tenant} label="Watch their dashboard" />
          <Button
            variant={suspended ? 'outline' : 'danger'}
            iconStart={suspended ? 'RefreshCw' : 'Ban'}
            onClick={() => setAsking(true)}
          >
            {suspended ? 'Reinstate' : 'Suspend'}
          </Button>
        </div>
      </div>

      <ReasonDialog
        open={asking}
        title={suspended ? `Reinstate ${tenant.name}` : `Suspend ${tenant.name}`}
        description={
          suspended ? (
            <>Staff logins start working again and the storefront comes back immediately.</>
          ) : (
            <>
              Staff logins are refused at the gateway and the storefront serves a maintenance page.
              Their data is untouched and nothing is deleted. This is reversible.
            </>
          )
        }
        confirmLabel={suspended ? 'Reinstate' : 'Suspend'}
        destructive={!suspended}
        pending={setStatus.isPending}
        onConfirm={(reason) => setStatus.mutate(reason)}
        onClose={() => setAsking(false)}
      />
    </div>
  )
}
