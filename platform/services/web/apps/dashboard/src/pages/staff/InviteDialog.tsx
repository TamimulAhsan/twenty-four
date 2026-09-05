import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, staff, type StaffMember } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import {
  PERMISSIONS,
  roleDefinition,
  assignableRoles,
  grantedPermissions,
  useSessionRole,
  type RoleId,
} from '@twentyfour/rbac'
import { Button, Dialog, Field, Icon, Input, Select, cn, useToast } from '@twentyfour/ui'

export function InviteDialog({
  open,
  onClose,
  members,
}: {
  open: boolean
  onClose: () => void
  members: readonly StaffMember[]
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const session = useSessionRole()
  const describeRole = (id: string) => roleDefinition(id, session.catalog)
  const { record } = useEntitlement()

  const options = assignableRoles(session.role)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<RoleId>('staff')

  useEffect(() => {
    if (open) {
      setName('')
      setEmail('')
      setRole(options.includes('staff') ? 'staff' : (options[options.length - 1] ?? 'staff'))
    }
    // options is derived from a stable role, so it does not need to be a dep.
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const invite = useMutation({
    mutationFn: () => staff.invite({ name, email, role }),
    onSuccess: (member) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: `${member.name} has been invited`,
        description: 'They will get an email with a link to set their own password.',
      })
      onClose()
    },
  })

  const error = invite.error instanceof HttpError ? invite.error : undefined
  const duplicate = members.some(
    (member) => member.email.toLowerCase() === email.trim().toLowerCase(),
  )
  const granted = grantedPermissions(role, record)
  const sensitive = granted.filter((id) => PERMISSIONS[id].sensitive)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite someone"
      description="They get a login of their own. Nobody shares an account."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={invite.isPending}
            disabled={!name.trim() || !email.trim() || duplicate}
            onClick={() => invite.mutate()}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error?.code === 'seat_limit_reached' && (
          <div
            role="alert"
            className="rounded-lg border border-warning-border bg-warning-subtle p-3 text-base text-text-muted"
          >
            {error.message} Deactivate someone who has left, or change your plan from the
            subscription page.
          </div>
        )}

        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />

        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          hint="The invitation goes here, and this becomes their sign-in."
          error={
            duplicate
              ? 'Someone on your team already uses that email.'
              : error && error.code !== 'seat_limit_reached'
                ? error.message
                : undefined
          }
        />

        <Field
          label="Role"
          htmlFor="invite-role"
          hint="You can change this at any time. Start with the least they need."
        >
          <Select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as RoleId)}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {describeRole(option).name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="rounded-lg bg-surface-sunken p-3.5">
          <p className="text-sm text-text-muted">{describeRole(role).description}</p>
          {/* The permissions worth pausing over are shown before the invitation
              is sent, not discovered afterwards. */}
          {sensitive.length > 0 && (
            <>
              <p className="mt-3 text-sm font-medium text-text">This role can also</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {sensitive.map((id) => (
                  <li key={id} className="flex items-start gap-2 text-sm text-text-muted">
                    <Icon
                      name="ShieldCheck"
                      size="sm"
                      className={cn('mt-0.5 shrink-0 text-warning-text')}
                    />
                    {PERMISSIONS[id].name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
