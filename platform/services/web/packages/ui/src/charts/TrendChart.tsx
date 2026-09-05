import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '../cn'
import { AXIS, GRID, seriesColour } from './palette'
import {
  ChartFrame, ChartLegend, ChartTooltip, niceTicks, useChartId, useMeasuredWidth,
  type TooltipState,
} from './primitives'

export interface TrendSeries {
  readonly key: string
  readonly label: string
  readonly values: readonly number[]
  /** Drawn as a dashed line without a fill. For a comparison period, which is
   *  context rather than a series in its own right. */
  readonly comparison?: boolean
}

export interface TrendChartProps {
  readonly labels: readonly string[]
  readonly series: readonly TrendSeries[]
  readonly formatValue: (value: number) => string
  readonly formatLabel?: (label: string, index: number) => string
  readonly title?: ReactNode
  readonly caption?: ReactNode
  readonly action?: ReactNode
  readonly height?: number
  /** Fills under the first series. Off for a plain comparison of lines. */
  readonly area?: boolean
  readonly className?: string
}

const PADDING = { top: 12, right: 12, bottom: 26, left: 52 }

/**
 * Change over time.
 *
 * Lines rather than bars, because the question is the shape of the trend and
 * not the magnitude of any single day. One y-axis, always: two measures of
 * different scale go in two charts, never on two scales in one, which is the
 * single commonest way a chart is made to say something untrue.
 */
export function TrendChart({
  labels, series, formatValue, formatLabel, title, caption, action,
  height = 240, area = true, className,
}: TrendChartProps) {
  const { attach, width } = useMeasuredWidth()
  const [hover, setHover] = useState<number | null>(null)
  const gradientId = useChartId('trend')

  const plotWidth = Math.max(40, width - PADDING.left - PADDING.right)
  const plotHeight = Math.max(40, height - PADDING.top - PADDING.bottom)

  const { max, ticks } = useMemo(() => {
    const highest = Math.max(1, ...series.flatMap((entry) => entry.values))
    const computed = niceTicks(highest)
    return { max: computed[computed.length - 1] as number, ticks: computed }
  }, [series])

  const xAt = (index: number): number =>
    labels.length <= 1 ? PADDING.left : PADDING.left + (index / (labels.length - 1)) * plotWidth
  const yAt = (value: number): number => PADDING.top + plotHeight - (value / max) * plotHeight

  const path = (values: readonly number[]): string =>
    values.map((value, index) => `${index === 0 ? 'M' : 'L'}${xAt(index)},${yAt(value)}`).join(' ')

  const legend = series.map((entry, index) => ({
    label: entry.label,
    colour: entry.comparison ? AXIS : seriesColour(index),
  }))

  const tooltip: TooltipState | null =
    hover === null
      ? null
      : {
          x: xAt(hover),
          y: PADDING.top,
          content: (
            <>
              <p className="font-medium text-text">
                {formatLabel ? formatLabel(labels[hover] as string, hover) : labels[hover]}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {series.map((entry, index) => (
                  <li key={entry.key} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-[2px]"
                        style={{ background: entry.comparison ? AXIS : seriesColour(index) }}
                      />
                      {entry.label}
                    </span>
                    <span className="tnum font-medium text-text">
                      {formatValue(entry.values[hover] ?? 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ),
        }

  // Enough ticks to orient, never so many they collide.
  const labelStride = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(plotWidth / 76))))

  return (
    <ChartFrame
      title={title}
      caption={caption}
      action={action}
      height={height}
      legend={<ChartLegend entries={legend} />}
      className={className}
    >
      <div ref={attach} className="absolute inset-0">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={
            typeof title === 'string'
              ? `${title}. ${series.map((entry) => entry.label).join(' and ')} over ${labels.length} points.`
              : 'Trend over time'
          }
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const position = event.clientX - box.left - PADDING.left
            const index = Math.round((position / plotWidth) * (labels.length - 1))
            setHover(Math.max(0, Math.min(labels.length - 1, index)))
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={seriesColour(0)} stopOpacity="0.22" />
              <stop offset="100%" stopColor={seriesColour(0)} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Recessive: the grid orients, it does not compete with the data. */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={PADDING.left + plotWidth}
                y1={yAt(tick)}
                y2={yAt(tick)}
                stroke={GRID}
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={yAt(tick) + 4}
                textAnchor="end"
                className="fill-text-subtle text-[10px]"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}

          {labels.map((label, index) =>
            index % labelStride === 0 ? (
              <text
                key={label + index}
                x={xAt(index)}
                y={height - 8}
                textAnchor="middle"
                className="fill-text-subtle text-[10px]"
              >
                {formatLabel ? formatLabel(label, index) : label}
              </text>
            ) : null,
          )}

          {area && series[0] && !series[0].comparison && (
            <path
              d={`${path(series[0].values)} L${xAt(labels.length - 1)},${PADDING.top + plotHeight} L${PADDING.left},${PADDING.top + plotHeight} Z`}
              fill={`url(#${gradientId})`}
            />
          )}

          {series.map((entry, index) => (
            <path
              key={entry.key}
              d={path(entry.values)}
              fill="none"
              stroke={entry.comparison ? AXIS : seriesColour(index)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={entry.comparison ? '4 4' : undefined}
            />
          ))}

          {hover !== null && (
            <>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={PADDING.top}
                y2={PADDING.top + plotHeight}
                stroke={AXIS}
                strokeWidth={1}
              />
              {series.map((entry, index) => (
                <circle
                  key={entry.key}
                  cx={xAt(hover)}
                  cy={yAt(entry.values[hover] ?? 0)}
                  r={4.5}
                  fill={entry.comparison ? AXIS : seriesColour(index)}
                  // A ring in the surface colour separates a marker from
                  // whatever it lands on top of.
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
            </>
          )}
        </svg>
        <ChartTooltip state={tooltip} width={width} />
      </div>
    </ChartFrame>
  )
}

/** A trend small enough to sit inside a table row. No axes, no tooltip: it
 *  shows direction, and the number beside it carries the magnitude. */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  tone = 'neutral',
  className,
}: {
  values: readonly number[]
  width?: number
  height?: number
  tone?: 'neutral' | 'good' | 'bad'
  className?: string
}) {
  if (values.length < 2) return <span className={cn('inline-block', className)} style={{ width, height }} />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 2) + 1
      const y = height - 2 - ((value - min) / span) * (height - 4)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const stroke =
    tone === 'good' ? 'var(--viz-good)' : tone === 'bad' ? 'var(--viz-critical)' : seriesColour(0)

  return (
    <svg width={width} height={height} className={cn('overflow-visible', className)} aria-hidden="true">
      <path d={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
