import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, roles as rolesApi, type StaffMember } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import {
  GROUP_LABELS, GROUP_ORDER, PERMISSIONS, grantablePermissions, useSessionRole,
  type PermissionId, type RoleDefinition,
} from '@twentyfour/rbac'
import {
  Button, Card, Dialog, Icon, Input, Textarea, cn, useToast,
} from '@twentyfour/ui'

/**
 * Defining a role of your own.
 *
 * The list of permissions offered is the author's own, and nothing beyond it.
 * Without that, anyone who can define a role can define one that grants
 * everything and have it assigned to themselves, which would make every other
 * check on this page decorative.
 */
export function RoleFormDialog({
  role,
  open,
  onClose,
}: {
  /** null creates a new one. */
  role: RoleDefinition | null
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const session = useSessionRole()
  const { record } = useEntitlement()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [chosen, setChosen] = useState<Set<PermissionId>>(new Set())
  const [error, setError] = useState<string | undefined>()

  const grantable = useMemo(
    () => new Set(grantablePermissions(session.role, record, session.catalog)),
    [session.role, session.catalog, record],
  )

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setChosen(new Set(role?.permissions ?? []))
  }, [open, role])

  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), description: description.trim(), permissions: [...chosen] }
      return role ? rolesApi.update(role.id, input) : rolesApi.create(input)
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries()
      toast.show({
        tone: 'success',
        title: role ? `${saved.name} saved` : `${saved.name} created`,
        description: role ? undefined : 'You can assign it from anyone’s row.',
      })
      onClose()
    },
    onError: (problem) => {
      if (problem instanceof HttpError) {
        setError(problem.message)
        return
      }
      toast.show({ tone: 'danger', title: 'That did not save' })
    },
  })

  const toggle = (permission: PermissionId) => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(permission)) next.delete(permission)
      else next.add(permission)
      return next
    })
  }

  const groups = GROUP_ORDER.map((group) => ({
    group,
    permissions: [...grantable].filter((id) => PERMISSIONS[id].group === group),
  })).filter((entry) => entry.permissions.length > 0)

  const submit = () => {
    if (!name.trim()) {
      setError('Give the role a name.')
      return
    }
    if (chosen.size === 0) {
      setError('A role that grants nothing has no use. Tick at least one thing.')
      return
    }
    save.mutate()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={role ? `Edit ${role.name}` : 'New role'}
      description="Start from the least someone needs. You can always add more later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={submit}>
            {role ? 'Save changes' : 'Create the role'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="rounded-lg border border-danger-border bg-danger-subtle p-3 text-base text-text-muted">
            {error}
          </div>
        )}

        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(undefined)
          }}
          hint="What you would call this job. Shift lead, Weekend cover, Bar manager."
        />

        <Textarea
          label="What it is for"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          hint="One line, so the next person to look knows why it exists."
        />

        {/* The ceiling, said out loud. Someone who cannot find a permission
            here should understand why before they go looking for a bug. */}
        <Card className="border-accent-border bg-accent-subtle">
          <div className="flex gap-3">
            <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-accent-text" />
            <p className="text-base text-text-muted">
              You can only give a role what you hold yourself, and only what your plan includes.
              A role you define always sits below Manager, whoever assigns it.
            </p>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          {groups.map(({ group, permissions }) => (
            <fieldset key={group}>
              <legend className="text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
                {GROUP_LABELS[group]}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {permissions.map((id) => {
                  const permission = PERMISSIONS[id]
                  const on = chosen.has(id)
                  return (
                    <label
                      key={id}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors',
                        on ? 'border-accent bg-accent-subtle' : 'border-border hover:bg-surface-hover',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(id)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="text-base font-medium text-text">{permission.name}</span>
                          {permission.sensitive && (
                            <Icon
                              name="ShieldCheck"
                              size="sm"
                              className="shrink-0 text-warning-text"
                              label="Moves money or grants access"
                            />
                          )}
                        </span>
                        <span className="block text-sm text-text-subtle">{permission.description}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <p className="text-sm text-text-subtle">
          {chosen.size} of {grantable.size} things you could give.
        </p>
      </div>
    </Dialog>
  )
}

export type { StaffMember }
