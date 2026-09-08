import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminPlatform, type PlatformBilling } from '@twentyfour/api'
import { TIERS } from '@twentyfour/entitlement'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  MoneyText,
  PageHeader,
  Skeleton,
  StatTile,
  cn,
} from '@twentyfour/ui'
import { HealthNote, Section, errorMessage } from '../common'
import { useEnvironment } from '../session'

/**
 * The books for this environment.
 *
 * One market, one legal entity, one currency, one ledger. Nothing on this page
 * is a group total and nothing on it can be, which is why it says so out loud:
 * somebody will eventually screenshot a figure from here into a board pack,
 * and the caption needs to travel with the number.
 */
export function BillingPage() {
  const environment = useEnvironment()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: adminKeys.billing(),
    queryFn: adminPlatform.billing,
  })

  if (isError) {
    return (
      <ErrorState
        title="Billing did not load"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform billing"
        description={`The ${environment.market} entity only. Consolidation across markets is a separate reporting step, outside this console.`}
      />

      {isPending || !data ? (
        <Skeleton className="h-28" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Monthly recurring" money={data.mrr} icon="Wallet" />
            <StatTile label="Annual run rate" money={data.arrRunRate} icon="TrendingUp" />
            <StatTile label="New this month" money={data.netNewMrr} icon="Plus" />
            <StatTile label="At risk" money={data.atRisk} icon="AlertCircle" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <TierMix billing={data} />
            <Dunning billing={data} />
          </div>
        </>
      )}
    </div>
  )
}

function TierMix({ billing }: { billing: PlatformBilling }) {
  const environment = useEnvironment()
  const total = billing.mix.reduce((sum, row) => sum + row.tenants, 0)

  return (
    <Card>
      <CardHeader
        title="Where the revenue sits"
        description={`Tenants and monthly recurring by tier, ${environment.market} only.`}
      />
      <div className="mt-4 flex flex-col gap-4">
        {billing.mix.map((row) => {
          const share = total === 0 ? 0 : Math.round((row.tenants / total) * 100)
          return (
            <div key={row.tier}>
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-base text-text">{TIERS[row.tier].name}</p>
                <p className="text-sm text-text-muted">
                  {row.tenants} {row.tenants === 1 ? 'tenant' : 'tenants'} ·{' '}
                  <MoneyText value={row.mrr} compact />
                </p>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-bg-inset">
                <div
                  className={cn(
                    'h-full rounded-full',
                    row.tier === 'enterprise'
                      ? 'bg-viz-4'
                      : row.tier === 'max'
                        ? 'bg-viz-1'
                        : row.tier === 'growth'
                          ? 'bg-viz-2'
                          : 'bg-viz-3',
                  )}
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-5 border-t border-border pt-3 text-sm text-text-subtle">
        Trials are counted as tenants and contribute nothing, which is why the bars and the money
        do not track each other.
      </p>
    </Card>
  )
}

function Dunning({ billing }: { billing: PlatformBilling }) {
  const navigate = useNavigate()

  return (
    <Section
      title="Being chased"
      description="Every tenant with a payment problem, whether or not it has bitten yet."
    >
      {billing.dunning.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          title="Nobody is being chased"
          description="Every subscription in this environment is paid up."
        />
      ) : (
        <Card padded={false}>
          <ul>
            {billing.dunning.map((entry, index) => (
              <li
                key={entry.tenantId}
                className={cn('flex flex-wrap items-center gap-3 px-4 py-3.5', index > 0 && 'border-t border-border')}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-text">{entry.tenantName}</p>
                    <Badge tone={entry.health === 'failing' ? 'danger' : 'warning'}>
                      {entry.attempt}
                    </Badge>
                  </div>
                  <div className="mt-1">
                    <HealthNote health={entry.health} note={entry.reason} />
                  </div>
                </div>
                <p className="tnum text-base font-medium text-text">
                  <MoneyText value={entry.amount} />
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  iconEnd="ArrowRight"
                  onClick={() => navigate(`/tenants/${entry.tenantId}/billing`)}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="mt-3 text-sm text-text-subtle">
        Retrying a charge happens in the Billing service on its own schedule. This console shows
        where the sequence has got to; it does not jump the queue.
      </p>
    </Section>
  )
}
