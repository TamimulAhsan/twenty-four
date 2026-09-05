/**
 * What a person may do.
 *
 * Distinct from entitlement, which is what the tenant bought. The two are
 * evaluated together at the gateway and neither substitutes for the other: a
 * tenant on Starter has no Marketing permissions to grant because they have no
 * Marketing module, and an owner of a Max tenant still cannot refund a payment
 * on a tenant they do not belong to.
 *
 * Mirrors the RBAC & Permissions service in system-architecture.html section 3.
 * Everything here is presentation and client-side convenience; the gateway
 * evaluates the same policy and is the control that matters.
 */
import type { ModuleId } from '@twentyfour/entitlement'

export const PERMISSION_IDS = [
  'catalog.view',
  'catalog.edit',
  'pos.sell',
  'pos.discount',
  'pos.void',
  'pos.refund',
  'pos.close_day',
  'bookings.view',
  'bookings.manage',
  'bookings.cancel',
  'inventory.view',
  'inventory.adjust',
  'staff.view',
  'staff.manage',
  'staff.roles',
  'payments.view',
  'payments.refund',
  'documents.view',
  'documents.correct',
  'reports.operational',
  'reports.financial',
  'marketing.view',
  'marketing.manage',
  'settings.business',
  'settings.tax',
  'settings.billing',
] as const

export type PermissionId = (typeof PERMISSION_IDS)[number]

export type PermissionGroup =
  | 'selling'
  | 'calendar'
  | 'stock'
  | 'people'
  | 'money'
  | 'insight'
  | 'configuration'

export interface PermissionDefinition {
  readonly id: PermissionId
  /** Written as an action a person takes, not as a resource they hold. */
  readonly name: string
  readonly description: string
  readonly group: PermissionGroup
  /**
   * The module that must be entitled for this permission to exist at all.
   * Undefined means it is always available, because the module behind it
   * ships with every tenant.
   */
  readonly module?: ModuleId
  /**
   * Touches money, fiscal documents or the ability to grant access.
   * Surfaced differently, because these are the ones a merchant should think
   * about before handing out rather than tick through.
   */
  readonly sensitive?: boolean
}

