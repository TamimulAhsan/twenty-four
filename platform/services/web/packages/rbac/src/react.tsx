import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { PermissionId } from './permissions'
import { BUILT_IN_ROLES, can, roleDefinition, type RoleCatalog, type RoleId } from './roles'

export interface SessionRoleContextValue {
  readonly role: RoleId
  readonly userId: string
  /** Every role this tenant has, built-in and their own. Held here so a
   *  screen never has to fetch it twice or reason about two lists. */
  readonly catalog: RoleCatalog
  can(permission: PermissionId): boolean
}

const SessionRoleContext = createContext<SessionRoleContextValue | null>(null)

/**
 * The signed-in person's role.
 *
 * Used to hide actions they cannot take, so a screen does not offer a button
 * that will be refused. It is not the control: the gateway evaluates the same
 * policy, and a missing check here is a confusing screen rather than a breach.
 */
export function SessionRoleProvider({
  role,
  userId,
  catalog = BUILT_IN_ROLES,
  children,
}: {
  role: RoleId
  userId: string
  catalog?: RoleCatalog
  children: ReactNode
}) {
  const value = useMemo<SessionRoleContextValue>(
    () => ({ role, userId, catalog, can: (permission) => can(role, permission, catalog) }),
    [role, userId, catalog],
  )
  return <SessionRoleContext.Provider value={value}>{children}</SessionRoleContext.Provider>
}

export function useSessionRole(): SessionRoleContextValue {
  const value = useContext(SessionRoleContext)
  if (!value) throw new Error('useSessionRole must be used inside a SessionRoleProvider')
  return value
}

export function usePermission(permission: PermissionId): boolean {
  return useSessionRole().can(permission)
}

export function useRoleDefinition() {
  const { role, catalog } = useSessionRole()
  return roleDefinition(role, catalog)
}

/** The tenant's full role list. */
export function useRoleCatalog(): RoleCatalog {
  return useSessionRole().catalog
}
