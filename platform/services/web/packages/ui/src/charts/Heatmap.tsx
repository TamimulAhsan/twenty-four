import { useState, type ReactNode } from 'react'
import { cn } from '../cn'
import { sequentialStep } from './palette'
import { ChartFrame, ChartTooltip, type TooltipState } from './primitives'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface HeatmapCell {
  readonly weekday: number
  readonly hour: number
  readonly value: number
  readonly detail?: ReactNode
}

/**
 * When the business is busy.
 *
 * A weekday by hour grid, which is the shape that decides a rota. A revenue
 * line by day cannot answer "should anyone be here at four on a Tuesday".
 *
 * Sequential, one hue light to dark, because this is magnitude and not
 * identity. A rainbow here would imply categories that do not exist.
 */
export function Heatmap({
  cells,
  formatValue,
  title,
  caption,
  fromHour = 6,
  toHour = 22,
  className,
}: {
  cells: readonly HeatmapCell[]
  formatValue: (value: number) => string
  title?: ReactNode
  caption?: ReactNode
  fromHour?: number
  toHour?: number
  className?: string
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const hours = Array.from({ length: toHour - fromHour + 1 }, (_, index) => fromHour + index)
  const max = Math.max(1, ...cells.map((cell) => cell.value))
  const lookup = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell]))

  // Monday first: a trading week is read Monday to Sunday, whatever
  // Date.getDay thinks.
  const rows = [1, 2, 3, 4, 5, 6, 0]

  return (
    <ChartFrame title={title} caption={caption} height={rows.length * 26 + 26} className={className}>
      <div className="absolute inset-0 overflow-x-auto">
        <div className="min-w-max">
          <div className="flex">
            <div className="w-9 shrink-0" />
            {hours.map((hour) => (
              <div
                key={hour}
                className="tnum w-6 shrink-0 text-center text-[10px] text-text-subtle"
              >
                {hour % 3 === 0 ? hour : ''}
              </div>
            ))}
          </div>

          {rows.map((weekday) => (
            <div key={weekday} className="flex items-center">
              <div className="w-9 shrink-0 pr-1.5 text-right text-[10px] text-text-subtle">
                {WEEKDAYS[weekday]}
              </div>
              {hours.map((hour) => {
                const cell = lookup.get(`${weekday}:${hour}`)
                const value = cell?.value ?? 0
                return (
                  <button
                    key={hour}
                    type="button"
                    aria-label={`${WEEKDAYS[weekday]} ${hour}:00, ${formatValue(value)}`}
                    className={cn(
                      'm-[1px] h-5 w-[22px] shrink-0 rounded-[3px]',
                      'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                    )}
                    style={{
                      background: value === 0 ? 'var(--surface-sunken)' : sequentialStep(value / max),
                    }}
                    onMouseEnter={(event) => {
                      const box = event.currentTarget.getBoundingClientRect()
                      const parent = event.currentTarget.closest('div.absolute')?.getBoundingClientRect()
                      setTooltip({
                        x: box.left - (parent?.left ?? 0) + 12,
                        y: box.top - (parent?.top ?? 0),
                        content: (
                          <>
                            <p className="font-medium text-text">
                              {WEEKDAYS[weekday]}, {String(hour).padStart(2, '0')}:00
                            </p>
                            <p className="tnum mt-0.5 text-text-muted">{formatValue(value)}</p>
                            {cell?.detail}
                          </>
                        ),
                      })
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                )
              })}
            </div>
          ))}
        </div>
        <ChartTooltip state={tooltip} width={640} />
      </div>
    </ChartFrame>
  )
}
