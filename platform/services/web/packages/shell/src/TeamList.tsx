import { useQuery } from '@tanstack/react-query'
import { queryKeys, staff, type StaffMember } from '@twentyfour/api'
import { roleDefinition, useSessionRole } from '@twentyfour/rbac'
import {
  Avatar, Badge, Button, Card, ErrorState, Icon, Skeleton, Table, TableScroll, Td, Th, Tr,
} from '@twentyfour/ui'

const STATUS: Record<StaffMember['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Not signed in yet', tone: 'warning' },
  deactivated: { label: 'No access', tone: 'neutral' },
}

/**
 * The team, inherited.
 *
 * The till and the calendar both need to know who is on shift, to put a name
 * against a sale or an appointment. Neither manages accounts: seats, roles and
 * invitations are one thing in one place, and that place is the dashboard.
 * Two screens that can both grant access is two screens that can disagree.
 */
export function TeamList({ purpose }: { purpose: string }) {
  const session = useSessionRole()
  const describeRole = (id: string) => roleDefinition(id, session.catalog)
  const list = useQuery({ queryKey: queryKeys.staff.list(), queryFn: staff.list })

  const ordered = [...(list.data ?? [])].sort((a, b) => {
    const rank = (member: StaffMember) => (member.status === 'active' ? 0 : 1)
    return rank(a) - rank(b) || describeRole(b.role).rank - describeRole(a.role).rank
  })

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-accent-border bg-accent-subtle">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <Icon name="Users" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
            <div>
              <p className="text-base font-medium text-text">
                Your team, as it is set up in the dashboard
              </p>
              <p className="mt-0.5 text-base text-text-muted">{purpose}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            iconEnd="ArrowUpRight"
            onClick={() => window.open('/staff', '_blank', 'noopener')}
          >
            Manage in dashboard
          </Button>
        </div>
      </Card>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Card padded={false}>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded={false}>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Access</Th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((member) => (
                  <Tr
                    key={member.id}
                    className={member.status === 'deactivated' ? 'opacity-60' : undefined}
                  >
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={member.name} colour={member.colour} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-text">{member.name}</span>
                            {member.isSelf && <Badge tone="neutral">You</Badge>}
                          </span>
                          <span className="block truncate text-sm text-text-subtle">
                            {member.email}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td className="text-text-muted">{describeRole(member.role).name}</Td>
                    <Td>
                      <Badge dot tone={STATUS[member.status].tone}>
                        {STATUS[member.status].label}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}
    </div>
  )
}
