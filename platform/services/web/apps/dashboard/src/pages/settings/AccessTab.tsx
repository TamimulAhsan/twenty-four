import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys, support, type SupportAccessRequest } from '@twentyfour/api'
import { usePermission } from '@twentyfour/rbac'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Icon, Skeleton,
  Table, TableScroll, Td, Th, Tr, useDateFormat, useToast, type BadgeTone,
} from '@twentyfour/ui'

const STATE: Record<string, { label: string; tone: BadgeTone }> = {
  live: { label: 'Looking now', tone: 'warning' },
  stopped: { label: 'You stopped it', tone: 'neutral' },
  expired: { label: 'Ended', tone: 'neutral' },
}

/**
 * Who at TwentyFour has opened this account.
 *
 * Nothing brings a merchant here. A specialist starts a session without asking,
 * because support happens when somebody has rung up with a broken till and a
 * flow that waits for them to click a button in a dashboard they do not have
 * open is a flow that gets worked around.
 *
 * So this page is the other half of that bargain, and it is why the bargain is
 * defensible: the record is complete, it is the merchant's to read whenever
 * they think to look, and anything still running can be stopped from here.
 */
export function AccessTab() {
  const dates = useDateFormat()
  const client = useQueryClient()
  const toast = useToast()
  const mayStop = usePermission('settings.billing')

  const requests = useQuery({
    queryKey: queryKeys.support.requests(),
    queryFn: () => support.requests(),
  })

  const stop = useMutation({
    mutationFn: (id: string) => support.revoke(id),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: queryKeys.support.requests() })
      toast.show({
        tone: 'success',
        title: 'Access stopped',
        description:
          result.sessionsEnded > 0
            ? 'Anyone who was looking has been signed out of your account.'
            : 'Nothing was open at the time.',
      })
    },
    onError: () =>
      toast.show({ tone: 'danger', title: 'That could not be stopped. Try again.' }),
  })

  const list = requests.data ?? []
  const live = list.filter((entry) => entry.state === 'live')

  return (
    <div className="flex flex-col gap-5">
      {live.length > 0 && (
        <Card className="border-warning-border bg-warning-subtle">
          <div className="flex items-start gap-3">
            <Icon name="ShieldAlert" className="mt-0.5 shrink-0 text-warning" />
            <div className="flex-1">
              <p className="text-base font-medium text-text">
                {live.length === 1
                  ? 'Someone at TwentyFour has your account open'
                  : `${live.length} people at TwentyFour have your account open`}
              </p>
              <p className="mt-1 text-sm text-text-subtle">
                This happens when you have asked us for help. It ends by itself, and you can end
                it now.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="p-5">
          <CardHeader
            title="Who has opened your account"
            description="Every time somebody at TwentyFour has looked, why they said they needed to, and for how long."
          />
        </div>

        {requests.isLoading && <Skeleton className="m-5 h-32" />}
        {requests.isError && (
          <ErrorState
            title="This could not be read"
            description="Nothing has changed. Try again."
            className="m-5"
          />
        )}

        {requests.data && list.length === 0 && (
          <EmptyState
            icon="ShieldCheck"
            title="Nobody has opened your account"
            description="If you ask us for help, whoever looks will appear here with the reason they gave."
            className="m-5"
          />
        )}

        {list.length > 0 && (
          <TableScroll>
            <Table>
              <thead>
                <Tr>
                  <Th>Who</Th>
                  <Th>Why</Th>
                  <Th>What they can do</Th>
                  <Th>When</Th>
                  <Th />
                </Tr>
              </thead>
              <tbody>
                {list.map((entry) => (
                  <AccessRow
                    key={entry.id}
                    entry={entry}
                    when={dates.dateTime(entry.createdAt)}
                    mayStop={mayStop}
                    stopping={stop.isPending}
                    onStop={() => stop.mutate(entry.id)}
                  />
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>
    </div>
  )
}

function AccessRow({
  entry,
  when,
  mayStop,
  stopping,
  onStop,
}: {
  entry: SupportAccessRequest
  when: string
  mayStop: boolean
  stopping: boolean
  onStop: () => void
}) {
  const state = STATE[entry.state] ?? { label: entry.state, tone: 'neutral' as BadgeTone }
  return (
    <Tr>
      <Td className="font-medium text-text">{entry.specialist}</Td>
      <Td className="text-text-subtle">{entry.reason}</Td>
      <Td>
        {/* Read-only unless somebody asked otherwise, and the difference is
            worth spelling out rather than showing a scope key. */}
        <Badge tone={entry.scope === 'act_on_behalf' ? 'warning' : 'neutral'}>
          {entry.scope === 'act_on_behalf' ? 'Look and make changes' : 'Look only'}
        </Badge>
      </Td>
      <Td className="whitespace-nowrap text-text-subtle">
        {when}
        <span className="ml-2">
          <Badge tone={state.tone}>{state.label}</Badge>
        </span>
      </Td>
      <Td>
        {entry.state === 'live' && mayStop && (
          <Button size="sm" variant="outline" disabled={stopping} onClick={onStop}>
            Stop
          </Button>
        )}
      </Td>
    </Tr>
  )
}
