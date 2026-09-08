import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminProvisioning, type ProvisioningRun } from '@twentyfour/api'
import { TIERS } from '@twentyfour/entitlement'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Skeleton,
  StatTile,
  cn,
  formatRemaining,
  useDateFormat,
  useTicker,
} from '@twentyfour/ui'
import { TierBadge, errorMessage } from '../common'
import { useEnvironment } from '../session'

/**
 * Every run still in flight against the promise.
 *
 * Ordered by deadline, not by name or by size. The only question this page
 * answers is which promise breaks first, so the one closest to breaking is at
 * the top whether it belongs to the largest tenant or the smallest.
 */
export function ProvisioningPage() {
  const environment = useEnvironment()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: adminKeys.provisioning.queue(),
    queryFn: adminProvisioning.queue,
    // Somebody else's saga is moving while this page is open. Thirty seconds
    // is slow enough not to matter and fast enough that a specialist watching
    // a stuck run sees it clear without reloading.
    refetchInterval: 30_000,
  })
  const now = useTicker(30_000)

  if (isError) {
    return (
      <ErrorState
        title="The queue did not load"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  const runs = data ?? []
  const atRisk = runs.filter(
    (run) => new Date(run.state.dueAt).getTime() - now < 8 * 3_600_000,
  ).length
  const blocked = runs.filter((run) =>
    run.state.steps.some((step) => step.status === 'failed'),
  ).length
  const waiting = runs.filter((run) =>
    run.state.steps.some((step) => step.status === 'awaiting_specialist'),
  ).length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Getting live"
        description={`Every tenant still inside the ${environment.goLiveHours}-hour promise, closest deadline first.`}
      />

      {isPending ? (
        <Skeleton className="h-28" />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="In flight" value={runs.length} icon="Clock" />
          <StatTile label="Under eight hours" value={atRisk} icon="AlertTriangle" />
          <StatTile label="Blocked" value={blocked} icon="AlertCircle" />
          <StatTile label="Waiting on a person" value={waiting} icon="User" />
        </div>
      )}

      {isPending ? (
        <Skeleton className="h-64" />
      ) : runs.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          title="Nothing in flight"
          description="Every tenant in this environment is live. The next signup will appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {runs.map((run) => (
            <RunCard key={run.tenantId} run={run} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

function RunCard({ run, now }: { run: ProvisioningRun; now: number }) {
  const navigate = useNavigate()
  const dates = useDateFormat()

  const steps = run.state.steps
  const done = steps.filter((step) => step.status === 'done').length
  const remaining = new Date(run.state.dueAt).getTime() - now
  const overdue = remaining <= 0
  const urgent = remaining < 8 * 3_600_000
  const failed = steps.find((step) => step.status === 'failed')
  const running = steps.find((step) => step.status === 'in_progress')
  const waiting = steps.find((step) => step.status === 'awaiting_specialist')

  return (
    <Card
      className={cn(
        overdue ? 'border-danger-border' : urgent ? 'border-warning-border' : undefined,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/tenants/${run.tenantId}/provisioning`)}
              className="text-md font-semibold text-text hover:underline"
            >
              {run.tenantName}
            </button>
            <TierBadge tier={run.tier} />
            {failed && <Badge tone="danger">Blocked</Badge>}
          </div>
          <p className="mt-1 text-sm text-text-muted">
            Intake by {run.specialist} · started {dates.dateTime(run.state.startedAt)} · saga{' '}
            <span className="font-mono">{run.sagaId}</span>
          </p>
        </div>

        <div className="text-right">
          <p
            className={cn(
              'text-md font-semibold',
              overdue ? 'text-danger-text' : urgent ? 'text-warning-text' : 'text-text',
            )}
          >
            {overdue ? 'Past due' : formatRemaining(remaining)}
          </p>
          <p className="tnum text-sm text-text-subtle">
            {done} of {steps.length} done
          </p>
        </div>
      </div>

      {/* One pip per step. Twelve steps read as twelve things, which is what
          they are; a single filled bar reads as a percentage, and a percentage
          cannot say which one is stuck. */}
      <div className="mt-4 flex gap-1" aria-hidden="true">
        {steps.map((step) => (
          <span
            key={step.id}
            title={`${step.title}: ${step.status}`}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              step.status === 'done'
                ? 'bg-success'
                : step.status === 'in_progress'
                  ? 'bg-accent'
                  : step.status === 'failed'
                    ? 'bg-danger'
                    : step.status === 'awaiting_specialist'
                      ? 'bg-warning'
                      : 'bg-border',
            )}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-center gap-2 text-base text-text-muted">
          <Icon
            name={failed ? 'AlertCircle' : waiting ? 'Clock' : 'LoaderCircle'}
            size="md"
            className={cn(
              'shrink-0',
              failed ? 'text-danger-text' : waiting ? 'text-warning-text' : 'animate-spin text-accent',
            )}
          />
          {failed
            ? `Stuck on ${failed.title.toLowerCase()}`
            : running
              ? running.title
              : waiting
                ? `Waiting on a person: ${waiting.title.toLowerCase()}`
                : 'Every automated step is finished'}
        </p>

        <Button
          className="ml-auto"
          size="sm"
          variant="outline"
          iconEnd="ArrowRight"
          onClick={() => navigate(`/tenants/${run.tenantId}/provisioning`)}
        >
          Open the saga
        </Button>
      </div>

      {run.tier === 'enterprise' && (
        <p className="mt-3 text-sm text-text-subtle">
          {TIERS.enterprise.tagline} Its module set was agreed for this customer, so the steps here
          are the ones that set was provisioned from.
        </p>
      )}
    </Card>
  )
}
