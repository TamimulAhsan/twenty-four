import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { auth } from '@twentyfour/api'
import { BootstrapProvider, launchTargets } from '@twentyfour/runtime'
import { Spinner } from '@twentyfour/ui'
import { signInUrl } from './session'

/**
 * Nothing renders until the server says who is signed in.
 *
 * The session is an httpOnly cookie on the parent domain, so this asks rather
 * than reads. Every application shares that cookie, which is why a merchant who
 * launches the till from the dashboard is already signed in.
 *
 * When there is no session the browser goes to the auth application, carrying
 * where it came from so sign-in returns it. There is one sign-in form in the
 * product and it lives in one deployment: no application carries a second copy,
 * and none of them can drift from it.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useQuery({ queryKey: ['session'], queryFn: auth.session, retry: false })

  if (session.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Checking your session" />
      </div>
    )
  }

  if (!session.data) {
    // Replace rather than assign: a signed-out page should not sit in history
    // for the back button to return to after signing in.
    const here = window.location.pathname + window.location.search
    window.location.replace(signInUrl(here))
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Taking you to sign in" />
      </div>
    )
  }

  return (
    <BootstrapProvider launchTargets={launchTargets(import.meta.env)}>{children}</BootstrapProvider>
  )
}
