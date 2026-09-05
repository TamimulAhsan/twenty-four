import { Icon, cn } from '@twentyfour/ui'

/**
 * A change against the comparison period.
 *
 * Direction is carried by an arrow as well as a colour, and "no comparison" is
 * shown as such rather than as zero. `goodWhenUp` exists because a rise in
 * refunds is not good news, and colouring every increase green is how a
 * dashboard quietly congratulates a business on its own problems.
 */
export function Delta({
  value,
  goodWhenUp = true,
  className,
}: {
  value: number | null
  goodWhenUp?: boolean
  className?: string
}) {
  if (value === null) {
    return (
      <span className={cn('text-sm text-text-subtle', className)}>no comparison</span>
    )
  }

  const rising = value > 0.0005
  const falling = value < -0.0005
  const good = rising ? goodWhenUp : falling ? !goodWhenUp : null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium',
        good === true && 'text-success-text',
        good === false && 'text-danger-text',
        good === null && 'text-text-muted',
        className,
      )}
    >
      <Icon name={rising ? 'TrendingUp' : falling ? 'TrendingDown' : 'Minus'} size="sm" />
      <span className="tnum">
        {rising ? '+' : ''}
        {(value * 100).toFixed(value > -0.1 && value < 0.1 ? 1 : 0)}%
      </span>
    </span>
  )
}
