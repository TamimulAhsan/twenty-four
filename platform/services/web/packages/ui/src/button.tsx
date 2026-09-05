import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icon'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

/**
 * Every interactive surface in the product goes through here.
 *
 * Height is the floor a finger needs. sm is 36px and is only for controls that
 * sit inside a row a pointer uses; anything a merchant taps on a tablet uses md
 * or lg, which clear 44px.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 gap-1.5 px-3 text-sm rounded-md',
  md: 'h-11 gap-2 px-4 text-base rounded-lg',
  lg: 'h-12 gap-2 px-5 text-md rounded-lg',
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active shadow-[0_1px_2px_rgb(11_11_12/0.16)]',
  secondary:
    'bg-surface-inverse text-text-inverse hover:opacity-90 active:opacity-80',
  // border-strong, not border: an outline is the only thing separating this
  // control from its background, so it has to clear 3:1 on its own.
  outline:
    'border border-border-strong bg-surface text-text hover:bg-surface-hover active:bg-surface-active',
  ghost: 'text-text-muted hover:bg-surface-hover hover:text-text active:bg-surface-active',
  danger: 'bg-danger text-white hover:bg-danger-hover active:brightness-95',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Disables and shows a spinner. A submit that gives no feedback gets
   *  pressed twice, and the second press is a second order. */
  loading?: boolean
  iconStart?: IconName
  iconEnd?: IconName
  block?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    iconStart,
    iconEnd,
    block = false,
    className,
    disabled,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-[background-color,color,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
        // Feedback within a frame of the press, and no layout bounds move.
        'active:scale-[0.985]',
        'disabled:pointer-events-none disabled:opacity-45',
        SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="LoaderCircle" size={size === 'sm' ? 'sm' : 'md'} className="animate-spin" />
      ) : (
        iconStart && <Icon name={iconStart} size={size === 'sm' ? 'sm' : 'md'} />
      )}
      {children}
      {iconEnd && !loading && <Icon name={iconEnd} size={size === 'sm' ? 'sm' : 'md'} />}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'iconStart' | 'iconEnd'> {
  icon: IconName
  /** Required. An icon-only control is unreadable to a screen reader without
   *  it, and unguessable to anyone else after a week away. */
  label: string
}

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 w-9 rounded-md',
  md: 'h-11 w-11 rounded-lg',
  lg: 'h-12 w-12 rounded-lg',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', loading, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        'transition-[background-color,color,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
        'active:scale-[0.94] disabled:pointer-events-none disabled:opacity-45',
        ICON_SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={loading ? 'LoaderCircle' : icon} size={size === 'sm' ? 'md' : 'lg'} className={loading ? 'animate-spin' : undefined} />
    </button>
  )
})
