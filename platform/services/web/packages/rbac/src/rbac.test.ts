import { describe, expect, it } from 'vitest'
import { resolveEntitlement } from '@twentyfour/entitlement'
import {
  PERMISSIONS,
  PERMISSION_IDS,
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_IDS,
  ROLES,
  assignableRoles,
  availablePermissions,
  can,
  canAssignRole,
  canInvite,
  checkDeactivate,
  checkRoleChange,
  grantablePermissions,
  grantedPermissions,
  isEditableRole,
  isLastOwner,
  roleDefinition,
  seatsUsed,
  type RoleId,
  type TeamMember,
} from './index'

const member = (id: string, role: RoleId, status: TeamMember['status'] = 'active'): TeamMember => ({
  id,
  role,
  status,
})

describe('permission catalog', () => {
  it('describes every permission it declares', () => {
    for (const id of PERMISSION_IDS) {
      expect(PERMISSIONS[id].name, id).toBeTruthy()
      expect(PERMISSIONS[id].description, id).toBeTruthy()
    }
  })

  it('grants an owner everything', () => {
    for (const id of PERMISSION_IDS) {
      expect(can('owner', id), id).toBe(true)
    }
  })

  // The bill is the owner's alone: a manager who could change the plan could
  // change what the business is charged without being the person paying.
  it('keeps the bill with the owner', () => {
    expect(can('manager', 'settings.billing')).toBe(false)
    expect(can('owner', 'settings.billing')).toBe(true)
  })

  it('does not let staff change prices or refund', () => {
    expect(can('staff', 'catalog.view')).toBe(true)
    expect(can('staff', 'catalog.edit')).toBe(false)
    expect(can('staff', 'pos.refund')).toBe(false)
    expect(can('staff', 'staff.roles')).toBe(false)
  })

  it('lets a bookkeeper read the money but never sell', () => {
    expect(can('bookkeeper', 'reports.financial')).toBe(true)
    expect(can('bookkeeper', 'documents.correct')).toBe(true)
    expect(can('bookkeeper', 'pos.sell')).toBe(false)
    expect(can('bookkeeper', 'catalog.edit')).toBe(false)
  })
})

describe('availablePermissions', () => {
  // A permission whose module the tenant does not hold is absent, not denied.
  // Showing a salon on Starter a row for approving ad creative teaches them
  // only that the product has parts they cannot see.
  it('hides permissions for modules the tenant does not hold', () => {
    const starter = resolveEntitlement({ tenantId: 't', tier: 'starter', industry: 'hair_salon' })
    const available = availablePermissions(starter)
    expect(available).toContain('pos.sell')
    expect(available).not.toContain('marketing.manage')
  })

  it('reveals them once the tenant holds the module', () => {
    const growth = resolveEntitlement({ tenantId: 't', tier: 'growth', industry: 'hair_salon' })
    expect(availablePermissions(growth)).toContain('marketing.manage')
  })

  it('filters what a role actually grants, not just what it lists', () => {
    const starter = resolveEntitlement({ tenantId: 't', tier: 'starter', industry: 'hair_salon' })
    expect(ROLES.owner.permissions).toContain('marketing.manage')
    expect(grantedPermissions('owner', starter)).not.toContain('marketing.manage')
  })

  it('always keeps permissions whose module ships with every tenant', () => {
    const starter = resolveEntitlement({ tenantId: 't', tier: 'starter', industry: 'hair_salon' })
    expect(availablePermissions(starter)).toContain('staff.manage')
    expect(availablePermissions(starter)).toContain('settings.business')
  })
})

describe('assigning roles', () => {
  it('never lets someone hand out standing they do not have', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'manager', 'bookkeeper', 'staff'])
    expect(assignableRoles('manager')).not.toContain('owner')
    // Staff cannot assign at all: they do not hold staff.roles.
    expect(assignableRoles('staff')).toEqual([])
    expect(assignableRoles('bookkeeper')).toEqual([])
  })

  it('refuses a manager promoting anyone to owner', () => {
    const check = checkRoleChange({
      actor: member('a', 'manager'),
      target: member('b', 'staff'),
      nextRole: 'owner',
      members: [member('o', 'owner'), member('a', 'manager'), member('b', 'staff')],
    })
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('outranked')
  })

  it('refuses a manager changing an owner', () => {
    const check = checkRoleChange({
      actor: member('a', 'manager'),
      target: member('o', 'owner'),
      nextRole: 'staff',
      members: [member('o', 'owner'), member('a', 'manager')],
    })
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('outranked')
  })

  // Changing your own role is how a manager quietly becomes an owner, and how
  // an owner accidentally locks themselves out of their own bill.
  it('refuses anyone changing their own role', () => {
    const check = checkRoleChange({
      actor: member('o', 'owner'),
      target: member('o', 'owner'),
      nextRole: 'manager',
      members: [member('o', 'owner'), member('b', 'owner')],
    })
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('self_role')
  })

  it('allows an owner promoting a manager', () => {
    const check = checkRoleChange({
      actor: member('o', 'owner'),
      target: member('a', 'manager'),
      nextRole: 'owner',
      members: [member('o', 'owner'), member('a', 'manager')],
    })
    expect(check.allowed).toBe(true)
  })
})

