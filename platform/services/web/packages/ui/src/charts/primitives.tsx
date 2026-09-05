import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn'

/**
 * The frame every chart sits in.
 *
 * Carries the title, the legend and the tooltip layer, so a chart component
 * only has to draw its marks. A chart is read before it is understood, so the
 * title says what it shows and the caption says what it means.
 */
export function ChartFrame({
  title,
  caption,
  legend,
  action,
  height = 220,
  children,
  className,
}: {
  title?: ReactNode
  caption?: ReactNode
  legend?: ReactNode
  action?: ReactNode
  height?: number
  children: ReactNode
  className?: string
}) {
  return (
    <figure className={cn('m-0 flex flex-col gap-3', className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && <figcaption className="text-md font-semibold text-text">{title}</figcaption>}
            {caption && <p className="mt-0.5 text-sm text-text-muted">{caption}</p>}
          </div>
          {action}
        </div>
      )}
      {legend}
      <div className="relative w-full" style={{ height }}>
        {children}
      </div>
    </figure>
  )
}

export interface LegendEntry {
  readonly label: string
  readonly colour: string
  readonly value?: ReactNode
}

/**
 * Always present for two or more series.
 *
 * Identity is never carried by colour alone: the swatch sits beside a text
 * label in ordinary ink, and the label is what a reader who cannot separate
 * the hues uses.
 */
export function ChartLegend({ entries, className }: { entries: readonly LegendEntry[]; className?: string }) {
  if (entries.length < 2) return null
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-sm text-text-muted">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: entry.colour }}
          />
          {entry.label}
          {entry.value !== undefined && <span className="tnum text-text">{entry.value}</span>}
        </li>
      ))}
    </ul>
  )
}

export interface TooltipState {
  readonly x: number
  readonly y: number
  readonly content: ReactNode
}

/** Follows the pointer inside the plot, flipping side near the right edge so
 *  it never leaves the frame. */
export function ChartTooltip({ state, width }: { state: TooltipState | null; width: number }) {
  if (!state) return null
  const flip = state.x > width * 0.62
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none absolute z-10 min-w-32 max-w-64 rounded-lg border border-border',
        'bg-surface-raised p-2.5 text-sm shadow-[var(--shadow-lg)]',
      )}
      style={{
        left: flip ? undefined : state.x + 12,
        right: flip ? width - state.x + 12 : undefined,
        top: Math.max(0, state.y - 12),
      }}
    >
      {state.content}
    </div>
  )
}

/** Measures the element so charts can be drawn in real pixels rather than in a
 *  viewBox that stretches the type along with the marks. */
export function useMeasuredWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallback)

  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured && measured > 0) setWidth(measured)
    })
    observer.observe(node)
    setWidth(node.getBoundingClientRect().width || fallback)
  }, [fallback])

  return { attach, width }
}

export function useChartId(prefix: string): string {
  const id = useId().replace(/:/g, '')
  return `${prefix}-${id}`
}

/** Nice round axis ticks, so a scale reads 0, 5k, 10k rather than 0, 4.3k. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const rough = max / count
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? magnitude * 10
  const ticks: number[] = []
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(value)
  return ticks
}
