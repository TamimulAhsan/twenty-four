import { useMutation } from '@tanstack/react-query'
import { auth } from '@twentyfour/api'
import { IconButton, useToast, type ButtonSize } from '@twentyfour/ui'

/**
 * Where the sign-in application lives.
 *
 * Same origin in production, which is what lets the cookie it issues be
 * present when the browser comes back. In development each application is its
 * own dev server on its own port, so the address cannot be a constant: it
 * comes from the build environment the same way the sibling applications do,
 * with the production path as the fallback.
 *
 * The trailing slash matters: without it nginx answers with a directory
 * redirect and the browser pays an extra round trip to learn what we knew.
 */
export const AUTH_PATH: string =
  typeof import.meta.env.VITE_AUTH_URL === 'string' && import.meta.env.VITE_AUTH_URL.length > 0
    ? import.meta.env.VITE_AUTH_URL
    : '/auth/'

/**
 * The sign-in URL, carrying where to come back to.
 *
 * The return is validated on arrival as well, because a URL is whatever the
 * person holding the address bar typed.
 */
export function signInUrl(returnTo: string): string {
  return `${AUTH_PATH}?return=${encodeURIComponent(returnTo)}`
}

/**
 * Signing out.
 *
 * The session is an httpOnly cookie on the parent domain, so the server ends
 * it and the browser is told to go somewhere else. There is nothing for
 * JavaScript to delete.
 *
 * It comes back to the application's own front door, never to the page it was
 * on. A till is a shared device bolted to a counter: whoever signs in next
 * should get the till, and should not be dropped into the last person's screen
 * to find out what they were looking at.
 *
 * A failed sign-out does not redirect. The cookie would still be valid, so the
 * gate would send the browser straight back and the whole thing would look
 * like a flicker rather than a refusal.
 */
export function useSignOut(): { signOut: () => void; pending: boolean } {
  const toast = useToast()

  const mutation = useMutation({
    mutationFn: auth.logout,
    onSuccess: () => {
      // The cache is deliberately left alone. Clearing it makes the session
      // gate refetch, find nothing, and fire its own redirect carrying the
      // page it was on, which races this one and wins about half the time.
      // The navigation takes the whole cache with it a moment later anyway.
      //
      // Replace, not assign: a signed-out page must not sit in history for the
      // back button to return to.
      window.location.replace(signInUrl(import.meta.env.BASE_URL))
    },
    onError: (error) => {
      toast.show({
        tone: 'danger',
        title: 'You are still signed in',
        description: error.message,
      })
    },
  })

  return { signOut: () => mutation.mutate(), pending: mutation.isPending }
}

/**
 * The icon-only control, for an application whose chrome is a single header
 * bar. The dashboard has room for a labelled row and renders its own.
 */
export function SignOutButton({ size = 'sm' }: { size?: ButtonSize }) {
  const { signOut, pending } = useSignOut()
  return (
    <IconButton
      icon="LogOut"
      label="Sign out"
      size={size}
      loading={pending}
      onClick={signOut}
    />
  )
}
