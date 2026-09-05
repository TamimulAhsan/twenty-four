import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { formatMoney, formatMoneyParts, formatNumber, type Money } from '@twentyfour/money'
import { cn } from './cn'

/**
 * Locale for the whole app, taken from the business profile.
 *
 * Not the browser's. A Hungarian merchant serving a German tourist still reads
 * their own till in Hungarian, and there is no country check anywhere: the
 * locale is a value on the tenant, the same as its name.
 */
export interface FormatContextValue {
  readonly locale: string
  readonly currency: string
  readonly timezone: string
}

const FormatContext = createContext<FormatContextValue | null>(null)

export function FormatProvider({
  locale,
  currency,
  timezone,
  children,
}: FormatContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, currency, timezone }), [locale, currency, timezone])
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>
}

export function useFormat(): FormatContextValue {
  const value = useContext(FormatContext)
  if (!value) throw new Error('useFormat must be used inside a FormatProvider')
  return value
}

export interface MoneyTextProps {
  value: Money
  /** Renders the currency symbol smaller and quieter than the figure, which is
   *  what a large total wants. Ignored at small sizes. */
  deemphasiseSymbol?: boolean
  /** Colours a negative amount. Off by default: a refund column is already
   *  labelled, and colouring every figure turns a table into a traffic light. */
  signed?: boolean
  display?: 'symbol' | 'code' | 'none'
  compact?: boolean
  className?: string
}

/**
 * Renders an amount.
 *
 * Always tabular, so a column of figures lines up and a total that changes
 * does not shift its neighbours sideways.
 */
export function MoneyText({
  value,
  deemphasiseSymbol,
  signed,
  display = 'symbol',
  compact,
  className,
}: MoneyTextProps) {
  const { locale } = useFormat()
  const negative = value.minor < 0
  const classes = cn(
    'tnum whitespace-nowrap',
    signed && negative && 'text-danger-text',
    signed && !negative && 'text-success-text',
    className,
  )

  if (!deemphasiseSymbol) {
    return (
      <span className={classes} data-numeric="">
        {formatMoney(value, { locale, display, ...(compact ? { compact } : {}) })}
      </span>
    )
  }

  const parts = formatMoneyParts(value, { locale, display, ...(compact ? { compact } : {}) })
  return (
    <span className={classes} data-numeric="">
      {parts.map((part, index) =>
        part.type === 'currency' ? (
          <span key={index} className="text-[0.62em] font-medium text-text-subtle">
            {part.value}
          </span>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </span>
  )
}

export function NumberText({
  value,
  className,
  options,
}: {
  value: number
  className?: string
  options?: Intl.NumberFormatOptions
}) {
  const { locale } = useFormat()
  return (
    <span className={cn('tnum', className)} data-numeric="">
      {formatNumber(value, locale, options)}
    </span>
  )
}

export function useDateFormat() {
  const { locale, timezone } = useFormat()
  return useMemo(
    () => ({
      time: (value: string | Date) =>
        new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
        }).format(new Date(value)),
      date: (value: string | Date) =>
        new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          timeZone: timezone,
        }).format(new Date(value)),
      dateLong: (value: string | Date) =>
        new Intl.DateTimeFormat(locale, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: timezone,
        }).format(new Date(value)),
      dateTime: (value: string | Date) =>
        new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
        }).format(new Date(value)),
    }),
    [locale, timezone],
  )
}