export const PERMISSIONS: Readonly<Record<PermissionId, PermissionDefinition>> = {
  'catalog.view': {
    id: 'catalog.view',
    name: 'See prices and items',
    description: 'Read the catalog, including cost and tax settings.',
    group: 'selling',
    module: 'catalog',
  },
  'catalog.edit': {
    id: 'catalog.edit',
    name: 'Change prices and items',
    description: 'Add, edit and archive items, and set tax treatment.',
    group: 'selling',
    module: 'catalog',
    sensitive: true,
  },
  'pos.sell': {
    id: 'pos.sell',
    name: 'Register a sale',
    description: 'Use the till and take payment.',
    group: 'selling',
    module: 'pos_orders',
  },
  'pos.discount': {
    id: 'pos.discount',
    name: 'Apply a discount',
    description: 'Reduce a line or a whole sale at the till.',
    group: 'selling',
    module: 'pos_orders',
    sensitive: true,
  },
  'pos.void': {
    id: 'pos.void',
    name: 'Void a sale',
    description: 'Cancel a registered sale and return the stock.',
    group: 'selling',
    module: 'pos_orders',
    sensitive: true,
  },
  'pos.refund': {
    id: 'pos.refund',
    name: 'Refund a sale',
    description: 'Return money to a customer and issue a correcting document.',
    group: 'selling',
    module: 'pos_orders',
    sensitive: true,
  },
  'pos.close_day': {
    id: 'pos.close_day',
    name: 'Close the day',
    description: 'Run the day report and reconcile the drawer.',
    group: 'selling',
    module: 'pos_orders',
  },
  'bookings.view': {
    id: 'bookings.view',
    name: 'See the calendar',
    description: 'Read every booking, not only their own.',
    group: 'calendar',
    module: 'bookings',
  },
  'bookings.manage': {
    id: 'bookings.manage',
    name: 'Take and move bookings',
    description: 'Create, reschedule and reassign.',
    group: 'calendar',
    module: 'bookings',
  },
  'bookings.cancel': {
    id: 'bookings.cancel',
    name: 'Cancel and mark no-shows',
    description: 'Which is what deposit rules and reporting hang off.',
    group: 'calendar',
    module: 'bookings',
    sensitive: true,
  },
  'inventory.view': {
    id: 'inventory.view',
    name: 'See stock levels',
    description: 'Read counts and low-stock warnings.',
    group: 'stock',
    module: 'inventory',
  },
  'inventory.adjust': {
    id: 'inventory.adjust',
    name: 'Adjust stock',
    description: 'Record deliveries, waste and count corrections.',
    group: 'stock',
    module: 'inventory',
    sensitive: true,
  },
  'staff.view': {
    id: 'staff.view',
    name: 'See the team',
    description: 'Read who has an account and what they can do.',
    group: 'people',
  },
  'staff.manage': {
    id: 'staff.manage',
    name: 'Invite and remove people',
    description: 'Add accounts, deactivate them, and use seats.',
    group: 'people',
    sensitive: true,
  },
  'staff.roles': {
    id: 'staff.roles',
    name: 'Change what people can do',
    description: 'Assign roles. Anyone with this can grant themselves anything.',
    group: 'people',
    sensitive: true,
  },
  'payments.view': {
    id: 'payments.view',
    name: 'See payments',
    description: 'Read transactions, their status and their references.',
    group: 'money',
    module: 'payments',
  },
  'payments.refund': {
    id: 'payments.refund',
    name: 'Refund a payment',
    description: 'Return money outside the till.',
    group: 'money',
    module: 'payments',
    sensitive: true,
  },
  'documents.view': {
    id: 'documents.view',
    name: 'See invoices and receipts',
    description: 'Read issued documents and their reporting state.',
    group: 'money',
    module: 'payments',
  },
  'documents.correct': {
    id: 'documents.correct',
    name: 'Issue a correction',
    description: 'Raise a credit note against an issued document.',
    group: 'money',
    module: 'payments',
    sensitive: true,
  },
  'reports.operational': {
    id: 'reports.operational',
    name: 'See operational reporting',
    description: 'Takings, busiest hours, what sells.',
    group: 'insight',
  },
  'reports.financial': {
    id: 'reports.financial',
    name: 'See financial reporting',
    description: 'Margin, tax position and payouts.',
    group: 'insight',
    sensitive: true,
  },
  'marketing.view': {
    id: 'marketing.view',
    name: 'See campaigns',
    description: 'Read spend, reach and results.',
    group: 'insight',
    module: 'marketing_ads',
  },
  'marketing.manage': {
    id: 'marketing.manage',
    name: 'Change campaigns and budget',
    description: 'Set budgets and approve creative.',
    group: 'insight',
    module: 'marketing_ads',
    sensitive: true,
  },
  'settings.business': {
    id: 'settings.business',
    name: 'Change business details',
    description: 'Name, opening hours, branding and notifications.',
    group: 'configuration',
  },
  'settings.tax': {
    id: 'settings.tax',
    name: 'Change tax settings',
    description: 'Rates and categories. Wrong here means wrong on every receipt.',
    group: 'configuration',
    sensitive: true,
  },
  'settings.billing': {
    id: 'settings.billing',
    name: 'Change the plan and payment method',
    description: 'Upgrade, downgrade and pay the subscription.',
    group: 'configuration',
    sensitive: true,
  },
}

export const GROUP_LABELS: Readonly<Record<PermissionGroup, string>> = {
  selling: 'Selling',
  calendar: 'Calendar',
  stock: 'Stock',
  people: 'People',
  money: 'Money',
  insight: 'Insight',
  configuration: 'Configuration',
}

export const GROUP_ORDER: readonly PermissionGroup[] = [
  'selling',
  'calendar',
  'stock',
  'money',
  'insight',
  'people',
  'configuration',
]

export function permissionDefinition(id: PermissionId): PermissionDefinition {
  return PERMISSIONS[id]
}
