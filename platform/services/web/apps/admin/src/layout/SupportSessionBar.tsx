import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminKeys, adminSessions, type SupportSession } from '@twentyfour/api'
import { Badge, Button, Icon, cn, formatCountdown, useTicker, useToast } from '@twentyfour/ui'
import { ReasonDialog, errorMessage } from '../common'

/**
 * The strip that appears while a support session is open.
 *
 * This is where the design this was built from drew a copy of the merchant's
 * dashboard inside the console: a sidebar, a takings figure, a list of open
 * tickets, all hand-written. That is a second implementation of a surface that
 * already exists and ships as its own application, and it would have started
 * drifting from the real one the day after it landed. Worse, the one thing a
 * specialist on a support call needs is to see exactly what the merchant is
 * looking at, and a lookalike is the one thing that cannot do that.
 *
 * So the console owns the session and hands off. It issues the token, shows
 * what the token may do and how long it has, and opens the merchant's own
 * dashboard. What the specialist sees there is the real screen, rendered from
 * the tenant's real entitlement record, because it is the real application.
 */
export function SupportSessionBar() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [asking, setAsking] = useState(false)

  const query = useQuery({ queryKey: adminKeys.sessions(), queryFn: adminSessions.list })
  const open = (query.data ?? []).find((entry) => entry.endedAt === null)

  // Once a second, and only while a token is alive. This is the one countdown
  // in the product that is worth watching tick: it is measured in minutes and
  // the specialist is deciding whether to finish or extend.
  const now = useTicker(open ? 1000 : null)

  const settle = (next: SupportSession) => {
    queryClient.setQueryData(adminKeys.sessions(), (rows: SupportSession[] | undefined) =>
      (rows ?? []).map((entry) => (entry.sessionId === next.sessionId ? next : entry)),
    )
  }
  const fail = (error: unknown) =>
    toast.show({ tone: 'danger', title: 'Nothing changed', description: errorMessage(error) })

  const elevate = useMutation({
    mutationFn: (reason: string) => adminSessions.elevate(open?.sessionId ?? '', reason),
    onSuccess: (next) => {
      settle(next)
      setAsking(false)
      toast.show({
        tone: 'warning',
        title: 'Write access granted',
        description: 'Your reason is on the audit record. The merchant is told too.',
      })
    },
    onError: fail,
  })

  const extend = useMutation({
    mutationFn: () => adminSessions.extend(open?.sessionId ?? ''),
    onSuccess: settle,
    onError: fail,
  })

  const revoke = useMutation({
    mutationFn: () => adminSessions.revoke(open?.sessionId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.sessions() })
      void queryClient.invalidateQueries({ queryKey: adminKeys.audit() })
      toast.show({ tone: 'success', title: 'Session closed', description: 'The token is revoked.' })
    },
    onError: fail,
  })

  if (!open) return null

  const remaining = new Date(open.expiresAt).getTime() - now
  const write = open.mode === 'write'
  const expiring = remaining < 120_000

  return (
    <>
      <div
        className={cn(
          'sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5 sm:px-6',
          write
            ? 'border-danger-border bg-danger-subtle text-danger-text'
            : 'border-warning-border bg-warning-subtle text-warning-text',
        )}
        role="status"
      >
        <span className="flex items-center gap-2">
          <Icon name={write ? 'ShieldAlert' : 'Eye'} size="md" className="shrink-0" />
          <span className="text-base font-semibold">
            {write ? 'Signed in as' : 'Watching'} {open.tenantName}
          </span>
        </span>

        <span className="text-sm">
          {write ? 'You can change things. Every change is attributed to you.' : 'Read only. The gateway refuses writes on this token.'}
        </span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Badge tone={expiring ? 'danger' : 'neutral'} className="tnum">
            {remaining <= 0 ? 'expired' : `${formatCountdown(remaining)} left`}
          </Badge>

          <Button
            size="sm"
            variant="outline"
            iconEnd="ArrowUpRight"
            onClick={() => window.open(open.handoffUrl, '_blank', 'noreferrer')}
          >
            Open their dashboard
          </Button>

          {!write && (
            <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
              Ask for write access
            </Button>
          )}

          <Button size="sm" variant="outline" loading={extend.isPending} onClick={() => extend.mutate()}>
            Ten more minutes
          </Button>

          <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
            End session
          </Button>
        </span>
      </div>

      <ReasonDialog
        open={asking}
        title="Write access"
        description={
          <>
            A new token is issued at the wider scope and the old one is retired, so the audit log
            carries both, each with its own reason. The merchant is notified.
          </>
        }
        confirmLabel="Elevate"
        destructive
        pending={elevate.isPending}
        onConfirm={(reason) => elevate.mutate(reason)}
        onClose={() => setAsking(false)}
      />
    </>
  )
}
