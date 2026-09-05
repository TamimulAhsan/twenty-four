export {
  MODULE_IDS,
  MODULES,
  moduleDefinition,
  resolveDependencies,
  autoEnabledBy,
  dependentsOf,
  requiresSpecialist,
  type ModuleId,
  type ModuleKind,
  type ModuleDefinition,
} from './modules'

export {
  TIER_IDS,
  TIERS,
  ANNUAL_DISCOUNT_PERCENT,
  tierDefinition,
  tierModules,
  tierAutoEnabled,
  tierRank,
  isUpgrade,
  annualMonthlyMinor,
  type TierId,
  type TierDefinition,
  type TierPerk,
} from './tiers'

export {
  CAPABILITY_IDS,
  CAPABILITIES,
  INDUSTRY_PROFILES,
  FAMILY_LABELS,
  industryProfile,
  profileCapabilities,
  profilesByFamily,
  searchProfiles,
  type CapabilityId,
  type CapabilityDefinition,
  type IndustryProfile,
  type TermFamily,
} from './profiles'

export {
  resolveEntitlement,
  hasModule,
  isPending,
  hasCapability,
  seatsRemaining,
  canAddStaff,
  planUpgrade,
  planDowngrade,
  type EntitlementRecord,
  type EntitlementOverride,
  type SeatQuota,
  type ResolveEntitlementInput,
  type UpgradePlan,
} from './resolve'

export {
  buildNav,
  launchableApps,
  allNavRoutes,
  FOOTER_NAV,
  DEFAULT_LAUNCH_TARGETS,
  type NavGroup,
  type NavItem,
  type NavLabel,
  type LaunchTargets,
} from './nav'

export {
  EntitlementProvider,
  useEntitlement,
  useModule,
  useCapability,
  ModuleGate,
  type EntitlementContextValue,
} from './react'
