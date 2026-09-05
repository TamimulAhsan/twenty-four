import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ModuleId } from './modules'
import type { CapabilityId } from './profiles'
import { buildNav, DEFAULT_LAUNCH_TARGETS, type LaunchTargets, type NavGroup } from './nav'
import {
  canAddStaff,
  hasCapability,
  hasModule,
  isPending,
  seatsRemaining,
  type EntitlementRecord,
} from './resolve'

export interface EntitlementContextValue {
  readonly record: EntitlementRecord
  readonly nav: NavGroup[]
  has(id: ModuleId): boolean
  pending(id: ModuleId): boolean
  can(id: CapabilityId): boolean
  readonly seatsLeft: number | null
  readonly canAddStaff: boolean
}

const EntitlementContext = createContext<EntitlementContextValue | null>(null)

export function EntitlementProvider({
  record,
  launchTargets = DEFAULT_LAUNCH_TARGETS,
  children,
}: {
  record: EntitlementRecord
  /** Where the sibling applications live. Comes from the build environment,
   *  because a separate bundle has a separate address. */
  launchTargets?: LaunchTargets
  children: ReactNode
}) {
  const value = useMemo<EntitlementContextValue>(
    () => ({
      record,
      nav: buildNav(record, launchTargets),
      has: (id) => hasModule(record, id),
      pending: (id) => isPending(record, id),
      can: (id) => hasCapability(record, id),
      seatsLeft: seatsRemaining(record),
      canAddStaff: canAddStaff(record),
    }),
    [record, launchTargets],
  )
  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>
}

export function useEntitlement(): EntitlementContextValue {
  const value = useContext(EntitlementContext)
  if (!value) throw new Error('useEntitlement must be used inside an EntitlementProvider')
  return value
}

export function useModule(id: ModuleId): boolean {
  return useEntitlement().has(id)
}

export function useCapability(id: CapabilityId): boolean {
  return useEntitlement().can(id)
}

/**
 * Hides a fragment the tenant has not bought.
 *
 * A convenience for keeping a screen tidy, not a security control. The gateway
 * refuses the call whatever this renders; if the only thing stopping a request
 * is a component that did not mount, the check is in the wrong place.
 */
export function ModuleGate({
  module,
  capability,
  fallback = null,
  children,
}: {
  module?: ModuleId
  capability?: CapabilityId
  fallback?: ReactNode
  children: ReactNode
}) {
  const entitlement = useEntitlement()
  const allowed =
    (module === undefined || entitlement.has(module)) &&
    (capability === undefined || entitlement.can(capability))
  return <>{allowed ? children : fallback}</>
}
