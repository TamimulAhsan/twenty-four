import type { ReactNode } from 'react'
import { cn } from '../cn'
import { seriesColour, STATUS } from './palette'

export interface RankRow {
  readonly key: string
  readonly label: string
  readonly value: number
  /** Shown at the end of the bar. The figure is always visible, so the bar is
   *  a shape that helps rather than the only way to read the number. */
  readonly display: ReactNode
  readonly meta?: ReactNode
  readonly tone?: 'series' | 'good' | 'warning' | 'critical'
}

/**
 * A ranking.
 *
 * Horizontal, because the labels are names and names read horizontally. Every
 * row is directly labelled with its own value, which is also what discharges
 * the contrast obligation on the lighter hues: nothing here depends on
 * telling two colours apart.
 */
export function RankBars({
  rows,
  emptyLabel = 'Nothing to rank yet',
  className,
}: {
  rows: readonly RankRow[]
  emptyLabel?: string
  className?: string
}) {
  if (rows.length === 0) {
    return <p className={cn('py-6 text-center text-base text-text-subtle', className)}>{emptyLabel}</p>
  }

  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1)

  return (
    <ul className={cn('flex flex-col gap-2.5', className)}>
      {rows.map((row, index) => {
        const colour =
          row.tone === 'good'
            ? STATUS.good
            : row.tone === 'warning'
              ? STATUS.warning
              : row.tone === 'critical'
                ? STATUS.critical
                : seriesColour(index)
        return (
          <li key={row.key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-base text-text">{row.label}</span>
              <span className="tnum shrink-0 text-base font-medium text-text">{row.display}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  // Rounded data-end anchored to the baseline: the bar starts
                  // square at zero and rounds where the value ends.
                  className="h-full rounded-r-full"
                  style={{
                    width: `${Math.max(1.5, (Math.abs(row.value) / max) * 100)}%`,
                    background: colour,
                  }}
                />
              </div>
              {row.meta && <span className="shrink-0 text-sm text-text-subtle">{row.meta}</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A single bar split into shares.
 *
 * For a mix that adds to a whole, where a donut would make the reader compare
 * angles. A 2px gap in the surface colour separates the segments so adjacent
 * fills never blend into one another.
 */
export function ShareBar({
  segments,
  className,
}: {
  segments: ReadonlyArray<{ key: string; label: string; value: number; display?: ReactNode }>
  className?: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  if (total <= 0) return null

  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: seriesColour(index),
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment, index) => (
          <li key={segment.key} className="flex items-center gap-1.5 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: seriesColour(index) }}
            />
            <span className="text-text-muted">{segment.label}</span>
            <span className="tnum font-medium text-text">
              {segment.display ?? `${Math.round((segment.value / total) * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
