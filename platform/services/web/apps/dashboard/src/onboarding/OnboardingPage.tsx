import { useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  onboarding as onboardingApi, queryKeys,
  type OnboardingState, type OnboardingStep, type OnboardingStepOwner,
} from '@twentyfour/api'
import { launchTargets } from '@twentyfour/runtime'
import { useTerms } from '@twentyfour/terms'
import {
  Badge, Button, Card, CardHeader, EmptyState, Icon, PageHeader, Skeleton, cn,
  useDateFormat, useToast, type BadgeTone, type IconName,
} from '@twentyfour/ui'
import { formatRemaining, useOnboarding } from './useOnboarding'

/**
 * Getting live, on one page.
 *
 * The commercial promise is the product: a specialist configures the system for
 * the trade and the business is trading within twenty-four hours, or the first
 * month is free. This is the merchant's view of that clock, and it is the first
 * thing they see after signing up.
 *
 * Two things it refuses to do. It does not show a single percentage, because
 * most of these steps are somebody else's and a merchant staring at 58% cannot
 * tell whether they are the hold-up. And it does not pretend a step that
 * needs a person is in progress: KYC approval and hardware pairing sit visibly
 * with a specialist, which is what keeps the guarantee honest the first time a
 * processor is slow.
 */
const STAGES: ReadonlyArray<{ hour: 0 | 4 | 12 | 24; label: string; caption: string }> = [
  { hour: 0, label: 'At the intake call', caption: 'What you told us, recorded.' },
  { hour: 4, label: 'First four hours', caption: 'Your account, built from your trade.' },
  { hour: 12, label: 'By hour twelve', caption: 'Money, hardware and your existing data.' },
  { hour: 24, label: 'Before you go live', caption: 'Training, and then a real sale.' },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const dates = useDateFormat()
  const { state, running, done, total, mine, remainingMs, overdue, isPending } = useOnboarding()

  if (isPending && !state) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Getting you live" />
        <Skeleton className="h-32" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (!state) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Getting you live" />
        <EmptyState
          icon="CheckCircle2"
          title="You are already live"
          description="There is no setup running. Everything here is yours to use."
          action={<Button onClick={() => navigate('/')}>Back to the overview</Button>}
          className="mt-6"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Getting you live"
        description={
          state.completedAt
            ? `Finished ${dates.dateTime(state.completedAt)}.`
            : `Started ${dates.dateTime(state.startedAt)}. Due by ${dates.dateTime(state.dueAt)}.`
        }
      />

      <Clock
        state={state}
        running={running}
        done={done}
        total={total}
        mine={mine}
        remainingMs={remainingMs}
        overdue={overdue}
      />

      {STAGES.map((stage) => {
        const steps = state.steps.filter((step) => step.hour === stage.hour)
        if (steps.length === 0) return null
        return (
          <section key={stage.hour}>
            <CardHeader title={stage.label} description={stage.caption} />
            <Card className="mt-3" padded={false}>
              <ul>
                {steps.map((step, index) => (
                  <li key={step.id}>
                    <StepRow step={step} first={index === 0} />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------- clock */

function Clock({
  state,
  running,
  done,
  total,
  mine,
  remainingMs,
  overdue,
}: {
  state: OnboardingState
  running: boolean
  done: number
  total: number
  mine: number
  remainingMs: number
  overdue: boolean
}) {
  if (!running) {
    return (
      <Card className="border-success-border bg-success-subtle">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-success-text">
            <Icon name="CheckCircle2" size="xl" />
          </span>
          <div>
            <p className="text-md font-semibold text-text">You are live</p>
            <p className="mt-1 text-base text-text-muted">
              Every step is finished. Nothing on this page needs you again.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className={cn(
              'text-2xl font-semibold tracking-[-0.02em]',
              overdue ? 'text-danger-text' : 'text-text',
            )}
          >
            {overdue ? 'Past twenty-four hours' : formatRemaining(remainingMs)}
          </p>
          <p className="mt-1 text-base text-text-muted">
            {overdue
              ? 'Your first month is free. A specialist is still on this and will finish it.'
              : 'If you are not trading within twenty-four hours of the intake call, your first month is free.'}
          </p>
        </div>
        <div className="text-right">
          <p className="tnum text-2xl font-semibold text-text">
            {done}
            <span className="text-text-subtle">/{total}</span>
          </p>
          <p className="text-sm text-text-subtle">steps done</p>
        </div>
      </div>

      {/* Segments rather than one bar. Twelve steps read as twelve things,
          which is what they are; a single filled bar reads as a percentage,
          and a percentage cannot say which of them are yours. */}
      <div className="mt-4 flex gap-1" aria-hidden="true">
        {state.steps.map((step) => (
          <span
            key={step.id}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              step.status === 'done'
                ? 'bg-success'
                : step.status === 'in_progress'
                  ? 'bg-accent'
                  : step.status === 'failed'
                    ? 'bg-danger'
                    : 'bg-border',
            )}
          />
        ))}
      </div>

      {mine > 0 && (
        <p className="mt-4 flex items-center gap-2 text-base text-text-muted">
          <Icon name="Info" size="md" className="shrink-0 text-accent" />
          {mine === 1
            ? 'One step is waiting on you. It is marked below.'
            : `${mine} steps are waiting on you. They are marked below.`}
        </p>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------- step */

const STATUS: Readonly<
  Record<OnboardingStep['status'], { icon: IconName; className: string; label: string }>
> = {
  done: { icon: 'CheckCircle2', className: 'text-success-text', label: 'Done' },
  in_progress: { icon: 'LoaderCircle', className: 'text-accent animate-spin', label: 'Running' },
  awaiting_specialist: { icon: 'Clock', className: 'text-warning-text', label: 'With a specialist' },
  failed: { icon: 'AlertCircle', className: 'text-danger-text', label: 'Failed' },
  pending: { icon: 'CircleDot', className: 'text-text-subtle', label: 'Queued' },
}

const OWNER: Readonly<Record<OnboardingStepOwner, { label: string; tone: BadgeTone } | null>> = {
  // Nobody needs telling that the platform is doing the platform's work.
  platform: null,
  specialist: { label: 'Your specialist', tone: 'warning' },
  merchant: { label: 'Needs you', tone: 'accent' },
}

function StepRow({ step, first }: { step: OnboardingStep; first: boolean }) {
  const dates = useDateFormat()
  const status = STATUS[step.status]
  const owner = OWNER[step.owner]
  const isDone = step.status === 'done'

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3.5',
        !first && 'border-t border-border',
        isDone && 'opacity-70',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', status.className)}>
        <Icon name={status.icon} size="lg" label={status.label} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn('text-base font-medium text-text', isDone && 'line-through decoration-text-subtle')}>
            {step.title}
          </p>
          {!isDone && owner && <Badge tone={owner.tone}>{owner.label}</Badge>}
        </div>
        <p className="mt-0.5 text-base text-text-muted">{step.description}</p>
        {step.completedAt && (
          <p className="mt-1 text-sm text-text-subtle">Finished {dates.dateTime(step.completedAt)}</p>
        )}
      </div>

      <div className="shrink-0">
        <StepAction step={step} />
      </div>
    </div>
  )
}

/**
 * What the merchant can do about this step.
 *
 * Keyed on the step id, which is a semantic identifier and safe to key on. A
 * step this build has no destination for simply offers nothing, which is the
 * right answer for one that genuinely has nowhere to go: nobody can hurry up a
 * card processor's verification queue from a dashboard.
 */
function StepAction({ step }: { step: OnboardingStep }) {
  const navigate = useNavigate()
  const terms = useTerms()
  const toast = useToast()
  const queryClient = useQueryClient()

  const retry = useMutation({
    mutationFn: () => onboardingApi.retryStep(step.id),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.onboarding(), next)
      toast.show({
        tone: 'success',
        title: 'Picked up',
        description: 'This is running again. It will update here on its own.',
      })
    },
    onError: (error) => {
      toast.show({ tone: 'danger', title: 'Nothing changed', description: error.message })
    },
  })

  if (step.status === 'done') return null

  if (step.status === 'failed' || step.status === 'awaiting_specialist') {
    return (
      <Button
        variant="outline"
        size="sm"
        loading={retry.isPending}
        iconStart="RotateCcw"
        onClick={() => retry.mutate()}
      >
        {step.status === 'failed' ? 'Try again' : 'Ask for an update'}
      </Button>
    )
  }

  if (step.owner !== 'merchant') return null

  const actions: Record<string, { label: string; to?: string; launch?: boolean }> = {
    staff_accounts: { label: 'Add your team', to: '/staff' },
    data_import: {
      label: `Check your ${terms.t('catalog_item', { plural: true, case: 'lower' })}`,
      to: '/products',
    },
    first_sale: { label: 'Open the till', launch: true },
  }
  const action = actions[step.id]
  if (!action) return null

  if (action.launch) {
    return (
      <Button
        variant="outline"
        size="sm"
        iconEnd="ArrowUpRight"
        onClick={() => window.open(launchTargets(import.meta.env).pos, '_blank', 'noreferrer')}
      >
        {action.label}
      </Button>
    )
  }

  return (
    <Button variant="outline" size="sm" iconEnd="ArrowRight" onClick={() => navigate(action.to ?? '/')}>
      {action.label}
    </Button>
  )
}
