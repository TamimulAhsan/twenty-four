import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminKeys, adminSession } from '@twentyfour/api'
import { BrandMark } from '@twentyfour/runtime'
import { Button, Card, Icon, Spinner } from '@twentyfour/ui'
import { errorMessage } from './common'
import { signInUrl } from './signInUrl'

/**
 * Where a specialist lands after signing in.
 *
 * There is one sign-in form and it is on the merchant origin, because that is
 * where everybody arrives and because two forms would be two places for the
 * password rules to drift. Auth reads the address, finds a staff account, and
 * sends the browser here holding a one-time code.
 *
 * This page swaps that code for a session on this host. It is the only place an
 * admin cookie is ever set, and the code is single use and lives thirty
 * seconds, because it travelled in a URL and a URL is in history, in Referer
 * and in the log of every proxy on the path.
 */
export function HandoffPage() {
  const queryClient = useQueryClient()
  const started = useRef(false)

  const exchange = useMutation({
    mutationFn: (code: string) => adminSession.exchange(code),
    onSuccess: () => {
      // Refetched rather than written from the response: the gateway decides
      // what a session looks like, and this page should not be a second place
      // that also has an opinion.
      void queryClient.invalidateQueries({ queryKey: adminKeys.session() })
      window.location.replace('/')
    },
  })

  useEffect(() => {
    // Once. StrictMode mounts effects twice in development, and the code is
    // single use, so the second attempt would fail against a code the first
    // one had already spent.
    if (started.current) return
    started.current = true

    const code = new URLSearchParams(window.location.search).get('code')

    // Out of the address bar before anything else happens. It is spent either
    // way, but a spent code in somebody's history is still a spent code in
    // somebody's history.
    window.history.replaceState(null, '', '/session')

    if (!code) {
      exchange.reset()
      return
    }
    exchange.mutate(code)
  }, [exchange])

  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <p className="text-md font-semibold tracking-[-0.01em] text-text">
            TwentyFour admin console
          </p>
        </div>

        <Card className="mt-5" raised>
          {exchange.isPending ? (
            <div className="flex items-center gap-3">
              <Spinner />
              <p className="text-base text-text-muted">Opening your session</p>
            </div>
          ) : (
            <>
              <p className="flex items-start gap-2.5 text-base text-danger-text">
                <Icon name="AlertCircle" size="md" className="mt-0.5 shrink-0" />
                <span>
                  {exchange.isError
                    ? errorMessage(exchange.error)
                    : 'This link carried no sign-in code.'}
                </span>
              </p>
              <p className="mt-3 text-base text-text-muted">
                Sign-in links are single use and expire after half a minute. Signing in again
                takes a few seconds.
              </p>
              <Button
                className="mt-5 w-full"
                size="lg"
                iconEnd="ArrowUpRight"
                onClick={() => window.location.assign(signInUrl())}
              >
                Sign in again
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
