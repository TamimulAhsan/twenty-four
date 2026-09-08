import { Suspense, lazy, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { auth, HttpError } from '@twentyfour/api'
import { Button, Input } from '@twentyfour/ui'
import { AuthLayout } from './AuthLayout'
import { PasswordField } from './PasswordField'
import { returnTo } from './returnTo'

export function SignIn() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const login = useMutation({
    mutationFn: () => auth.login({ email, password }),
    onSuccess: (result) => {
      queryClient.invalidateQueries()
      // Where to go is the server's answer, not this form's guess. Auth reads
      // the address, finds which plane the account belongs to, and the gateway
      // returns a destination; one form therefore serves a merchant and a
      // specialist without knowing which it just signed in.
      //
      // ?return only applies to a merchant. It is a path this origin was
      // already on, interrupted by SessionGate, and returnTo refuses anything
      // that is not a same-origin path. A specialist's destination is an
      // absolute URL on another host, which is exactly what returnTo exists to
      // reject, so it is followed verbatim: it came from our own gateway rather
      // than from the address bar.
      window.location.assign(result.session ? returnTo(result.redirect) : result.redirect)
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    login.mutate()
  }

  const error = login.error instanceof HttpError ? login.error.message : undefined

  return (
    <AuthLayout>
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

        <PasswordField
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />

        <Button type="submit" size="lg" block loading={login.isPending}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-base text-text-muted">
        No account yet?{' '}
        <Link
          to="/signup"
          className="font-medium text-accent-text underline-offset-2 hover:underline"
        >
          Set one up
        </Link>
        . It takes about two minutes.
      </p>

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
    </AuthLayout>
  )
}

/** Development only, and lazily loaded so the fixtures never ship. */
const DemoAccounts = lazy(() => import('./DemoAccounts'))
