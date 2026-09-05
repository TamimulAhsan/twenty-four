/**
 * The entitlement record.
 *
 *   entitlement = tier module set  union  industry profile capabilities
 *                 union  manual overrides
 *
 * The tier is chosen and paid for. The profile follows from business type and
 * costs nothing. Overrides are recorded per tenant by a specialist, are visible
 * in the admin console and the audit log, and deliberately do not move the
 * price.
 *
 * The gateway checks the resulting set and neither knows nor cares which source
 * put an entry there. That is what stops a trade capability needing its own
 * enforcement path.
 *
 * IMPORTANT: everything in this package is a UX concern. Entitlement is
 * enforced once, at the gateway, from a Redis policy cache. A gate missing here
 * is a screen a merchant should not see; it is not a data leak, and it is not a
 * substitute for the server refusing the call.
 */
import { resolveDependencies, requiresSpecialist, type ModuleId } from './modules'
import { profileCapabilities, type CapabilityId } from './profiles'
import { tierDefinition, type TierId } from './tiers'

export interface EntitlementOverride {
  readonly moduleId: ModuleId
  /** Who recorded it, for the audit trail the console renders. */
  readonly grantedBy: string
  readonly reason: string
  readonly at: string
}

export interface SeatQuota {
  /** null means negotiated, which Enterprise uses. */
  readonly limit: number | null
  readonly used: number
}

export interface EntitlementRecord {
  readonly tenantId: string
  readonly tier: TierId
  /** Business type. Decides capabilities and vocabulary, never price. */
  readonly industry: string
  /** Resolved: tier grants, their dependencies, and overrides. */
  readonly modules: readonly ModuleId[]
  /** From the industry profile. Nobody chose these. */
  readonly capabilities: readonly CapabilityId[]
  readonly seats: SeatQuota
  readonly overrides: readonly EntitlementOverride[]
  /**
   * Paid for, but a provisioning step could not complete unattended and is
   * queued to a specialist. The merchant is told what is still coming; the
   * module is not yet usable.
   */
  readonly pending: readonly ModuleId[]
}

export interface ResolveEntitlementInput {
  readonly tenantId: string
  readonly tier: TierId
  readonly industry: string
  readonly overrides?: readonly EntitlementOverride[]
  readonly seatsUsed?: number
  readonly seatLimitOverride?: number | null
  readonly pending?: readonly ModuleId[]
}

export function resolveEntitlement(input: ResolveEntitlementInput): EntitlementRecord {
  const tier = tierDefinition(input.tier)
  const overrides = input.overrides ?? []
  const selected = [...tier.grants, ...overrides.map((override) => override.moduleId)]

  return {
    tenantId: input.tenantId,
    tier: input.tier,
    industry: input.industry,
    modules: resolveDependencies(selected),
    capabilities: profileCapabilities(input.industry),
    seats: {
      limit: input.seatLimitOverride !== undefined ? input.seatLimitOverride : tier.seats,
      used: input.seatsUsed ?? 0,
    },
    overrides,
    pending: input.pending ?? [],
  }
}

/** Whether a module is held and usable. A pending module is neither. */
export function hasModule(record: EntitlementRecord, id: ModuleId): boolean {
  return record.modules.includes(id) && !record.pending.includes(id)
}

/** Held but still provisioning. The dashboard shows these differently: visible,
 *  labelled, and not yet clickable. */
export function isPending(record: EntitlementRecord, id: ModuleId): boolean {
  return record.pending.includes(id)
}

export function hasCapability(record: EntitlementRecord, id: CapabilityId): boolean {
  return record.capabilities.includes(id)
}

export function seatsRemaining(record: EntitlementRecord): number | null {
  if (record.seats.limit === null) return null
  return Math.max(0, record.seats.limit - record.seats.used)
}

export function canAddStaff(record: EntitlementRecord): boolean {
  const remaining = seatsRemaining(record)
  return remaining === null || remaining > 0
}

export interface UpgradePlan {
  readonly from: TierId
  readonly to: TierId
  /** Modules the upgrade adds, dependencies included. */
  readonly adds: ModuleId[]
  /** Of those, the ones that can be provisioned unattended and granted now. */
  readonly grantedImmediately: ModuleId[]
  /** Of those, the ones queued to a specialist. */
  readonly queuedToSpecialist: ModuleId[]
  readonly seatsBefore: number | null
  readonly seatsAfter: number | null
}

/**
 * What a self-serve tier change actually does.
 *
 * Both routes converge on the same Registry resolution and the same
 * provisioning saga; there is no separate self-serve code path. But they are
 * not interchangeable per module. When an upgrade pulls in a module that
 * cannot complete unattended, payment is taken, everything that provisioned
 * cleanly is granted, and the rest is queued with the tenant told what is
 * still coming. It never silently half-completes.
 */
export function planUpgrade(record: EntitlementRecord, to: TierId): UpgradePlan {
  const held = new Set(record.modules)
  const target = resolveDependencies(tierDefinition(to).grants)
  const adds = target.filter((id) => !held.has(id))
  const queued = requiresSpecialist(adds)
  const queuedSet = new Set(queued)

  return {
    from: record.tier,
    to,
    adds,
    grantedImmediately: adds.filter((id) => !queuedSet.has(id)),
    queuedToSpecialist: queued,
    seatsBefore: record.seats.limit,
    seatsAfter: tierDefinition(to).seats,
  }
}

/** Modules a downgrade would remove, so the merchant is warned before paying
 *  less and losing a screen they use every day. */
export function planDowngrade(record: EntitlementRecord, to: TierId): ModuleId[] {
  const target = new Set(resolveDependencies(tierDefinition(to).grants))
  return record.modules.filter((id) => !target.has(id))
}
