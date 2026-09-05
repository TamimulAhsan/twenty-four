import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, staff, type StaffMember } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import {
  PERMISSIONS,
  roleDefinition,
  assignableRoles,
  checkDeactivate,
  checkRoleChange,
  grantedPermissions,
  useSessionRole,
  type RoleId,
  type TeamMember,
} from '@twentyfour/rbac'
import { Avatar, Badge, Button, Dialog, Field, Icon, Select, cn, useToast } from '@twentyfour/ui'

const asTeam = (members: readonly StaffMember[]): TeamMember[] =>
  members.map((member) => ({ id: member.id, role: member.role, status: member.status }))

export function MemberDialog({
  member,
  members,
  onClose,
}: {
  member: StaffMember | null
  members: readonly StaffMember[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const session = useSessionRole()
  const describeRole = (id: string) => roleDefinition(id, session.catalog)
  const { record } = useEntitlement()
  const [role, setRole] = useState<RoleId>('staff')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (member) {
      setRole(member.role)
      setConfirming(false)
    }
  }, [member])

  const team = asTeam(members)
  const actor: TeamMember = { id: session.userId, role: session.role, status: 'active' }
  const target: TeamMember | null = member
    ? { id: member.id, role: member.role, status: member.status }
    : null

  const roleCheck =
    target && role !== member?.role
      ? checkRoleChange({ actor, target, nextRole: role, members: team })
      : { allowed: true as const }
  const deactivation = target
    ? checkDeactivate({ actor, target, members: team })
    : { allowed: false as const, message: undefined }

  const save = useMutation({
    mutationFn: () => staff.update(member!.id, { role }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: `${updated.name} is now a ${describeRole(updated.role).name.toLowerCase()}`,
      })
      onClose()
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'That change was refused',
        description: error instanceof HttpError ? error.message : undefined,
      }),
  })

  const deactivate = useMutation({
    mutationFn: () => staff.update(member!.id, { status: 'deactivated' }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: `${updated.name} can no longer sign in`,
        description: 'Their seat is free, and their past orders stay attributed to them.',
      })
      onClose()
    },
  })

  const revoke = useMutation({
    mutationFn: () => staff.remove(member!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: 'Invitation withdrawn' })
      onClose()
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'That could not be withdrawn',
        description: error instanceof HttpError ? error.message : undefined,
      }),
  })

  const options = assignableRoles(session.role)
  const granted = grantedPermissions(role, record)
  const changed = member !== null && role !== member.role
  const pendingInvite = member?.status === 'invited'

  return (
    <Dialog
      open={member !== null}
      onClose={onClose}
      title={member?.name ?? ''}
      description={member?.email}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!changed || !roleCheck.allowed}
            onClick={() => save.mutate()}
          >
            Save role
          </Button>
        </>
      }
    >
      {member && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Avatar name={member.name} colour={member.colour} size="lg" />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5">
                <Badge tone="accent">{describeRole(member.role).name}</Badge>
                {member.isSelf && <Badge tone="neutral">You</Badge>}
                {pendingInvite && <Badge tone="warning">Invitation sent</Badge>}
              </p>
              <p className="mt-1 text-sm text-text-muted">{describeRole(member.role).description}</p>
            </div>
          </div>

          <Field
            label="Role"
            htmlFor="role"
            hint="Changing this changes what they can do the next time they load a screen."
            error={roleCheck.allowed ? undefined : roleCheck.message}
          >
            <Select
              id="role"
              value={role}
              onChange={(event) => setRole(event.target.value as RoleId)}
              disabled={options.length === 0 || member.isSelf}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {describeRole(option).name}
                </option>
              ))}
              {/* A role the actor cannot assign still has to appear, or the
                  selector silently shows the wrong current value. */}
              {!options.includes(member.role) && (
                <option value={member.role}>{describeRole(member.role).name}</option>
              )}
            </Select>
          </Field>

          <div>
            <p className="text-sm font-medium text-text">
              What a {describeRole(role).name.toLowerCase()} can do here
            </p>
            <p className="mt-0.5 text-sm text-text-muted">
              Filtered to your plan. {granted.length} of the permissions that exist for this
              business.
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {granted.map((id) => (
                <li key={id} className="flex items-start gap-2 text-sm">
                  <Icon
                    name={PERMISSIONS[id].sensitive ? 'ShieldCheck' : 'Check'}
                    size="sm"
                    className={cn(
                      'mt-0.5 shrink-0',
                      PERMISSIONS[id].sensitive ? 'text-warning-text' : 'text-success-text',
                    )}
                  />
                  <span className="text-text-muted">{PERMISSIONS[id].name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-border pt-4">
            {confirming ? (
              <div className="rounded-xl border border-danger-border bg-danger-subtle p-3.5">
                <p className="text-base font-medium text-text">
                  {pendingInvite ? 'Withdraw this invitation?' : `Remove ${member.name}’s access?`}
                </p>
                <p className="mt-1 text-base text-text-muted">
                  {pendingInvite
                    ? 'The link stops working and the seat is freed straight away.'
                    : 'They can no longer sign in anywhere, and the seat is freed. Their name stays on every order and document they were part of.'}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    Keep their access
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={deactivate.isPending || revoke.isPending}
                    onClick={() => (pendingInvite ? revoke.mutate() : deactivate.mutate())}
                  >
                    {pendingInvite ? 'Withdraw invitation' : 'Remove access'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-text">
                    {pendingInvite ? 'Withdraw invitation' : 'Remove access'}
                  </p>
                  <p className="mt-0.5 text-sm text-text-muted">
                    {deactivation.allowed
                      ? 'Frees their seat. Nothing they have already done is deleted.'
                      : deactivation.message}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!deactivation.allowed}
                  onClick={() => setConfirming(true)}
                >
                  {pendingInvite ? 'Withdraw' : 'Remove access'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}
