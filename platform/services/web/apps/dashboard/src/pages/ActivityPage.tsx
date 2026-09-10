import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { audit, queryKeys, type AuditActor, type AuditEntry } from '@twentyfour/api'
import {
  Badge, Button, Card, EmptyState, ErrorState, Icon, PageHeader, Select,
  Skeleton, Table, TableScroll, Td, Th, Tr, useDateFormat, type BadgeTone,
} from '@twentyfour/ui'

/**
 * Who acted, and it is not a free string.
 *
 * "The system" and a person's name being the same kind of value is how an
 * automated decision ends up attributed to whoever happened to be signed in,
 * and how a specialist reading your books reads as one of your own staff.
 */
const ACTOR: Record<AuditActor, { label: string; tone: BadgeTone; icon: 'User' | 'ShieldAlert' | 'Settings' | 'Globe' }> = {
  user: { label: 'Someone here', tone: 'neutral', icon: 'User' },
  // Called out rather than blended in. Somebody at TwentyFour is not one of
  // your team, and this is the row a merchant scans this page looking for.
  staff: { label: 'TwentyFour', tone: 'warning', icon: 'ShieldAlert' },
  system: { label: 'Automatic', tone: 'neutral', icon: 'Settings' },
  anonymous: { label: 'Not signed in', tone: 'neutral', icon: 'Globe' },
}

/**
 * Everything that happened, in plain language.
 *
 * The sentences come from the service rather than being assembled here, which
 * matters more than it looks: a screen that formatted its own would be a second
 * opinion about what an event meant, and the trail would then say two different
 * things depending on where it was read.
 */
export function ActivityPage() {
  const dates = useDateFormat()
  const [actor, setActor] = useState('')
  const [pages, setPages] = useState<string[]>([''])

  const token = pages[pages.length - 1] ?? ''
  const list = useQuery({
    queryKey: queryKeys.audit.list({ actor, token }),
    queryFn: () => audit.list({ pageToken: token || undefined }),
  })

  const entries = (list.data?.entries ?? []).filter(
    (entry) => !actor || entry.actorKind === actor,
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity"
        description="Every decision this platform made on your behalf, and everyone who acted."
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <Select
            label="Who"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="w-56"
          >
            <option value="">Everyone</option>
            <option value="user">Someone here</option>
            <option value="staff">TwentyFour</option>
            <option value="system">Automatic</option>
          </Select>
        </div>

        {list.isLoading && <Skeleton className="m-4 h-48" />}
        {list.isError && (
          <ErrorState
            title="The trail could not be read"
            description="This is a record rather than a live figure, so nothing has been lost. Try again."
            className="m-4"
          />
        )}

        {list.data && entries.length === 0 && (
          <EmptyState
            icon="FileClock"
            title="Nothing here yet"
            description="This fills as the platform does things: sales, stock movements, messages and anyone who looks at your account."
            className="m-4"
          />
        )}

        {entries.length > 0 && (
          <TableScroll>
            <Table>
              <thead>
                <Tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What happened</Th>
                  <Th>About</Th>
                </Tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} when={dates.dateTime(entry.occurredAt)} />
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}

        {list.data?.nextPageToken && (
          <div className="flex justify-center border-t border-border px-4 py-3">
            <Button
              variant="secondary"
              onClick={() => setPages((p) => [...p, list.data.nextPageToken])}
            >
              Show older
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

function ActivityRow({ entry, when }: { entry: AuditEntry; when: string }) {
  const actor = ACTOR[entry.actorKind] ?? ACTOR.system
  return (
    <Tr>
      <Td className="whitespace-nowrap text-text-subtle">{when}</Td>
      <Td>
        <span className="inline-flex items-center gap-2">
          <Icon name={actor.icon} size="sm" className="text-text-subtle" />
          <Badge tone={actor.tone}>{actor.label}</Badge>
          {/* The name whoever acted had at the time, not the one they have now:
              a person who has since left still did the thing. */}
          {entry.actor && entry.actorKind !== 'system' && (
            <span className="text-sm text-text-subtle">{entry.actor}</span>
          )}
        </span>
      </Td>
      <Td>{entry.summary}</Td>
      <Td className="text-text-subtle">
        {entry.subjectType ? entry.subjectType.replace(/_/g, ' ') : ''}
      </Td>
    </Tr>
  )
}
