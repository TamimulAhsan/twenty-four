import { createContext, useContext, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminAuth,
  adminKeys,
  adminPlatform,
  type AdminEnvironment,
  type AdminSession,
} from '@twentyfour/api'
import { ConfirmDialog, ErrorState, FormatProvider, Spinner } from '@twentyfour/ui'
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

/**
 * Signing out of the console.
 *
 * Asks first, and the caller must render `confirmation` for the question to
 * appear. Same shape as the merchant plane's hook on purpose: two planes with
 * two different answers to "did you mean that" is how one of them ends up
 * without the question.
 *
 * The stake is higher here than on the merchant side. A specialist is often
 * partway through an impersonation session or a provisioning run, and this
 * plane can see every tenant, so the row that ends the session sits a
 * mis-click away from the navigation they use all day.
 */
export function useSignOut(): { signOut: () => void; pending: boolean; confirmation: ReactNode } {
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState(false)
  const mutation = useMutation({
    mutationFn: adminAuth.signOut,
    // Everything cached was read as this specialist. Clearing it is what keeps
    // the next person to sign in at this terminal from seeing the last one's
    // tenants for the frame before their own load.
    onSettled: () => queryClient.clear(),
  })

  const confirmation = (
    <ConfirmDialog
      open={asking}
      onCancel={() => setAsking(false)}
      onConfirm={() => mutation.mutate()}
      title="Sign out of the console?"
      description="Any support session you have open stays open until it expires or is revoked. Ending it is a separate act, on the tenant."
      confirmLabel="Sign out"
      confirmVariant="danger"
      confirmIcon="LogOut"
      pending={mutation.isPending}
    />
  )

  return { signOut: () => setAsking(true), pending: mutation.isPending, confirmation }
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
