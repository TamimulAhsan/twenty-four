import { Suspense, lazy, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { auth, HttpError } from '@twentyfour/api'
import { Button, Field, Icon, Input, ThemeToggle, cn } from '@twentyfour/ui'
import { Wordmark } from '@twentyfour/runtime'

export function SignIn() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const login = useMutation({
    mutationFn: () => auth.login({ email, password }),
    onSuccess: () => {
      queryClient.invalidateQueries()
      // Full navigation rather than a router push: the destination is a
      // different application on the same origin, served by its own pod.
      window.location.assign(returnTo())
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    login.mutate()
  }

  const error = login.error instanceof HttpError ? login.error.message : undefined

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,42rem)]">
      {/* Deliberately one look in both themes: this is a brand canvas, not a
          surface, and a panel that flips to white in dark mode reads as a
          rendering fault rather than a choice. Painted explicitly, so it never
          borrows a colour from the theme.

          The panel is decorative and the form is the point, so on a phone it
          is dropped entirely rather than stacked above the fields. */}
      <aside className="relative hidden overflow-hidden bg-neutral-950 p-12 lg:flex lg:flex-col">
        <Wordmark tone="light" />
        <div className="mt-auto max-w-md">
          <p className="text-3xl font-semibold leading-[1.15] tracking-[-0.03em] text-white">
            Website, bookings, till and payments. One system, live in a day.
          </p>
          <p className="mt-4 text-md text-neutral-400">
            Configured for your trade by a specialist, not assembled by you.
          </p>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent/25 blur-3xl"
        />
      </aside>

      <main className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between lg:hidden">
            <Wordmark />
            <ThemeToggle />
          </div>

          <h1 className="text-2xl font-semibold tracking-[-0.03em] text-text">Sign in</h1>
          <p className="mt-1.5 text-base text-text-muted">
            Use the email your specialist set up for you.
          </p>

          <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate>
            <Input
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              iconStart="User"
              error={error}
            />

            <Field label="Password" htmlFor="password" required>
              <div className="relative flex items-center">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className={cn(
                    'h-11 w-full rounded-lg border border-border-strong bg-surface pl-3 pr-12',
                    'text-md sm:text-base text-text placeholder:text-text-subtle',
                    'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/18',
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className={cn(
                    'absolute right-0 grid h-11 w-11 place-items-center rounded-lg',
                    'text-text-subtle transition-colors hover:text-text',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                  )}
                >
                  <Icon name={showPassword ? 'EyeOff' : 'Eye'} size="md" />
                </button>
              </div>
            </Field>

            <Button type="submit" size="lg" block loading={login.isPending}>
              Sign in
            </Button>
          </form>

          {import.meta.env.DEV && (
            <Suspense fallback={null}>
              <DemoAccounts
                onPick={(pickedEmail) => {
                  setEmail(pickedEmail)
                  setPassword('demo')
                }}
              />
            </Suspense>
          )}
        </div>
      </main>
    </div>
  )
}

/** Development only, and lazily loaded so the fixtures never ship. */
const DemoAccounts = lazy(() => import('./DemoAccounts'))

/**
 * Where to send someone after they sign in.
 *
 * SessionGate puts the path it interrupted in ?return. Only same-origin
 * absolute paths are honoured: accepting anything else would turn sign-in into
 * an open redirect, which is a phishing tool with our domain on it.
 */
function returnTo(): string {
  const raw = new URLSearchParams(window.location.search).get('return')
  if (!raw) return '/'
  // Must be a path on this origin. Reject scheme-relative "//evil.com" and any
  // absolute URL, however it is spelled.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}
