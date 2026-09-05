/**
 * Periods and comparison.
 *
 * Every figure on an analytics screen is meaningless without something to
 * compare it against, so a period always carries its own predecessor of equal
 * length. Comparing a 30-day window to a calendar month is the commonest way
 * a dashboard lies.
 */
export interface Period {
  /** Inclusive, YYYY-MM-DD. */
  readonly from: string
  /** Inclusive, YYYY-MM-DD. */
  readonly to: string
}

export type PeriodPreset = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'ytd'

const iso = (date: Date): string => date.toISOString().slice(0, 10)

function shift(days: number, from = new Date()): Date {
  const date = new Date(from)
  date.setDate(date.getDate() + days)
  return date
}

export function presetPeriod(preset: PeriodPreset, now = new Date()): Period {
  const today = iso(now)
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: iso(shift(-6, now)), to: today }
    case '30d':
      return { from: iso(shift(-29, now)), to: today }
    case '90d':
      return { from: iso(shift(-89, now)), to: today }
    case 'mtd': {
      const first = new Date(now)
      first.setDate(1)
      return { from: iso(first), to: today }
    }
    case 'ytd': {
      const first = new Date(now)
      first.setMonth(0, 1)
      return { from: iso(first), to: today }
    }
  }
}

export function dayCount(period: Period): number {
  const from = Date.parse(`${period.from}T00:00:00Z`)
  const to = Date.parse(`${period.to}T00:00:00Z`)
  return Math.round((to - from) / 86_400_000) + 1
}

/**
 * The equal-length window immediately before this one.
 *
 * Equal length rather than "the same period last month", because a 31-day
 * month against a 28-day one moves every figure for a reason that has nothing
 * to do with the business.
 */
export function previousPeriod(period: Period): Period {
  const days = dayCount(period)
  const from = new Date(`${period.from}T00:00:00Z`)
  const previousTo = new Date(from)
  previousTo.setUTCDate(previousTo.getUTCDate() - 1)
  const previousFrom = new Date(previousTo)
  previousFrom.setUTCDate(previousFrom.getUTCDate() - (days - 1))
  return { from: iso(previousFrom), to: iso(previousTo) }
}

export function containsDay(period: Period, day: string): boolean {
  return day >= period.from && day <= period.to
}

/** Every day in the period, so a chart has a zero rather than a gap. */
export function eachDay(period: Period): string[] {
  const out: string[] = []
  const cursor = new Date(`${period.from}T00:00:00Z`)
  const end = new Date(`${period.to}T00:00:00Z`)
  while (cursor <= end) {
    out.push(iso(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Fractional change, or null when there is nothing to compare against.
 *
 * null rather than 0 or Infinity: "up from nothing" is not a percentage, and
 * rendering it as +100% or as a blank both mislead. The caller has to decide
 * what to show, which is the point.
 */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return null
  return (current - previous) / previous
}
