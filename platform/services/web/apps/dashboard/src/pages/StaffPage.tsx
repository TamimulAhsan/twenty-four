import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys, staff, type StaffMember } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import {
  canInvite,
  seatsRemaining,
  seatsUsed,
  usePermission,
  type TeamMember,
} from '@twentyfour/rbac'
import { Badge, Button, Card, ErrorState, Icon, PageHeader, Skeleton, cn } from '@twentyfour/ui'
import { PeopleTab } from './staff/PeopleTab'
import { RolesTab } from './staff/RolesTab'
import { InviteDialog } from './staff/InviteDialog'

const asTeam = (members: readonly StaffMember[]): TeamMember[] =>
  members.map((member) => ({ id: member.id, role: member.role, status: member.status }))

export function StaffPage() {
  const { record } = useEntitlement()
  const mayManage = usePermission('staff.manage')
  const [tab, setTab] = useState<'people' | 'roles'>('people')
  const [inviting, setInviting] = useState(false)

  const list = useQuery({ queryKey: queryKeys.staff.list(), queryFn: staff.list })

  const team = asTeam(list.data ?? [])
  const limit = record.seats.limit
  // Both figures come from the same function, so they cannot disagree: a
  // deactivated account is in the list but does not hold a seat.
  const used = seatsUsed(team)
  const remaining = seatsRemaining(limit, team)
  const hasSeat = canInvite(limit, team)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team"
        description="Who can sign in, and exactly what each of them is allowed to do."
        actions={
          mayManage && (
            <Button iconStart="Plus" disabled={!hasSeat} onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          )
        }
      />

      <SeatQuota limit={limit} remaining={remaining} used={used} loading={list.isPending} />

      <div role="tablist" aria-label="Sections" className="flex gap-1 border-b border-border">
        {(['people', 'roles'] as const).map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'relative -mb-px h-10 px-3.5 text-base font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              tab === id
                ? 'text-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent'
                : 'text-text-muted hover:text-text',
            )}
          >
            {id === 'people' ? 'People' : 'Roles'}
          </button>
        ))}
      </div>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      ) : tab === 'people' ? (
        <PeopleTab members={list.data} onInvite={() => setInviting(true)} />
      ) : (
        <RolesTab members={list.data} />
      )}

      <InviteDialog open={inviting} onClose={() => setInviting(false)} members={list.data ?? []} />
    </div>
  )
}

/**
 * The seat quota.
 *
 * One seat is one person across both surfaces, so the number shown here is the
 * same number CRM Sync refuses a workspace member from. Saying so matters:
 * a merchant who thinks the CRM is separate will plan around a limit that does
 * not exist.
 */
function SeatQuota({
  limit,
  remaining,
  used,
  loading,
}: {
  limit: number | null
  remaining: number | null
  used: number
  loading: boolean
}) {
  const full = remaining === 0
  return (
    <Card className={cn(full && 'border-warning-border bg-warning-subtle')}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base font-medium text-text">
            {loading ? (
              <Skeleton className="h-5 w-40" />
            ) : limit === null ? (
              'Seats are negotiated on your plan'
            ) : (
              `${used} of ${limit} seats in use`
            )}
          </p>
          <p className="mt-0.5 text-sm text-text-muted">
            A seat is one person across the dashboard and the CRM, not one per system. An
            invitation holds a seat from the moment it is sent.
          </p>
        </div>

        {!loading && limit !== null && (
          <div className="flex items-center gap-3">
            {full ? (
              <Badge tone="warning" icon="TriangleAlert">
                All seats in use
              </Badge>
            ) : (
              <Badge tone="neutral">
                {remaining} {remaining === 1 ? 'seat' : 'seats'} left
              </Badge>
            )}
            {/* A bar as well as a figure: at a glance a merchant wants to know
                whether they are close, not to read a fraction. */}
            <div
              className="hidden h-2 w-32 overflow-hidden rounded-full bg-surface-sunken sm:block"
              role="img"
              aria-label={`${used} of ${limit} seats in use`}
            >
              <div
                className={cn('h-full rounded-full', full ? 'bg-warning' : 'bg-accent')}
                style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {full && (
        <p className="mt-3 flex items-start gap-2 text-sm text-text-muted">
          <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
          Deactivate someone who has left to free a seat, or change your plan from the subscription
          page.
        </p>
      )}
    </Card>
  )
}