describe('the last owner', () => {
  it('recognises the only owner who can still sign in', () => {
    const members = [member('o', 'owner'), member('x', 'owner', 'deactivated'), member('a', 'staff')]
    expect(isLastOwner(members, 'o')).toBe(true)
    expect(isLastOwner(members, 'a')).toBe(false)
  })

  it('counts an invited owner, because they will sign in', () => {
    const members = [member('o', 'owner'), member('n', 'owner', 'invited')]
    expect(isLastOwner(members, 'o')).toBe(false)
  })

  // Without this a tenant locks itself out of its own subscription page, and
  // recovering it costs a support call and an impersonation token.
  it('refuses demoting the only owner', () => {
    const members = [member('o', 'owner'), member('a', 'manager')]
    const check = checkRoleChange({
      actor: member('o', 'owner'),
      target: member('o', 'owner'),
      nextRole: 'manager',
      members,
    })
    expect(check.allowed).toBe(false)
  })

  it('refuses deactivating the only owner', () => {
    const members = [member('o', 'owner'), member('a', 'manager')]
    const check = checkDeactivate({
      actor: member('a2', 'owner'),
      target: member('o', 'owner'),
      members,
    })
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('last_owner')
  })

  it('allows it once a second owner exists', () => {
    const members = [member('o', 'owner'), member('p', 'owner')]
    const check = checkDeactivate({
      actor: member('p', 'owner'),
      target: member('o', 'owner'),
      members,
    })
    expect(check.allowed).toBe(true)
  })
})

describe('seats', () => {
  // An unaccepted invitation still holds a seat, because it will be accepted.
  // Counting anything else lets a tenant sit above their tier by leaving
  // invitations open.
  it('counts invitations and ignores deactivated accounts', () => {
    const members = [
      member('a', 'owner'),
      member('b', 'staff', 'invited'),
      member('c', 'staff', 'deactivated'),
    ]
    expect(seatsUsed(members)).toBe(2)
  })

  it('blocks an invitation at the limit', () => {
    const starter = resolveEntitlement({ tenantId: 't', tier: 'starter', industry: 'hair_salon' })
    expect(starter.seats.limit).toBe(3)
    const three = [member('a', 'owner'), member('b', 'staff'), member('c', 'staff', 'invited')]
    expect(canInvite(starter.seats.limit, three)).toBe(false)
    expect(canInvite(starter.seats.limit, three.slice(0, 2))).toBe(true)
  })

  it('never blocks a tenant whose seats are negotiated', () => {
    const enterprise = resolveEntitlement({
      tenantId: 't',
      tier: 'enterprise',
      industry: 'hair_salon',
    })
    expect(enterprise.seats.limit).toBeNull()
    expect(
      canInvite(enterprise.seats.limit, Array.from({ length: 50 }, (_, i) => member(`m${i}`, 'staff'))),
    ).toBe(true)
  })
})

describe('role definitions', () => {
  it('describes every role it declares', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(role.name, role.id).toBeTruthy()
      expect(role.description, role.id).toBeTruthy()
      expect(role.permissions.length, role.id).toBeGreaterThan(0)
    }
  })

  it('gives every role the ability to see the team it belongs to', () => {
    for (const id of BUILT_IN_ROLE_IDS) {
      expect(can(id, 'staff.view'), id).toBe(true)
    }
  })

  it('marks the four that ship as not editable', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(role.builtIn, role.id).toBe(true)
    }
  })
})

describe('custom roles', () => {
  const shiftLead = {
    id: 'shift_lead',
    name: 'Shift lead',
    description: 'Runs the floor on a shift.',
    builtIn: false,
    permissions: ['catalog.view', 'pos.sell', 'pos.discount', 'staff.view'] as const,
    rank: 1,
  }
  const catalog = [...BUILT_IN_ROLES, shiftLead]

  it('reads a tenant role the same way as a built-in one', () => {
    expect(can('shift_lead', 'pos.discount', catalog)).toBe(true)
    expect(can('shift_lead', 'pos.refund', catalog)).toBe(false)
    expect(roleDefinition('shift_lead', catalog).name).toBe('Shift lead')
  })

  // Letting a tenant mint a rank above their own is privilege escalation with
  // extra steps: create a role that outranks you, then have it assigned to
  // yourself.
  it('never lets a custom role outrank a manager', () => {
    expect(canAssignRole('manager', 'shift_lead', catalog)).toBe(true)
    expect(canAssignRole('shift_lead', 'manager', catalog)).toBe(false)
    // It cannot assign at all: it does not hold staff.roles.
    expect(assignableRoles('shift_lead', catalog)).toEqual([])
  })

  it('offers a custom role alongside the built-ins', () => {
    expect(assignableRoles('owner', catalog)).toContain('shift_lead')
  })

  // Without this, anyone who can define a role can define one that grants
  // everything and have it assigned to themselves.
  it('limits what an author may put in a role to what they hold', () => {
    const growth = resolveEntitlement({ tenantId: 't', tier: 'growth', industry: 'hair_salon' })

    const byOwner = grantablePermissions('owner', growth, catalog)
    expect(byOwner).toContain('settings.billing')

    const byManager = grantablePermissions('manager', growth, catalog)
    expect(byManager).not.toContain('settings.billing')
    expect(byManager).toContain('pos.refund')

    // And it is still filtered by what the tenant bought.
    const starter = resolveEntitlement({ tenantId: 't', tier: 'starter', industry: 'hair_salon' })
    expect(grantablePermissions('owner', starter, catalog)).not.toContain('marketing.manage')
  })

  it('protects the four that ship from being edited', () => {
    expect(isEditableRole('owner', catalog)).toBe(false)
    expect(isEditableRole('shift_lead', catalog)).toBe(true)
  })

  // A role can be deleted while somebody still holds it. Granting nothing is
  // the only safe reading: a default would hand out access nobody chose.
  it('grants nothing for a role that no longer exists', () => {
    expect(can('deleted_role', 'pos.sell', catalog)).toBe(false)
    expect(roleDefinition('deleted_role', catalog).permissions).toEqual([])
  })
})
