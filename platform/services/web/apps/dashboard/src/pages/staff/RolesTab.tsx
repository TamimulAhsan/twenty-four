import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HttpError, roles as rolesApi, type StaffMember } from '@twentyfour/api'
import { useEntitlement } from '@twentyfour/entitlement'
import {
  GROUP_LABELS, GROUP_ORDER, PERMISSIONS, availablePermissions, can, useSessionRole,
  usePermission, type PermissionGroup, type PermissionId, type RoleDefinition,
} from '@twentyfour/rbac'
import {
  Badge, Button, Card, Dialog, Icon, Table, TableScroll, Td, Th, Tr, cn, useToast,
} from '@twentyfour/ui'
import { RoleFormDialog } from './RoleFormDialog'

/**
 * What each role can do, side by side.
 *
 * A matrix rather than separate lists, because the question a merchant has is
 * comparative: "if I make them a manager instead, what changes".
 *
 * Only permissions that exist for this tenant are shown. One whose module they
 * do not hold is absent rather than greyed out: showing a salon on Starter a
 * row for approving ad creative teaches them only that the product has parts
 * they cannot see.
 */
export function RolesTab({ members }: { members: readonly StaffMember[] }) {
  const { record } = useEntitlement()
  const session = useSessionRole()
  const mayEditRoles = usePermission('staff.roles')
  const [detail, setDetail] = useState<RoleDefinition | null>(null)
  const [editing, setEditing] = useState<RoleDefinition | null>(null)
  const [creating, setCreating] = useState(false)

  const catalog = session.catalog
  const available = new Set(availablePermissions(record))

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    permissions: (Object.keys(PERMISSIONS) as PermissionId[]).filter(
      (id) => PERMISSIONS[id].group === group && available.has(id),
    ),
  })).filter((entry) => entry.permissions.length > 0)

  const headcount = (role: RoleDefinition) =>
    members.filter((member) => member.role === role.id && member.status !== 'deactivated').length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base text-text-muted">
          {catalog.length} roles, {catalog.filter((role) => !role.builtIn).length} of them yours.
        </p>
        {mayEditRoles && (
          <Button size="sm" iconStart="Plus" onClick={() => setCreating(true)}>
            New role
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {catalog.map((role) => (
          <button
            key={role.id}
            type="button"
            onClick={() => setDetail(role)}
            className={cn(
              'flex flex-col rounded-xl border border-border bg-surface p-4 text-left transition-colors',
              'hover:bg-surface-hover',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-md font-semibold text-text">{role.name}</h3>
              <Badge tone={headcount(role) > 0 ? 'accent' : 'neutral'}>
                {headcount(role)} {headcount(role) === 1 ? 'person' : 'people'}
              </Badge>
            </div>
            <p className="mt-1.5 flex-1 text-sm text-text-muted">{role.description}</p>
            {!role.builtIn && (
              <span className="mt-2">
                <Badge tone="neutral">Yours</Badge>
              </span>
            )}
          </button>
        ))}
      </div>

      <Card padded={false}>
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th className="min-w-56">Permission</Th>
                {catalog.map((role) => (
                  <Th key={role.id} className="text-center">{role.name}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ group, permissions }) => (
                <GroupRows key={group} group={group} permissions={permissions} catalog={catalog} />
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      <Card className="border-warning-border bg-warning-subtle">
        <div className="flex gap-3">
          <Icon name="ShieldCheck" size="lg" className="mt-0.5 shrink-0 text-warning-text" />
          <div className="text-base text-text-muted">
            <p className="font-medium text-text">Marked permissions move money or grant access</p>
            <p className="mt-1">
              Refunds, discounts, corrections, tax settings and the ability to change roles. They
              are worth a moment before handing out, which is why they are marked rather than
              listed like the rest.
            </p>
          </div>
        </div>
      </Card>

      <RoleDetailDialog
        role={detail}
        holders={detail ? members.filter((member) => member.role === detail.id) : []}
        onClose={() => setDetail(null)}
        onEdit={() => {
          setEditing(detail)
          setDetail(null)
        }}
      />
      <RoleFormDialog role={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <RoleFormDialog role={null} open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function GroupRows({
  group,
  permissions,
  catalog,
}: {
  group: PermissionGroup
  permissions: readonly PermissionId[]
  catalog: readonly RoleDefinition[]
}) {
  return (
    <>
      <tr>
        <td colSpan={catalog.length + 1} className="border-b border-border bg-surface-sunken px-3 py-1.5">
          <span className="text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">
            {GROUP_LABELS[group]}
          </span>
        </td>
      </tr>
      {permissions.map((id) => (
        <Tr key={id}>
          <Td>
            <span className="flex items-start gap-2">
              {PERMISSIONS[id].sensitive && (
                <Icon
                  name="ShieldCheck"
                  size="sm"
                  className="mt-1 shrink-0 text-warning-text"
                  label="Moves money or grants access"
                />
              )}
              <span className="min-w-0">
                <span className="block font-medium text-text">{PERMISSIONS[id].name}</span>
                <span className="block text-sm text-text-subtle">{PERMISSIONS[id].description}</span>
              </span>
            </span>
          </Td>
          {catalog.map((role) => {
            const allowed = can(role.id, id, catalog)
            return (
              <Td key={role.id} className="text-center">
                {/* An icon and a label, not a colour. A tick and an empty cell
                    read identically to anyone who cannot separate the hues. */}
                <span className="sr-only">
                  {role.name} {allowed ? 'can' : 'cannot'} {PERMISSIONS[id].name}
                </span>
                <Icon
                  name={allowed ? 'Check' : 'Minus'}
                  size="md"
                  className={cn('mx-auto', allowed ? 'text-success-text' : 'text-text-subtle opacity-40')}
                />
              </Td>
            )
          })}
        </Tr>
      ))}
    </>
  )
}

/** One role in full, with what it grants and who holds it. */
function RoleDetailDialog({
  role,
  holders,
  onClose,
  onEdit,
}: {
  role: RoleDefinition | null
  holders: readonly StaffMember[]
  onClose: () => void
  onEdit: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { record } = useEntitlement()
  const mayEditRoles = usePermission('staff.roles')
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => rolesApi.remove(role!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      toast.show({ tone: 'success', title: `${role?.name} removed` })
      setConfirming(false)
      onClose()
    },
    onError: (error) =>
      toast.show({
        tone: 'danger',
        title: 'That role could not be removed',
        description: error instanceof HttpError ? error.message : undefined,
      }),
  })

  const available = new Set(availablePermissions(record))
  const granted = (role?.permissions ?? []).filter((id) => available.has(id))
  const active = holders.filter((member) => member.status !== 'deactivated')
  // Deleting a role somebody holds would silently reduce their access to
  // nothing, so the button is held back until they are moved.
  const inUse = active.length > 0

  return (
    <Dialog
      open={role !== null}
      onClose={onClose}
      size="lg"
      title={role?.name ?? ''}
      description={role?.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {role && !role.builtIn && mayEditRoles && (
            <>
              <Button variant="outline" iconStart="Pencil" onClick={onEdit}>Edit</Button>
              <Button
                variant="danger"
                disabled={inUse}
                title={inUse ? 'Move the people holding it to another role first.' : undefined}
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            </>
          )}
        </>
      }
    >
      {role && (
        <div className="flex flex-col gap-5">
          {confirming && (
            <Card className="border-danger-border bg-danger-subtle">
              <p className="text-base font-medium text-text">Delete {role.name}?</p>
              <p className="mt-1 text-base text-text-muted">
                Nobody holds it, so nobody loses access. It cannot be recovered.
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep it</Button>
                <Button variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Delete it
                </Button>
              </div>
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={role.builtIn ? 'neutral' : 'accent'}>
              {role.builtIn ? 'Ships with the product' : 'Defined by you'}
            </Badge>
            <Badge tone="neutral">
              {active.length} {active.length === 1 ? 'person holds it' : 'people hold it'}
            </Badge>
          </div>

          {role.builtIn && (
            <p className="flex items-start gap-2 text-sm text-text-muted">
              <Icon name="Info" size="sm" className="mt-0.5 shrink-0" />
              The four roles that ship cannot be changed. Create one of your own if none of them
              fits.
            </p>
          )}

          {inUse && !role.builtIn && (
            <p className="flex items-start gap-2 text-sm text-warning-text">
              <Icon name="TriangleAlert" size="sm" className="mt-0.5 shrink-0" />
              {active.map((member) => member.name).join(', ')} hold this role. Move them to another
              one before deleting it.
            </p>
          )}

          <div>
            <p className="text-sm font-medium text-text">
              What it lets someone do here
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
        </div>
      )}
    </Dialog>
  )
}
