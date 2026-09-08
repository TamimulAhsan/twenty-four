import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminKeys,
  adminProvisioning,
  HttpError,
  type OnboardingStep,
  type ProvisioningRun,
} from '@twentyfour/api'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Skeleton,
  cn,
  formatRemaining,
  useDateFormat,
  useTicker,
  useToast,
  type BadgeTone,
  type IconName,
} from '@twentyfour/ui'
import { Preamble, Section, errorMessage } from '../common'
import { useTenantId } from './useTenant'

/**
 * The saga behind one tenant, step by step.
 *
 * These are the merchant's own checklist rows, not a parallel model of them.
 * Onboarding lives inside Provisioning, so a step a specialist retries here is
 * the step the merchant watches turn green on their dashboard, worded the same
 * way. Two lists of twelve steps would have drifted within a release.
 *
 * What the specialist gets that the merchant does not is the ability to re-run
 * one. What the merchant gets that the specialist does not is the guarantee.
 */
const STATUS: Readonly<
  Record<OnboardingStep['status'], { label: string; icon: IconName; tone: BadgeTone; spin?: boolean }>
> = {
  done: { label: 'Done', icon: 'CheckCircle2', tone: 'success' },
  in_progress: { label: 'Running', icon: 'LoaderCircle', tone: 'accent', spin: true },
  awaiting_specialist: { label: 'Waiting on a person', icon: 'Clock', tone: 'warning' },
  failed: { label: 'Failed', icon: 'AlertCircle', tone: 'danger' },
  pending: { label: 'Queued', icon: 'CircleDot', tone: 'neutral' },
}

const OWNER: Readonly<Record<OnboardingStep['owner'], string | null>> = {
  platform: null,
  specialist: 'A specialist',
  merchant: 'The merchant',
}

export function ProvisioningTab() {
  const tenantId = useTenantId()
  const query = useQuery({
    queryKey: adminKeys.provisioning.run(tenantId),
    queryFn: () => adminProvisioning.get(tenantId),
    enabled: tenantId.length > 0,
    retry: false,
  })

  if (query.isPending) return <Skeleton className="h-96" />

  // A 404 here is not an error. A live tenant's run finished and was archived,
  // and showing a completed checklist on a business that has traded for a year
  // is how a dashboard implies everyone is still being set up.
  if (query.isError) {
    const notFound = query.error instanceof HttpError && query.error.status === 404
    return (
      <EmptyState
        icon={notFound ? 'CheckCircle2' : 'AlertCircle'}
        title={notFound ? 'This tenant is live' : 'The run did not load'}
        description={
          notFound
            ? 'There is no run in flight. Its saga finished and was archived.'
            : errorMessage(query.error)
        }
      />
    )
  }

  if (!query.data) return null
  return <Run run={query.data} />
}

function Run({ run }: { run: ProvisioningRun }) {
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const toast = useToast()
  const now = useTicker(run.state.completedAt ? null : 30_000)

  const retry = useMutation({
    mutationFn: (stepId: string) => adminProvisioning.retryStep(run.tenantId, stepId),
    onSuccess: (next) => {
      queryClient.setQueryData(adminKeys.provisioning.run(run.tenantId), next)
      void queryClient.invalidateQueries({ queryKey: adminKeys.provisioning.queue() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.tenants.audit(run.tenantId) })
      toast.show({
        tone: 'success',
        title: 'Re-running',
        description: 'The step is idempotent, so a partial first attempt compensates first.',
      })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) }),
  })

  const steps = run.state.steps
  const done = steps.filter((step) => step.status === 'done').length
  const remaining = new Date(run.state.dueAt).getTime() - now
  const overdue = remaining <= 0
  const blocked = steps.filter((step) => step.status === 'failed').length

  return (
    <div className="flex flex-col gap-5">
      <Preamble>
        These are the rows the merchant sees on their own dashboard, in their own words. The only
        thing this view adds is the ability to re-run one.
      </Preamble>

      <Card className={cn(overdue && 'border-danger-border bg-danger-subtle')}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p
              className={cn(
                'text-2xl font-semibold tracking-[-0.02em]',
                overdue ? 'text-danger-text' : 'text-text',
              )}
            >
              {overdue ? 'Past twenty-four hours' : formatRemaining(remaining)}
            </p>
            <p className="mt-1 text-base text-text-muted">
              {overdue
                ? 'The guarantee has been missed. Their first month is free.'
                : 'Against the twenty-four hour promise, measured from the intake call.'}
            </p>
          </div>
          <div className="text-right">
            <p className="tnum text-2xl font-semibold text-text">
              {done}
              <span className="text-text-subtle">/{steps.length}</span>
            </p>
            <p className="text-sm text-text-subtle">steps done</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-muted">
          <span>
            Saga <span className="font-mono">{run.sagaId}</span>
          </span>
          <span>Intake by {run.specialist}</span>
          <span>Started {dates.dateTime(run.state.startedAt)}</span>
          <span>Due {dates.dateTime(run.state.dueAt)}</span>
        </div>

        {blocked > 0 && (
          <p className="mt-4 flex items-center gap-2 text-base font-medium text-danger-text">
            <Icon name="AlertCircle" size="md" className="shrink-0" />
            {blocked === 1 ? 'One step is blocked' : `${blocked} steps are blocked`}. The clock
            keeps running.
          </p>
        )}
      </Card>

      <Section title="Steps" description="Each one is independently retryable and idempotent.">
        <Card padded={false}>
          <ol>
            {steps.map((step, index) => (
              <li key={step.id}>
                <StepRow
                  step={step}
                  number={index + 1}
                  first={index === 0}
                  retrying={retry.isPending && retry.variables === step.id}
                  onRetry={() => retry.mutate(step.id)}
                />
              </li>
            ))}
          </ol>
        </Card>
      </Section>
    </div>
  )
}

function StepRow({
  step,
  number,
  first,
  retrying,
  onRetry,
}: {
  step: OnboardingStep
  number: number
  first: boolean
  retrying: boolean
  onRetry: () => void
}) {
  const dates = useDateFormat()
  const status = STATUS[step.status]
  const owner = OWNER[step.owner]
  const retryable = step.status === 'failed' || step.status === 'awaiting_specialist'

  return (
    <div className={cn('flex items-start gap-3 px-4 py-3.5', !first && 'border-t border-border')}>
      <span className="tnum mt-0.5 w-6 shrink-0 text-sm text-text-subtle">{number}</span>

      <span
        className={cn(
          'mt-0.5 shrink-0',
          status.tone === 'success' && 'text-success-text',
          status.tone === 'accent' && 'text-accent',
          status.tone === 'warning' && 'text-warning-text',
          status.tone === 'danger' && 'text-danger-text',
          status.tone === 'neutral' && 'text-text-subtle',
        )}
      >
        <Icon name={status.icon} size="lg" label={status.label} className={cn(status.spin && 'animate-spin')} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base font-medium text-text">{step.title}</p>
          <Badge tone={status.tone}>{status.label}</Badge>
          {owner && step.status !== 'done' && <Badge>{owner}</Badge>}
        </div>
        <p className="mt-0.5 text-base text-text-muted">{step.description}</p>
        {step.completedAt && (
          <p className="mt-1 text-sm text-text-subtle">
            Finished {dates.dateTime(step.completedAt)}
          </p>
        )}
      </div>

      <div className="shrink-0">
        {retryable && (
          <Button size="sm" variant="outline" iconStart="RotateCcw" loading={retrying} onClick={onRetry}>
            Re-run
          </Button>
        )}
      </div>
    </div>
  )
}
