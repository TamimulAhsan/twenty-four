import type { ModuleId } from '@twentyfour/entitlement'
import { PERMISSIONS, PERMISSION_IDS, type PermissionId } from './permissions'

export const BUILT_IN_ROLE_IDS = ['owner', 'manager', 'bookkeeper', 'staff'] as const
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number]

/**
 * A role id.
 *
 * A string rather than a union, because a tenant may define their own. The
 * four built-ins keep their fixed ids and cannot be edited or removed.
 */
export type RoleId = string

export interface RoleDefinition {
  readonly id: RoleId
  readonly name: string
  readonly description: string
  /** Built-in roles cannot be edited, renamed or deleted. */
  readonly builtIn: boolean
  readonly permissions: readonly PermissionId[]
  /**
   * Only a role of equal or higher standing may assign this one.
   *
   * A custom role is always rank 1. Letting a tenant mint a rank above their
   * own is privilege escalation with extra steps: someone who can create
   * roles could create one that outranks the person who created it, then have
   * it assigned to themselves.
   */
  readonly rank: number
}

/** Rank a custom role always takes: level with staff and bookkeeper. */
export const CUSTOM_ROLE_RANK = 1

const ALL: readonly PermissionId[] = PERMISSION_IDS

export const ROLES: Readonly<Record<BuiltInRoleId, RoleDefinition>> = {
  owner: {
    id: 'owner',
    name: 'Owner',
    description:
      'Everything, including the plan and the bill. There is always at least one.',
    builtIn: true,
    rank: 3,
    permissions: ALL,
  },
  manager: {
    id: 'manager',
    name: 'Manager',
    description:
      'Runs the business day to day. Everything except paying for it.',
    builtIn: true,
    rank: 2,
    // The bill is the owner's alone. A manager who could change the plan
    // could change what the business is charged without being the person
    // whose card is on file.
    permissions: ALL.filter((id) => id !== 'settings.billing'),
  },
  bookkeeper: {
    id: 'bookkeeper',
    name: 'Bookkeeper',
    description:
      'Reads the money and issues corrections. Cannot sell, and cannot change prices.',
    builtIn: true,
    rank: 1,
    permissions: [
      'catalog.view',
      'payments.view',
      'payments.refund',
      'documents.view',
      'documents.correct',
      'reports.operational',
      'reports.financial',
      'staff.view',
    ],
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    description:
      'Serves customers. Sells, takes bookings, and sees what they need to.',
    builtIn: true,
    rank: 1,
    permissions: [
      'catalog.view',
      'pos.sell',
      'pos.close_day',
      'bookings.view',
      'bookings.manage',
      'inventory.view',
      'staff.view',
      'reports.operational',
    ],
  },
}

/** The four that ship. A tenant's own roles are appended to these. */
export const BUILT_IN_ROLES: readonly RoleDefinition[] = BUILT_IN_ROLE_IDS.map((id) => ROLES[id])

export type RoleCatalog = readonly RoleDefinition[]

export function findRole(role: RoleId, catalog: RoleCatalog = BUILT_IN_ROLES): RoleDefinition | undefined {
  return catalog.find((entry) => entry.id === role)
}

/**
 * Falls back to a role that grants nothing.
 *
 * A role id that is not in the catalog means a custom role was deleted while
 * someone still held it. Granting nothing is the only safe reading; granting
 * a default would hand out access nobody chose.
 */
export function roleDefinition(role: RoleId, catalog: RoleCatalog = BUILT_IN_ROLES): RoleDefinition {
  return (
    findRole(role, catalog) ?? {
      id: role,
      name: 'Unknown role',
      description: 'This role no longer exists. It grants nothing until someone is reassigned.',
      builtIn: false,
      permissions: [],
      rank: CUSTOM_ROLE_RANK,
    }
  )
}

export function can(role: RoleId, permission: PermissionId, catalog: RoleCatalog = BUILT_IN_ROLES): boolean {
  return roleDefinition(role, catalog).permissions.includes(permission)
}

/**
 * The permissions that exist for this tenant.
 *
 * A permission whose module the tenant does not hold is not "denied", it is
 * absent: showing a salon on Starter a greyed-out row for approving ad creative
 * teaches them nothing except that the product has parts they cannot see.
 */
export function availablePermissions(entitlement: {
  modules: readonly ModuleId[]
}): PermissionId[] {
  const held = new Set(entitlement.modules)
  return PERMISSION_IDS.filter((id) => {
    const module = PERMISSIONS[id].module
    return module === undefined || held.has(module)
  })
}

/** What a role actually grants this tenant, module filtering applied. */
export function grantedPermissions(
  role: RoleId,
  entitlement: { modules: readonly ModuleId[] },
  catalog: RoleCatalog = BUILT_IN_ROLES,
): PermissionId[] {
  const available = new Set(availablePermissions(entitlement))
  return roleDefinition(role, catalog).permissions.filter((id) => available.has(id))
}

/**
 * What an author is allowed to put in a role they are creating.
 *
 * Their own permissions and no more. Without this, anyone who can define a
 * role can define one that grants everything and have it assigned to
 * themselves, which makes every other check on this page decorative.
 */
