import type { ReactNode } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icon'

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-2', className)}>
      <Icon name="LoaderCircle" size="lg" className="animate-spin text-text-subtle" />
      <span className="sr-only">{label ?? 'Loading'}</span>
    </span>
  )
}

/**
 * Reserves the space the content will occupy.
 *
 * A skeleton that is not the size of what replaces it is worse than a spinner:
 * the layout jumps at the moment the reader has started to look at it.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block rounded-md bg-surface-sunken',
        'bg-[linear-gradient(90deg,transparent,var(--color-neutral-200),transparent)] bg-[length:200%_100%]',
        'animate-[var(--animate-shimmer)] motion-reduce:animate-none',
        'dark:bg-[linear-gradient(90deg,transparent,var(--color-neutral-800),transparent)]',
        className,
      )}
    />
  )
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-4', index === lines - 1 ? 'w-3/5' : 'w-full')}
        />
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  icon?: IconName
  title: string
  /** Says what to do next, not just that there is nothing here. */
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon = 'Package', title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border',
        'px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-sunken text-text-subtle">
        <Icon name={icon} size="lg" />
      </span>
      <div className="max-w-sm">
        <p className="text-md font-semibold text-text">{title}</p>
        {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export interface ErrorStateProps {
  title?: string
  /** What went wrong and what to do about it. "Invalid input" is neither. */
  description?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

export function ErrorState({
  title = 'That did not load',
  description,
  onRetry,
  retryLabel = 'Try again',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-danger-border',
        'bg-danger-subtle px-6 py-10 text-center',
        className,
      )}
    >
      <Icon name="TriangleAlert" size="lg" className="text-danger-text" />
      <div className="max-w-sm">
        <p className="text-md font-semibold text-text">{title}</p>
        {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-base font-medium hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <Icon name="RefreshCw" size="sm" />
          {retryLabel}
        </button>
      )}
    </div>
  )
}
