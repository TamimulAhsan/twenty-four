import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icon'

/**
 * Base control styling.
 *
 * text-md below sm and text-base above is deliberate. iOS zooms the viewport
 * when a focused input is under 16px, which on a phone throws the whole layout
 * sideways mid-typing.
 */
const CONTROL = cn(
  'w-full rounded-lg border border-border-strong bg-surface px-3',
  'text-md sm:text-base text-text placeholder:text-text-subtle',
  'transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
  'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/18',
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-60',
  'read-only:bg-surface-sunken read-only:text-text-muted',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/18',
)

export interface FieldProps {
  label: string
  htmlFor?: string
  /** Persistent, not a placeholder. A hint that vanishes on focus is a hint
   *  nobody reads while they are typing. */
  hint?: ReactNode
  error?: string
  required?: boolean
  /** Distinct from disabled: read-only still gets read out and copied. */
  className?: string
  children: ReactNode
}

export function Field({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
        {required && (
          <span className="ml-1 text-danger-text" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children}
      {/* Errors replace the hint rather than stacking, and sit against the
          field they belong to rather than in a summary at the top. */}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-text">
          <Icon name="AlertCircle" size="sm" className="mt-px shrink-0" />
          {error}
        </p>
      ) : (
        hint && <p className="text-sm text-text-muted">{hint}</p>
      )}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  hint?: ReactNode
  error?: string
  iconStart?: IconName
  /** Rendered inside the control, e.g. a currency code or a unit. */
  suffix?: ReactNode
  /** Aligns figures and switches to tabular numerals. For amounts and counts. */
  numeric?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, iconStart, suffix, numeric, className, id, required, ...rest },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId

  const control = (
    <div className="relative flex items-center">
      {iconStart && (
        <span className="pointer-events-none absolute left-3 text-text-subtle">
          <Icon name={iconStart} size="md" />
        </span>
      )}
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(
          CONTROL,
          'h-11',
          iconStart && 'pl-9',
          suffix && 'pr-14',
          numeric && 'tnum text-right',
          className,
        )}
        {...rest}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 text-sm text-text-subtle">
          {suffix}
        </span>
      )}
    </div>
  )

  if (!label) return control
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} required={required}>
      {control}
    </Field>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: ReactNode
  error?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, required, rows = 3, ...rest },
  ref,
) {
  const generatedId = useId()
  const textareaId = id ?? generatedId
  const control = (
    <textarea
      ref={ref}
      id={textareaId}
      rows={rows}
      required={required}
      aria-invalid={error ? true : undefined}
      className={cn(CONTROL, 'resize-y py-2.5', className)}
      {...rest}
    />
  )
  if (!label) return control
  return (
    <Field label={label} htmlFor={textareaId} hint={hint} error={error} required={required}>
      {control}
    </Field>
  )
})

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: ReactNode
  error?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, id, required, children, ...rest },
  ref,
) {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const control = (
    <div className="relative flex items-center">
      <select
        ref={ref}
        id={selectId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'h-11 appearance-none pr-9', className)}
        {...rest}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 text-text-subtle">
        <Icon name="ChevronDown" size="md" />
      </span>
    </div>
  )
  if (!label) return control
  return (
    <Field label={label} htmlFor={selectId} hint={hint} error={error} required={required}>
      {control}
    </Field>
  )
})

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  id?: string
}

export function Switch({ checked, onChange, label, description, disabled, id }: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        id={switchId}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-45',
          checked ? 'bg-accent' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'inline-block h-4.5 w-4.5 rounded-full bg-white shadow-sm',
            'transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)]',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-[0.1875rem]',
          )}
        />
      </button>
      <div className="min-w-0">
        <label htmlFor={switchId} className="block cursor-pointer text-base font-medium text-text">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
      </div>
    </div>
  )
}
