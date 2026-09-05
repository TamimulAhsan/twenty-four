import { Button, EmptyState } from '@twentyfour/ui'

/**
 * A route that exists but is not built yet, and says so plainly.
 *
 * The alternative is a dead link or a form that fails on submit, both of which
 * cost a support conversation to explain.
 */
export function Pending({ title, waitingOn }: { title: string; waitingOn: string }) {
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <EmptyState
        icon="Clock"
        title={title}
        description={`Not built yet. This is waiting on ${waitingOn}.`}
        action={<Button onClick={() => window.location.assign('/auth')}>Back to sign in</Button>}
      />
    </div>
  )
}
