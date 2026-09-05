import type { ReactNode } from 'react'
import type { Money } from '@twentyfour/money'
import { cn } from './cn'
import { Icon, type IconName } from './icon'
import { MoneyText } from './format'
import { Skeleton } from './feedback'

export interface StatTileProps {
  label: string
  value?: ReactNode
  money?: Money
  icon?: IconName
  /** Fractional change against the comparison period, e.g. 0.12 for +12%. */
  delta?: number | null
  deltaLabel?: string
  loading?: boolean
  className?: string
}

/**
 * One figure, its label, and how it moved.
 *
 * Direction is carried by an arrow as well as a colour, because colour alone
 * says nothing to a reader who cannot separate red from green.
 */
export function StatTile({
  label,
  value,
  money,
  icon,
  delta,
  deltaLabel,
  loading,
  className,
}: StatTileProps) {
  const rising = delta !== null && delta !== undefined && delta > 0
  const falling = delta !== null && delta !== undefined && delta < 0

  return (
    <div className={cn('rounded-xl border border-border bg-surface p-4 sm:p-5', className)}>
      <div className="flex items-center gap-2 text-text-muted">
        {icon && <Icon name={icon} size="md" />}
        <p className="text-sm font-medium">{label}</p>
      </div>

      <div className="mt-2.5 text-2xl font-semibold tracking-[-0.02em] text-text sm:text-3xl">
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : money ? (
          <MoneyText value={money} deemphasiseSymbol />
        ) : (
          <span className="tnum">{value}</span>
        )}
      </div>

      {!loading && (delta !== null && delta !== undefined) && (
        <div
          className={cn(
            'mt-2 inline-flex items-center gap-1 text-sm font-medium',
            rising && 'text-success-text',
            falling && 'text-danger-text',
            !rising && !falling && 'text-text-muted',
          )}
        >
          <Icon
            name={rising ? 'TrendingUp' : falling ? 'TrendingDown' : 'Minus'}
            size="sm"
          />
          <span className="tnum">
            {rising ? '+' : ''}
            {Math.round(delta * 100)}%
          </span>
          {deltaLabel && <span className="font-normal text-text-subtle">{deltaLabel}</span>}
        </div>
      )}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.025em] text-text sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
