import { cn } from '@twentyfour/ui'

/**
 * The mark: a square with a quarter turned out of it.
 *
 * A quarter of the circle is six hours and four of them is the promise.
 * Geometric rather than illustrative, so it holds at 20px in a sidebar and at
 * 14px in a favicon.
 *
 * `tone` exists because a mark that follows the theme disappears on a surface
 * that does not. Fixed dark canvases get a fixed mark.
 */
export type BrandTone = 'auto' | 'light'

export function BrandMark({ tone = 'auto', className }: { tone?: BrandTone; className?: string }) {
  const onDark = tone === 'light'
  const glyph = onDark ? 'var(--color-neutral-950)' : 'var(--surface)'
  return (
    <span
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-lg',
        onDark ? 'bg-white' : 'bg-surface-inverse',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke={glyph} strokeWidth="2.5" opacity="0.4" />
        <path d="M12 4 A8 8 0 0 1 20 12 L12 12 Z" fill={glyph} />
      </svg>
    </span>
  )
}

export function Wordmark({
  tone = 'auto',
  suffix,
  className,
}: {
  tone?: BrandTone
  /** Names the application when it is not the dashboard, e.g. "Point of sale". */
  suffix?: string
  className?: string
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <BrandMark tone={tone} />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn(
            'text-md font-semibold tracking-[-0.03em]',
            tone === 'light' ? 'text-white' : 'text-text',
          )}
        >
          TwentyFour
        </span>
        {suffix && (
          <span
            className={cn(
              'truncate text-sm font-medium',
              tone === 'light' ? 'text-neutral-400' : 'text-text-subtle',
            )}
          >
            {suffix}
          </span>
        )}
      </span>
    </span>
  )
}
