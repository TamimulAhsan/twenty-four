import { useQuery } from '@tanstack/react-query'
import { adminKeys, adminSessions, type SupportSession } from '@twentyfour/api'
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  cn,
  formatCountdown,
  useDateFormat,
  useTicker,
} from '@twentyfour/ui'
import { Preamble, Section, errorMessage } from '../common'

/**
 * Every time somebody has been inside a merchant's account.
 *
 * The console's whole claim about impersonation is that it is scoped,
 * time-boxed and recorded. This is the page where that claim is either true or
 * visibly not: an open session, what it may do, how long it has left, and a
 * complete history of the closed ones with the reason each was opened for.
 *
 * There is no long-lived superuser session anywhere in the product, which is
 * why the history has an end time on every row.
 */
export function SessionsPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: adminKeys.sessions(),
    queryFn: adminSessions.list,
  })

  const open = (data ?? []).filter((entry) => entry.endedAt === null)
  const closed = (data ?? []).filter((entry) => entry.endedAt !== null)

  if (isError) {
    return (
      <ErrorState
        title="Sessions did not load"
        description={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Impersonation"
        description="Scoped, time-boxed, fully recorded support access to a merchant's account."
      />

      <Preamble>
        A support token names one tenant and what it may do, starts read-only, and expires on a
        timer. Raising it to write needs a reason and issues a new token at the wider scope, so the
        audit log carries both. There is no session that outlives the specialist signing out.
      </Preamble>

      <Section title="Open now">
        {isPending ? (
          <Skeleton className="h-32" />
        ) : open.length === 0 ? (
          <EmptyState
            icon="ShieldCheck"
            title="Nobody is inside a merchant account"
            description="Start a session from a tenant's page. It will appear here and at the top of every screen."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {open.map((session) => (
              <OpenSession key={session.sessionId} session={session} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Closed" description="Everything that came before, with the reason it was opened.">
        {isPending ? (
          <Skeleton className="h-64" />
        ) : closed.length === 0 ? (
          <EmptyState
            icon="FileClock"
            title="No history yet"
            description="Closed sessions are kept as long as the audit log."
          />
        ) : (
          <Card padded={false}>
            <History rows={closed} />
          </Card>
        )}
      </Section>
    </div>
  )
}

function OpenSession({ session }: { session: SupportSession }) {
  const dates = useDateFormat()
  const now = useTicker(1000)
  const remaining = new Date(session.expiresAt).getTime() - now
  const write = session.mode === 'write'

  return (
    <Card className={cn(write ? 'border-danger-border' : 'border-warning-border')}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-md font-semibold text-text">{session.tenantName}</p>
            <Badge tone={write ? 'danger' : 'warning'}>
              {write ? 'Read and write' : 'Read only'}
            </Badge>
          </div>
          <p className="mt-1 text-base text-text-muted">{session.reason}</p>
          <p className="mt-1 text-sm text-text-subtle">
            {session.staffName} · opened {dates.dateTime(session.startedAt)}
          </p>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'tnum text-2xl font-semibold',
              remaining < 120_000 ? 'text-danger-text' : 'text-text',
            )}
          >
            {remaining <= 0 ? 'expired' : formatCountdown(remaining)}
          </p>
          <p className="text-sm text-text-subtle">until it expires</p>
        </div>
      </div>
      <p className="mt-4 border-t border-border pt-3 text-sm text-text-muted">
        Ending it, extending it and raising it to write are all on the strip at the top of every
        screen, so it is never more than one glance away.
      </p>
    </Card>
  )
}

function History({ rows }: { rows: readonly SupportSession[] }) {
  const dates = useDateFormat()
  return (
    <TableScroll>
      <Table>
        <thead>
          <tr>
            <Th>Opened</Th>
            <Th>Tenant</Th>
            <Th>Specialist</Th>
            <Th>Scope</Th>
            <Th numeric>Length</Th>
            <Th>Reason</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((session) => {
            const minutes = Math.max(
              1,
              Math.round(
                (new Date(session.endedAt ?? session.expiresAt).getTime() -
                  new Date(session.startedAt).getTime()) /
                  60_000,
              ),
            )
            return (
              <Tr key={session.sessionId}>
                <Td className="whitespace-nowrap text-text-muted">
                  {dates.dateTime(session.startedAt)}
                </Td>
                <Td>{session.tenantName}</Td>
                <Td className="text-text-muted">{session.staffName}</Td>
                <Td>
                  <Badge tone={session.mode === 'write' ? 'danger' : 'neutral'}>
                    {session.mode === 'write' ? 'Read and write' : 'Read only'}
                  </Badge>
                </Td>
                <Td numeric>{minutes} min</Td>
                <Td className="max-w-[22rem] text-text-muted">{session.reason}</Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
    </TableScroll>
  )
}
