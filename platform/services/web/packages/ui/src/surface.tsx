import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icon'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** raised adds a shadow. On the dark theme the surface step carries the
   *  elevation instead, because a shadow is invisible on a dark ground. */
  raised?: boolean
  padded?: boolean
}

export function Card({ raised, padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface',
        raised && 'shadow-[var(--shadow-sm)]',
        padded && 'p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-md font-semibold text-text">{title}</h2>
        {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-text-muted border-border',
  accent: 'bg-accent-subtle text-accent-text border-accent-border',
  success: 'bg-success-subtle text-success-text border-success-border',
  warning: 'bg-warning-subtle text-warning-text border-warning-border',
  danger: 'bg-danger-subtle text-danger-text border-danger-border',
}

export interface BadgeProps {
  tone?: BadgeTone
  icon?: IconName
  /** Adds a filled dot. Status needs a second channel besides colour, or it
   *  disappears for anyone who cannot separate the hues. */
  dot?: boolean
  className?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', icon, dot, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  )
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-border', className)} />
}

/** A short mono label. Used for section eyebrows and technical values, never
 *  for prose: monospace at small sizes is harder to read in quantity. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'font-mono text-2xs font-medium uppercase tracking-[0.14em] text-text-subtle',
        className,
      )}
    >
      {children}
    </p>
  )
}

export function Avatar({
  name,
  colour,
  size = 'md',
  className,
}: {
  name: string
  colour?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
  const sizes = { sm: 'h-6 w-6 text-2xs', md: 'h-8 w-8 text-xs', lg: 'h-10 w-10 text-sm' }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        sizes[size],
        className,
      )}
      style={{ backgroundColor: colour ?? 'var(--color-neutral-500)' }}
    >
      {initials}
    </span>
  )
}
