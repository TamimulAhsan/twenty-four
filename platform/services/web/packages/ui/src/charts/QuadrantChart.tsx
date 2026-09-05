import { useState, type ReactNode } from 'react'
import { seriesColour, AXIS, GRID, MAX_SCATTER_SERIES } from './palette'
import { ChartFrame, ChartLegend, ChartTooltip, useMeasuredWidth, type TooltipState } from './primitives'

export interface QuadrantPoint {
  readonly key: string
  readonly label: string
  /** Horizontal position, already a 0 to 1 fraction. */
  readonly x: number
  /** Vertical position, already a 0 to 1 fraction. */
  readonly y: number
  /** Group index, capped at three: with every pair of colours on screen at
   *  once no ordering of the full palette clears the separation floors. */
  readonly group: number
  readonly detail?: ReactNode
}

const PADDING = { top: 20, right: 20, bottom: 34, left: 30 }

/**
 * Two measures against each other, with the quadrants named.
 *
 * A scatter answers "which of these is unlike the others", which no ranking
 * can. The quadrant labels are the point: a dot in the top left is a decision,
 * not a data point, and saying which decision is the whole job.
 *
 * Capped at three groups. Unlike a line chart, a scatter puts every pair of
 * colours side by side, and past three the palette cannot keep them apart for
 * a colourblind reader.
 */
export function QuadrantChart({
  points,
  groups,
  xLabel,
  yLabel,
  quadrants,
  title,
  caption,
  height = 320,
}: {
  points: readonly QuadrantPoint[]
  groups: ReadonlyArray<{ label: string }>
  xLabel: string
  yLabel: string
  /** Clockwise from top left. */
  quadrants: readonly [string, string, string, string]
  title?: ReactNode
  caption?: ReactNode
  height?: number
}) {
  const { attach, width } = useMeasuredWidth()
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const plotWidth = Math.max(40, width - PADDING.left - PADDING.right)
  const plotHeight = Math.max(40, height - PADDING.top - PADDING.bottom)
  const xAt = (value: number) => PADDING.left + value * plotWidth
  const yAt = (value: number) => PADDING.top + plotHeight - value * plotHeight

  const capped = groups.slice(0, MAX_SCATTER_SERIES)

  return (
    <ChartFrame
      title={title}
      caption={caption}
      height={height}
      legend={
        <ChartLegend
          entries={capped.map((group, index) => ({ label: group.label, colour: seriesColour(index) }))}
        />
      }
    >
      <div ref={attach} className="absolute inset-0">
        <svg width={width} height={height} role="img" aria-label={`${yLabel} against ${xLabel}`}>
          <line
            x1={xAt(0.5)} x2={xAt(0.5)} y1={PADDING.top} y2={PADDING.top + plotHeight}
            stroke={GRID} strokeWidth={1} strokeDasharray="3 3"
          />
          <line
            x1={PADDING.left} x2={PADDING.left + plotWidth} y1={yAt(0.5)} y2={yAt(0.5)}
            stroke={GRID} strokeWidth={1} strokeDasharray="3 3"
          />

          {/* Naming the quadrants is what turns a cloud of dots into a
              decision. Set quietly, so they orient without competing. */}
          <text x={xAt(0.02)} y={yAt(0.96)} className="fill-text-subtle text-[10px] uppercase tracking-wide">
            {quadrants[0]}
          </text>
          <text x={xAt(0.98)} y={yAt(0.96)} textAnchor="end" className="fill-text-subtle text-[10px] uppercase tracking-wide">
            {quadrants[1]}
          </text>
          <text x={xAt(0.98)} y={yAt(0.03)} textAnchor="end" className="fill-text-subtle text-[10px] uppercase tracking-wide">
            {quadrants[2]}
          </text>
          <text x={xAt(0.02)} y={yAt(0.03)} className="fill-text-subtle text-[10px] uppercase tracking-wide">
            {quadrants[3]}
          </text>

          <line x1={PADDING.left} x2={PADDING.left + plotWidth} y1={PADDING.top + plotHeight} y2={PADDING.top + plotHeight} stroke={AXIS} strokeWidth={1} />
          <line x1={PADDING.left} x2={PADDING.left} y1={PADDING.top} y2={PADDING.top + plotHeight} stroke={AXIS} strokeWidth={1} />

          <text x={PADDING.left + plotWidth / 2} y={height - 6} textAnchor="middle" className="fill-text-muted text-[11px]">
            {xLabel}
          </text>
          <text
            x={-(PADDING.top + plotHeight / 2)}
            y={11}
            textAnchor="middle"
            transform="rotate(-90)"
            className="fill-text-muted text-[11px]"
          >
            {yLabel}
          </text>

          {points.map((point) => (
            <circle
              key={point.key}
              cx={xAt(Math.max(0, Math.min(1, point.x)))}
              cy={yAt(Math.max(0, Math.min(1, point.y)))}
              r={6}
              fill={seriesColour(Math.min(point.group, MAX_SCATTER_SERIES - 1))}
              fillOpacity={0.85}
              stroke="var(--surface)"
              strokeWidth={2}
              onMouseEnter={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                const parent = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                setTooltip({
                  x: box.left - (parent?.left ?? 0),
                  y: box.top - (parent?.top ?? 0),
                  content: (
                    <>
                      <p className="font-medium text-text">{point.label}</p>
                      {point.detail}
                    </>
                  ),
                })
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </svg>
        <ChartTooltip state={tooltip} width={width} />
      </div>
    </ChartFrame>
  )
}
