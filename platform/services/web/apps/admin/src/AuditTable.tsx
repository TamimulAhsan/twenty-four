import type { AuditEvent } from '@twentyfour/api'
import {
  Badge,
  EmptyState,
  Table,
  TableScroll,
  Td,
  Th,
  Tr,
  useDateFormat,
} from '@twentyfour/ui'
import { useDrawer } from './Drawer'

/**
 * The audit log, as a table.
 *
 * Written once and used by both the global log and a tenant's own tab, because
 * they are the same rows filtered differently. Two tables would eventually
 * disagree about what a denied event looks like, and the whole value of this
 * record is that it reads the same everywhere.
 *
 * A denied result is not a failure to hide: it is somebody's permissions
 * working, and it is the most interesting line on the page.
 */
export function AuditTable({
  rows,
  showTenant = true,
}: {
  rows: readonly AuditEvent[]
  showTenant?: boolean
}) {
  const dates = useDateFormat()
  const drawer = useDrawer()

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="FileClock"
        title="Nothing recorded"
        description="No event matches. The log itself is append-only and never empty by deletion."
      />
    )
  }

  return (
    <TableScroll>
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>What</Th>
            {showTenant && <Th>Tenant</Th>}
            <Th>Detail</Th>
            <Th>From</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map((event) => (
            <Tr
              key={event.eventId}
              interactive
              onClick={() =>
                drawer.open({
                  title: event.event,
                  subtitle: `${dates.dateTime(event.at)} · ${event.eventId}`,
                  rows: [
                    { key: 'Who', value: event.actor },
                    { key: 'Tenant', value: event.tenantName ?? 'none' },
                    { key: 'Detail', value: event.detail },
                    { key: 'From', value: <span className="font-mono text-sm">{event.sourceIp}</span> },
                    {
                      key: 'Result',
                      value: (
                        <Badge tone={event.result === 'denied' ? 'danger' : 'success'}>
                          {event.result === 'denied' ? 'Denied' : 'Allowed'}
                        </Badge>
                      ),
                    },
                    { key: 'Scope', value: event.scope ?? 'not a scoped event' },
                  ],
                  // The record as it is stored, not as it is narrated. Somebody
                  // reading an audit log needs to be able to quote it.
                  payload: JSON.stringify(event, null, 2),
                })
              }
            >
              <Td className="whitespace-nowrap text-text-muted">{dates.dateTime(event.at)}</Td>
              <Td className="whitespace-nowrap">{event.actor}</Td>
              <Td>
                <span className="font-mono text-xs text-text">{event.event}</span>
              </Td>
              {showTenant && (
                <Td className="whitespace-nowrap text-text-muted">{event.tenantName ?? '—'}</Td>
              )}
              <Td className="max-w-[24rem] text-text-muted">{event.detail}</Td>
              <Td>
                <span className="font-mono text-xs text-text-subtle">{event.sourceIp}</span>
              </Td>
              <Td>
                {event.result === 'denied' ? (
                  <Badge tone="danger">Denied</Badge>
                ) : (
                  <span className="text-sm text-text-subtle">ok</span>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {rows.length > 80 && (
        <p className="border-t border-border px-4 py-2.5 text-sm text-text-subtle">
          Showing the 80 most recent of {rows.length}.
        </p>
      )}
    </TableScroll>
  )
}
