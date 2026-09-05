import { useCallback, useMemo, useState } from 'react'
import { presetPeriod, previousPeriod, type Period, type PeriodPreset } from '@twentyfour/analytics'
import { cn, useDateFormat } from '@twentyfour/ui'

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'mtd', label: 'This month' },
]

/**
 * The period, and what it is being compared against.
 *
 * One row above the charts, and it names the comparison window explicitly.
 * A dashboard that says "up 12%" without saying against what is asking to be
 * misread.
 */
export function usePeriod(initial: PeriodPreset = '30d') {
  const [preset, setPreset] = useState<PeriodPreset>(initial)
  const period = useMemo(() => presetPeriod(preset), [preset])
  const comparison = useMemo(() => previousPeriod(period), [period])
  return { preset, setPreset, period, comparison }
}

export function PeriodPicker({
  preset,
  onChange,
  comparison,
  className,
}: {
  preset: PeriodPreset
  onChange: (preset: PeriodPreset) => void
  comparison: Period
  className?: string
}) {
  const dates = useDateFormat()
  const describe = useCallback(
    (period: Period) =>
      period.from === period.to ? dates.date(period.from) : `${dates.date(period.from)} to ${dates.date(period.to)}`,
    [dates],
  )

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <div role="radiogroup" aria-label="Period" className="inline-flex rounded-lg bg-surface-sunken p-0.5">
        {PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={preset === entry.id}
            onClick={() => onChange(entry.id)}
            className={cn(
              'h-8 rounded-md px-3 text-sm font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              preset === entry.id
                ? 'bg-surface text-text shadow-[var(--shadow-xs)]'
                : 'text-text-subtle hover:text-text',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-text-subtle">compared with {describe(comparison)}</p>
    </div>
  )
}
