import { useQuery } from '@tanstack/react-query'
import { onboarding as onboardingApi, queryKeys, type OnboardingState } from '@twentyfour/api'
import { useBootstrap } from '@twentyfour/runtime'
import { formatRemaining, useTicker } from '@twentyfour/ui'

// Re-exported so the pages that read this hook keep one import. The formatter
// itself moved into the design system: the admin console counts down the same
// deadline, and two wordings for one promise is one too many.
export { formatRemaining }

export interface OnboardingProgress {
  readonly state: OnboardingState | null
  /** There is a run, and it has not finished. */
  readonly running: boolean
  readonly done: number
  readonly total: number
  /** Steps waiting on the merchant, still to do. The only number they can act on. */
  readonly mine: number
  /** Milliseconds to the deadline the guarantee is measured against. Never
   *  negative: past the deadline the figure to show is how far past. */
  readonly remainingMs: number
  readonly overdue: boolean
  readonly isPending: boolean
}

/**
 * The 24-hour run, as the dashboard sees it.
 *
 * Seeded from the bootstrap call, which already carries it, so the sidebar and
 * the banner draw on first paint rather than after a second round trip. It
 * then polls, because most of these steps are finished by somebody else and a
 * checklist that only moves on reload is a screenshot.
 *
 * Polling stops the moment the run completes. A tenant that went live months
 * ago has no run at all, and asks for nothing.
 */
export function useOnboarding(): OnboardingProgress {
  const { onboarding: seeded } = useBootstrap()

  const query = useQuery({
    queryKey: queryKeys.onboarding(),
    queryFn: onboardingApi.get,
    enabled: seeded !== null,
    initialData: seeded ?? undefined,
    refetchInterval: (result) => (result.state.data?.completedAt ? false : 15_000),
  })

  const state = query.data ?? null
  // Re-rendered on a timer so the countdown moves on its own. Every thirty
  // seconds: a merchant reads "19 hours left", not a stopwatch, and a
  // per-second tick would re-render the sidebar all day for no one.
  const now = useTicker(state !== null && !state.completedAt ? 30_000 : null)

  const steps = state?.steps ?? []
  const remaining = state ? new Date(state.dueAt).getTime() - now : 0

  return {
    state,
    running: state !== null && state.completedAt === null,
    done: steps.filter((step) => step.status === 'done').length,
    total: steps.length,
    mine: steps.filter((step) => step.owner === 'merchant' && step.status !== 'done').length,
    remainingMs: Math.max(0, remaining),
    overdue: state !== null && state.completedAt === null && remaining <= 0,
    // A disabled query never leaves pending, so asking the query alone would
    // hold a live tenant on a skeleton forever. There is no loading phase in
    // practice either way: bootstrap already carried the run in.
    isPending: seeded !== null && query.isPending,
  }
}
