import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, staff, type StaffMember } from '@twentyfour/api'
import {
  roleDefinition,
  checkDeactivate,
  checkRoleChange,
  useSessionRole,
  type RoleId,
  type TeamMember,
} from '@twentyfour/rbac'
import {
  Avatar, Badge, Button, Card, EmptyState, Icon, Table, TableScroll, Td, Th, Tr,
  cn, useDateFormat, useToast,
} from '@twentyfour/ui'
import { MemberDialog } from './MemberDialog'

const STATUS: Record<StaffMember['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invitation sent', tone: 'warning' },
  deactivated: { label: 'No access', tone: 'neutral' },
}

const ROLE_TONE: Record<RoleId, 'accent' | 'neutral'> = {
  owner: 'accent',
  manager: 'accent',
  bookkeeper: 'neutral',
  staff: 'neutral',
}

const asTeam = (members: readonly StaffMember[]): TeamMember[] =>
  members.map((member) => ({ id: member.id, role: member.role, status: member.status }))

export function PeopleTab({
  members,
  onInvite,
}: {
  members: readonly StaffMember[]
  onInvite: () => void
}) {
  const toast = useToast()
  const dates = useDateFormat()
  const queryClient = useQueryClient()
  const session = useSessionRole()
  const describeRole = (id: string) => roleDefinition(id, session.catalog)
  const [editing, setEditing] = useState<StaffMember | null>(null)

  const team = asTeam(members)
  const actor: TeamMember = {
    id: session.userId,
    role: session.role,
    status: 'active',
  }

  const resend = useMutation({
    mutationFn: (id: string) => staff.resendInvitation(id),
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] })
      toast.show({ tone: 'success', title: `Invitation resent to ${member.name}` })
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'That did not send', description: error.message }),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'deactivated' }) =>
      staff.update(id, { status }),
    onSuccess: (member) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: member.status === 'active' ? `${member.name} has access again` : `${member.name} can no longer sign in`,
        description:
          member.status === 'deactivated'
            ? 'Their seat is free, and their past orders stay attributed to them.'
            : undefined,
      })
    },
    onError: (error) => {
      const message = error instanceof HttpError ? error.message : 'Something went wrong.'
      toast.show({ tone: 'danger', title: 'That change was refused', description: message })
    },
  })

  if (members.length === 0) {
    return (
      <EmptyState
        icon="Users"
        title="Nobody else has an account yet"
        description="Invite the people who work with you so they sign in as themselves rather than sharing a login."
        action={<Button onClick={onInvite}>Invite someone</Button>}
      />
    )
  }

  const ordered = [...members].sort((a, b) => {
    const rank = (member: StaffMember) =>
      member.status === 'deactivated' ? 2 : member.status === 'invited' ? 1 : 0
    return rank(a) - rank(b) || describeRole(b.role).rank - describeRole(a.role).rank
  })

  return (
    <>
      <Card padded={false}>
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden md:table-cell">Email</Th>
                <Th>Role</Th>
                <Th>Access</Th>
                <Th className="hidden lg:table-cell">Last active</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {ordered.map((member) => {
                const asMember: TeamMember = {
                  id: member.id,
                  role: member.role,
                  status: member.status,
                }
                const mayEdit = checkRoleChange({
                  actor,
                  target: asMember,
                  nextRole: member.role === 'owner' ? 'manager' : 'owner',
                  members: team,
                }).allowed
                const deactivation = checkDeactivate({ actor, target: asMember, members: team })

                return (
                  <Tr key={member.id} className={member.status === 'deactivated' ? 'opacity-60' : undefined}>
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={member.name} colour={member.colour} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-text">{member.name}</span>
                            {member.isSelf && <Badge tone="neutral">You</Badge>}
                          </span>
                          <span className="block truncate text-sm text-text-subtle md:hidden">
                            {member.email}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td className="hidden text-text-muted md:table-cell">{member.email}</Td>
                    <Td>
                      <Badge tone={ROLE_TONE[member.role]}>{describeRole(member.role).name}</Badge>
                    </Td>
                    <Td>
                      <Badge dot tone={STATUS[member.status].tone}>
                        {STATUS[member.status].label}
                      </Badge>
                    </Td>
                    <Td className="hidden whitespace-nowrap text-text-muted lg:table-cell">
                      {member.lastActiveAt ? dates.date(member.lastActiveAt) : '—'}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {member.status === 'invited' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconStart="RefreshCw"
                            loading={resend.isPending && resend.variables === member.id}
                            onClick={() => resend.mutate(member.id)}
                          >
                            <span className="hidden sm:inline">Resend</span>
                          </Button>
                        )}
                        {member.status === 'deactivated' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setStatus.mutate({ id: member.id, status: 'active' })}
                          >
                            Restore
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!mayEdit && !deactivation.allowed}
                            title={
                              !mayEdit && !deactivation.allowed ? deactivation.message : undefined
                            }
                            onClick={() => setEditing(member)}
                          >
                            Manage
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      {/* The rules that stop a team locking itself out are worth stating once
          on the page, rather than only appearing as a refusal after someone
          has tried. */}
      <Card className="mt-4 border-accent-border bg-accent-subtle">
        <div className="flex gap-3">
          <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
          <div className={cn('text-base text-text-muted')}>
            <p className="font-medium text-text">Two rules you cannot switch off</p>
            <p className="mt-1">
              There is always at least one owner, so the last one cannot be demoted or removed. And
              nobody can change their own role, which is what stops an account quietly promoting
              itself.
            </p>
          </div>
        </div>
      </Card>

      <MemberDialog member={editing} members={members} onClose={() => setEditing(null)} />
    </>
  )
}
