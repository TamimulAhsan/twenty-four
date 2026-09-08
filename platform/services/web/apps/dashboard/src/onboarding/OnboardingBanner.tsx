import { useNavigate } from 'react-router'
import { Button, Card, Icon, cn } from '@twentyfour/ui'
import { formatRemaining, useOnboarding } from './useOnboarding'

/**
 * The strip at the top of the overview while setup is still running.
 *
 * A merchant on their first day opens the dashboard, not the checklist, and
 * the two numbers that matter to them on that day are how long is left and how
 * many steps are theirs. It disappears the moment the run finishes, and never
 * appears for a tenant that has been live for months.
 */
export function OnboardingBanner() {
  const navigate = useNavigate()
  const { running, done, total, mine, remainingMs, overdue } = useOnboarding()

  if (!running) return null

  return (
    <Card
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-3',
        overdue ? 'border-danger-border bg-danger-subtle' : 'border-accent-border bg-accent-subtle',
      )}
    >
      <span className={cn('shrink-0', overdue ? 'text-danger-text' : 'text-accent')}>
        <Icon name={overdue ? 'AlertCircle' : 'Clock'} size="xl" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-base font-medium text-text">
          {overdue ? 'Setup has run past twenty-four hours' : 'Setting you up'}
          <span className="font-normal text-text-muted">
            {' · '}
            <span className="tnum">
              {done} of {total}
            </span>{' '}
            done
            {!overdue && ` · ${formatRemaining(remainingMs)}`}
          </span>
        </p>
        <p className="mt-0.5 text-base text-text-muted">
          {overdue
            ? 'Your first month is free. A specialist is still on it.'
            : mine > 0
              ? mine === 1
                ? 'One step is waiting on you.'
                : `${mine} steps are waiting on you.`
              : 'Nothing needs you right now. A specialist is working through it.'}
        </p>
      </div>

      <Button
        size="sm"
        variant="outline"
        iconEnd="ArrowRight"
        className="shrink-0"
        onClick={() => navigate('/onboarding')}
      >
        See what is left
      </Button>
    </Card>
  )
}
