/**
 * The module catalog.
 *
 * A module is what a specialist provisions and what the gateway enforces. It is
 * not the unit of price: a tenant sits on a tier and the tier decides the set.
 *
 * Modules do not map one to one onto services. Selecting POS switches on one
 * service and pulls in three more, because an order needs something to price
 * it, something to decrement and something to charge it to.
 *
 * This mirrors system-architecture.html section 4. In production it is served
 * by the Module Registry; here it is the shape the client expects back.
 */

export const MODULE_IDS = [
  'identity_tenancy',
  'notifications',
  'audit_documents',
  'catalog',
  'inventory',
  'staff_rota',
  'payments',
  'pos_orders',
  'bookings',
  'website_storefront',
  'advanced_analytics',
  'marketing_ads',
  'ai_creative',
  'crm',
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

export type ModuleKind =
  /** Ships with every tenant. Never appears in a picker. */
  | 'always_on'
  /** Sold, and belongs to a tier. */
  | 'sold'
  /** Pulled in by something else. May also be sold on its own. */
  | 'dependency'

export interface ModuleDefinition {
  readonly id: ModuleId
  /** Trade-neutral by rule. If this names a trade, that is the bug. */
  readonly name: string
  /** What the merchant gets, in their words. */
  readonly summary: string
  readonly kind: ModuleKind
  /** Requires. Resolved transitively when a tier or an override is applied. */
  readonly requires: readonly ModuleId[]
  /** Services this switches on. Documentation, not behaviour. */
  readonly services: readonly string[]
  /**
   * Whether a self-serve upgrade can complete this module unattended.
   *
   * False means every provisioning step it triggers cannot finish without a
   * person: KYC approval, ad-account OAuth consent, hardware pairing. A
   * self-serve upgrade that pulls in a module marked false takes the payment,
   * grants everything that provisioned cleanly, and queues the rest to a
   * specialist with the tenant told what is still coming.
   */
  readonly selfServeCapable: boolean
  /** Lucide icon name. Resolved to a component in the UI package. */
  readonly icon: string
}

export const MODULES: Readonly<Record<ModuleId, ModuleDefinition>> = {
  identity_tenancy: {
    id: 'identity_tenancy',
    name: 'Identity and tenancy',
    summary: 'Accounts, staff logins, roles and the business profile.',
    kind: 'always_on',
    requires: [],
    services: ['Auth', 'RBAC', 'Tenant', 'Entitlement'],
    selfServeCapable: true,
    icon: 'ShieldCheck',
  },
  notifications: {
    id: 'notifications',
    name: 'Notifications',
    summary: 'Every outbound email and SMS, with your branding and quiet hours.',
    kind: 'always_on',
    requires: [],
    services: ['Notification'],
    selfServeCapable: true,
    icon: 'Bell',
  },
  audit_documents: {
    id: 'audit_documents',
    name: 'Audit and documents',
    summary: 'A plain-language record of every automated decision, and stored files.',
    kind: 'always_on',
    requires: [],
    services: ['Audit Log', 'Media & Document'],
    selfServeCapable: true,
    icon: 'FileClock',
  },
  catalog: {
    id: 'catalog',
    name: 'Catalog',
    summary: 'Whatever you sell, with prices and tax rules. One source of truth.',
    kind: 'dependency',
    requires: [],
    services: ['Product & Service Catalog'],
    selfServeCapable: true,
    icon: 'LayoutGrid',
  },
  inventory: {
    id: 'inventory',
    name: 'Inventory',
    summary: 'Live stock levels, reservations and low-stock alerts.',
    kind: 'dependency',
    requires: ['catalog'],
    services: ['Real-time Inventory'],
    selfServeCapable: true,
    icon: 'Boxes',
  },
  staff_rota: {
    id: 'staff_rota',
    name: 'Staff and rota',
    summary: 'Staff records, roles, shifts and per-person availability.',
    kind: 'sold',
    requires: [],
    services: ['Staff & Scheduling'],
    selfServeCapable: true,
    icon: 'Users',
  },
  payments: {
    id: 'payments',
    name: 'Payments',
    summary: 'Taking money, refunds, receipts and the books behind them.',
    kind: 'sold',
    requires: [],
    services: ['Payments', 'Invoice & Receipt', 'Ledger & Reconciliation'],
    // Connected-account KYC is an external approval on someone else's clock.
    selfServeCapable: false,
    icon: 'CreditCard',
  },
  pos_orders: {
    id: 'pos_orders',
    name: 'POS and orders',
    summary:
      'A till that registers a sale: cart, tender, discounts, voids, refunds, receipt and the day’s takings.',
    kind: 'sold',
    requires: ['catalog', 'inventory', 'payments'],
    services: ['POS & Orders'],
    selfServeCapable: true,
    icon: 'ScanLine',
  },
  bookings: {
    id: 'bookings',
    name: 'Bookings',
    summary: 'Calendar, deposits, no-show handling, buffers, and never double-booking a person.',
    kind: 'sold',
    requires: ['catalog', 'staff_rota', 'payments'],
    services: ['Bookings & Appointments'],
    selfServeCapable: true,
    icon: 'CalendarDays',
  },
  website_storefront: {
    id: 'website_storefront',
    name: 'Website and storefront',
    summary: 'A public site built from your trade’s template, with online ordering or booking.',
    kind: 'sold',
    requires: ['catalog'],
    services: ['Website Builder', 'Storefront BFF'],
    selfServeCapable: true,
    icon: 'Globe',
  },
  advanced_analytics: {
    id: 'advanced_analytics',
    name: 'Advanced analytics',
    summary: 'Revenue, occupancy and channel reporting beyond the basic dashboard.',
    kind: 'sold',
    requires: [],
    services: ['Reporting & Analytics API'],
    selfServeCapable: true,
    icon: 'ChartNoAxesCombined',
  },
  marketing_ads: {
    id: 'marketing_ads',
    name: 'Marketing and ads',
    summary: 'Ad spend reallocated every six hours against booked revenue, across your channels.',
    kind: 'sold',
    requires: ['advanced_analytics'],
    services: ['AI Marketing Engine', 'Ad Account Sync'],
    // Linking an ad account is an OAuth consent screen only the owner can pass.
    selfServeCapable: false,
    icon: 'Megaphone',
  },
  ai_creative: {
    id: 'ai_creative',
    name: 'AI creative',
    summary: 'Ad copy and imagery generated, and variants tested against performance.',
    kind: 'sold',
    requires: ['marketing_ads'],
    services: ['AI Creative Generation'],
    selfServeCapable: true,
    icon: 'Sparkles',
  },
  crm: {
    id: 'crm',
    name: 'CRM',
    summary: 'Contacts, pipeline, history and tasks, in your own workspace.',
    kind: 'sold',
    requires: [],
    services: ['Twenty CRM (forked)', 'CRM Sync'],
    selfServeCapable: true,
    icon: 'Contact',
  },
}

export function moduleDefinition(id: ModuleId): ModuleDefinition {
  return MODULES[id]
}

/**
 * Expands a selection to include everything it requires, transitively.
 *
 * This is what the Registry resolves when a specialist ticks a box, and what
 * the admin console shows them as "also required".
 */
export function resolveDependencies(selected: readonly ModuleId[]): ModuleId[] {
  const resolved = new Set<ModuleId>()
  const visit = (id: ModuleId) => {
    if (resolved.has(id)) return
    resolved.add(id)
    for (const required of MODULES[id].requires) visit(required)
  }
  for (const id of selected) visit(id)
  return MODULE_IDS.filter((id) => resolved.has(id))
}

/** What a selection pulled in that the caller did not ask for. */
export function autoEnabledBy(selected: readonly ModuleId[]): ModuleId[] {
  const asked = new Set(selected)
  return resolveDependencies(selected).filter((id) => !asked.has(id))
}

/** Modules that would break if this one were switched off. */
export function dependentsOf(id: ModuleId): ModuleId[] {
  return MODULE_IDS.filter((candidate) => MODULES[candidate].requires.includes(id))
}

/** Modules in a set that cannot finish a self-serve upgrade on their own. */
export function requiresSpecialist(modules: readonly ModuleId[]): ModuleId[] {
  return modules.filter((id) => !MODULES[id].selfServeCapable)
}
