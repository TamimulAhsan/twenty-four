import { useEffect, useState } from 'react'

const HOUR_MS = 60 * 60 * 1000

/**
 * A clock that only ticks while something is watching it.
 *
 * Pass null to stop. A countdown that has run out, or a run that has finished,
 * should not keep re-rendering a page nobody is reading.
 */
export function useTicker(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs === null) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/**
 * How long is left, in words.
 *
 * Hours until the last one, then minutes. Nobody needs to know there are 47
 * minutes left when there are nineteen hours, and everybody needs to know it
 * when there are not.
 *
 * Shared rather than written twice, because the merchant's dashboard and the
 * specialist's console are counting down the same promise. Two wordings means
 * two people on the same phone call reading different numbers off the same
 * deadline.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'past due'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min left`
  // Rounded once the figure is coarse anyway. Flooring reads as a whole hour
  // less than the truth at the top of every hour, which on a promise measured
  // in hours is the wrong direction to be wrong in.
  if (ms >= 6 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} h left`
  const hours = Math.floor(ms / HOUR_MS)
  const rest = Math.round((ms - hours * HOUR_MS) / 60_000)
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`
}

/** Minutes and seconds, for a support token that expires while you watch. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