export function grantablePermissions(
  author: RoleId,
  entitlement: { modules: readonly ModuleId[] },
  catalog: RoleCatalog = BUILT_IN_ROLES,
): PermissionId[] {
  const held = new Set(roleDefinition(author, catalog).permissions)
  return availablePermissions(entitlement).filter((id) => held.has(id))
}

/* -------------------------------------------------------------------------
 * The rules that stop a team locking itself out
 * ---------------------------------------------------------------------- */

export interface TeamMember {
  readonly id: string
  readonly role: RoleId
  readonly status: 'active' | 'invited' | 'deactivated'
}

/** Nobody may hand out standing they do not have themselves. */
export function canAssignRole(
  actor: RoleId,
  target: RoleId,
  catalog: RoleCatalog = BUILT_IN_ROLES,
): boolean {
  return (
    roleDefinition(actor, catalog).rank >= roleDefinition(target, catalog).rank &&
    can(actor, 'staff.roles', catalog)
  )
}

export function assignableRoles(actor: RoleId, catalog: RoleCatalog = BUILT_IN_ROLES): RoleId[] {
  return [...catalog]
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
    .map((role) => role.id)
    .filter((role) => canAssignRole(actor, role, catalog))
}

/** May this role be edited or removed at all. */
export function isEditableRole(role: RoleId, catalog: RoleCatalog = BUILT_IN_ROLES): boolean {
  return findRole(role, catalog)?.builtIn === false
}

/** Owners who can still sign in. An invited owner counts: they will. */
export function activeOwners(members: readonly TeamMember[]): TeamMember[] {
  return members.filter((member) => member.role === 'owner' && member.status !== 'deactivated')
}

/**
 * The last owner cannot be demoted, deactivated or removed.
 *
 * Without this a tenant can lock itself out of its own subscription page, and
 * recovering it costs a support call and an impersonation token.
 */
export function isLastOwner(members: readonly TeamMember[], memberId: string): boolean {
  const owners = activeOwners(members)
  return owners.length === 1 && owners[0]?.id === memberId
}

export type MemberActionRefusal =
  | 'not_permitted'
  | 'last_owner'
  | 'self_role'
  | 'self_deactivate'
  | 'outranked'

export interface ActionCheck {
  readonly allowed: boolean
  readonly reason?: MemberActionRefusal
  readonly message?: string
}

const OK: ActionCheck = { allowed: true }

const refuse = (reason: MemberActionRefusal, message: string): ActionCheck => ({
  allowed: false,
  reason,
  message,
})

export function checkRoleChange(input: {
  actor: TeamMember
  target: TeamMember
  nextRole: RoleId
  members: readonly TeamMember[]
  catalog?: RoleCatalog
}): ActionCheck {
  const { actor, target, nextRole, members } = input
  const catalog = input.catalog ?? BUILT_IN_ROLES

  if (!can(actor.role, 'staff.roles', catalog)) {
    return refuse('not_permitted', 'You cannot change what people are allowed to do.')
  }
  // Changing your own role is how a manager quietly becomes an owner, and how
  // an owner accidentally locks themselves out of the bill.
  if (actor.id === target.id) {
    return refuse('self_role', 'You cannot change your own role. Ask another owner.')
  }
  if (!canAssignRole(actor.role, nextRole, catalog)) {
    return refuse('outranked', `You cannot give someone the ${roleDefinition(nextRole, catalog).name} role.`)
  }
  if (!canAssignRole(actor.role, target.role, catalog)) {
    return refuse('outranked', `You cannot change a ${roleDefinition(target.role, catalog).name}.`)
  }
  if (nextRole !== 'owner' && isLastOwner(members, target.id)) {
    return refuse('last_owner', 'This is the only owner. Make someone else an owner first.')
  }
  return OK
}

export function checkDeactivate(input: {
  actor: TeamMember
  target: TeamMember
  members: readonly TeamMember[]
  catalog?: RoleCatalog
}): ActionCheck {
  const { actor, target, members } = input
  const catalog = input.catalog ?? BUILT_IN_ROLES

  if (!can(actor.role, 'staff.manage', catalog)) {
    return refuse('not_permitted', 'You cannot change who has access.')
  }
  if (actor.id === target.id) {
    return refuse('self_deactivate', 'You cannot remove your own access.')
  }
  if (!canAssignRole(actor.role, target.role, catalog)) {
    return refuse('outranked', `You cannot remove a ${roleDefinition(target.role, catalog).name}.`)
  }
  if (isLastOwner(members, target.id)) {
    return refuse('last_owner', 'This is the only owner. Make someone else an owner first.')
  }
  return OK
}

/**
 * A seat is a person who can sign in.
 *
 * An invitation that has not been accepted still holds one, because it will be
 * accepted. A deactivated account does not, because it cannot. Counting
 * anything else lets a tenant sit above their tier by leaving invitations open.
 */
export function seatsUsed(members: readonly TeamMember[]): number {
  return members.filter((member) => member.status !== 'deactivated').length
}

/** `limit` is null when seats are negotiated, which never blocks. */
export function canInvite(limit: number | null, members: readonly TeamMember[]): boolean {
  return limit === null || seatsUsed(members) < limit
}

export function seatsRemaining(
  limit: number | null,
  members: readonly TeamMember[],
): number | null {
  return limit === null ? null : Math.max(0, limit - seatsUsed(members))
}
