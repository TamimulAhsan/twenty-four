import { useState } from 'react'
import { Field, Icon, cn } from '@twentyfour/ui'

/**
 * A password input with a reveal control.
 *
 * Both screens need one and they must behave identically: a reveal that works
 * on sign-in and not on sign-up is how somebody sets a password they cannot
 * then type. Shown as text rather than dots on request, because the alternative
 * is a merchant on a phone keyboard guessing at their own typing.
 */
export function PasswordField({
  id = 'password',
  label = 'Password',
  autoComplete,
  value,
  onChange,
  hint,
  error,
}: {
  id?: string
  label?: string
  autoComplete: 'current-password' | 'new-password'
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
}) {
  const [shown, setShown] = useState(false)

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required>
      <div className="relative flex items-center">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          name={id}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          className={cn(
            'h-11 w-full rounded-lg border bg-surface pl-3 pr-12',
            'text-md sm:text-base text-text placeholder:text-text-subtle',
            'focus:outline-none focus:ring-[3px]',
            error
              ? 'border-danger-border focus:border-danger-border focus:ring-danger/18'
              : 'border-border-strong focus:border-accent focus:ring-accent/18',
          )}
        />
        <button
          type="button"
          onClick={() => setShown((current) => !current)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className={cn(
            'absolute right-0 grid h-11 w-11 place-items-center rounded-lg',
            'text-text-subtle transition-colors hover:text-text',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
          )}
        >
          <Icon name={shown ? 'EyeOff' : 'Eye'} size="md" />
        </button>
      </div>
    </Field>
  )
}
