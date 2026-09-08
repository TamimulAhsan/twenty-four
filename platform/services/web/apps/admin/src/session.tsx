import { createContext, useContext, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminAuth,
  adminKeys,
  adminPlatform,
  type AdminEnvironment,
  type AdminSession,
} from '@twentyfour/api'
import { ErrorState, FormatProvider, Spinner } from '@twentyfour/ui'
import { signInUrl } from './signInUrl'

/**
 * The admin plane's own front door.
 *
 * Not SessionGate: that one belongs to the merchant applications and knows
 * about their cookie and their gateway. This console holds a different cookie,
 * on a different host, verified against a different plane, and the two must
 * never share a code path that could confuse them.
 *
 * What it does share is the form. There is exactly one sign-in in the product
 * and it lives on the merchant origin, because that is where everybody arrives
 * and because a second form would be a second place for the password rules to
 * drift. A specialist who is not signed in is sent there; Auth reads their
 * address, finds a staff account, and sends them back here holding a one-time
 * code.
 *
 * Arriving signed out is the ordinary first load rather than an error, which is
 * why the session call answers null instead of 401.
 */
interface ConsoleValue {
  readonly session: AdminSession
  readonly environment: AdminEnvironment
}

const ConsoleContext = createContext<ConsoleValue | null>(null)

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext)
  if (!value) throw new Error('useConsole must be used inside an AdminGate')
  return value
}

export function useAdminSession(): AdminSession {
  return useConsole().session
}

export function useEnvironment(): AdminEnvironment {
  return useConsole().environment
}

export function useSignOut() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: adminAuth.signOut,
    // Everything cached was read as this specialist. Clearing it is what keeps
    // the next person to sign in at this terminal from seeing the last one's
    // tenants for the frame before their own load.
    onSettled: () => queryClient.clear(),
  })
  return { signOut: () => mutation.mutate(), pending: mutation.isPending }
}

export function AdminGate({ children }: { children: ReactNode }) {
  const session = useQuery({ queryKey: adminKeys.session(), queryFn: adminAuth.session })
  // Fetched alongside, not after: the console cannot render an amount or a
  // timestamp before it knows which market's locale it is in.
  const environment = useQuery({
    queryKey: adminKeys.environment(),
    queryFn: adminPlatform.environment,
  })

  if (session.isPending || environment.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <Spinner label="Loading the console" />
      </div>
    )
  }

  if (session.isError || environment.isError) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg p-6">
        <ErrorState
          title="The console could not reach its gateway"
          description="Nothing has changed. This is usually the allowlist or the VPN."
          onRetry={() => {
            void session.refetch()
            void environment.refetch()
          }}
        />
      </div>
    )
  }

  if (!environment.data) return null

  if (!session.data) {
    // Replaced rather than pushed: a back button that returns to a console
    // nobody is signed in to would bounce straight out again.
    window.location.replace(signInUrl())
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <Spinner label="Taking you to sign in" />
      </div>
    )
  }

  return (
    <ConsoleContext.Provider value={{ session: session.data, environment: environment.data }}>
      {/* The market's own locale and currency, read from the deployment. Not
          the browser's, and not a country check: one market per deployment
          means this is a value, the same as the release number. */}
      <FormatProvider
        locale={environment.data.locale}
        currency={environment.data.currency}
        timezone={environment.data.timezone}
      >
        {children}
      </FormatProvider>
    </ConsoleContext.Provider>
  )
}
