/**
 * Chart colour, by the job it does.
 *
 * Four jobs, four rules. Categorical for identity, sequential for magnitude,
 * diverging for polarity, status for state. Mixing them is the commonest way a
 * chart stops meaning anything: a rainbow sequential ramp implies categories
 * that are not there, and a status red used as "series 4" makes a normal
 * quantity look like an alarm.
 *
 * The values live in theme.css so light and dark swap in one place. Both sets
 * are validated: worst adjacent CVD deltaE 9.1 light, 8.4 dark, against a 8.0
 * target, and normal-vision separation of 19.6 and 19.3 against a 15 floor.
 */

/** Assigned in fixed order and never cycled. Colour follows the entity, not
 *  its rank, so a filter that removes a series must not repaint the rest. */
export const SERIES = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
  'var(--viz-7)',
  'var(--viz-8)',
] as const

export const MAX_SERIES = SERIES.length

/**
 * Forms that put every pair of colours side by side, such as a scatter, cannot
 * carry the full eight: with all pairs in play no ordering clears the
 * separation floors. The first three do. Past three, fold to Other or facet.
 */
export const MAX_SCATTER_SERIES = 3

export function seriesColour(index: number): string {
  return SERIES[index % SERIES.length] as string
}

/** One hue, light to dark. For magnitude only. */
export const SEQUENTIAL = [
  'var(--viz-seq-1)',
  'var(--viz-seq-2)',
  'var(--viz-seq-3)',
  'var(--viz-seq-4)',
  'var(--viz-seq-5)',
  'var(--viz-seq-6)',
  'var(--viz-seq-7)',
] as const

/** Steps a 0 to 1 magnitude onto the ramp. */
export function sequentialStep(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return SEQUENTIAL[0]
  const index = Math.min(SEQUENTIAL.length - 1, Math.floor(fraction * SEQUENTIAL.length))
  return SEQUENTIAL[index] as string
}

/** Reserved. Never a series colour, and never shown without a label or icon. */
export const STATUS = {
  good: 'var(--viz-good)',
  warning: 'var(--viz-warning)',
  critical: 'var(--viz-critical)',
} as const

export const GRID = 'var(--viz-grid)'
export const AXIS = 'var(--viz-axis)'
