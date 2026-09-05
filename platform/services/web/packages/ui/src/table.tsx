import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react'
import { cn } from './cn'

/**
 * Wraps a table so wide content scrolls inside its own box.
 *
 * The page body must never scroll sideways: on a phone that hides the primary
 * navigation and makes the whole layout feel broken.
 */
export function TableScroll({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('w-full overflow-x-auto overscroll-x-contain', className)}>{children}</div>
  )
}

export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn('w-full border-collapse text-base', className)} {...rest}>
      {children}
    </table>
  )
}

export function Th({
  className,
  numeric,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-border px-3 py-2.5 text-left align-bottom',
        'text-xs font-medium uppercase tracking-wide text-text-subtle',
        numeric && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  )
}

export function Td({
  className,
  numeric,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'border-b border-border px-3 py-3 align-middle text-text',
        numeric && 'tnum text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  )
}

export function Tr({
  className,
  interactive,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        interactive &&
          'cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-surface-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  )
}
