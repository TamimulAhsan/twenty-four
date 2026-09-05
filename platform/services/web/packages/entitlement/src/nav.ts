/**
 * Navigation, derived from the entitlement record.
 *
 * Three surfaces, not one. The back-office dashboard is a desk tool: wide
 * tables, reporting, configuration, long sessions. The till is a counter tool:
 * full screen on a tablet, one task, touched all day. The calendar is a third
 * thing again. Putting all three behind one sidebar means every one of them is
 * compromised for the other two, so POS and Bookings are separate applications
 * and the dashboard launches them into their own tab.
 *
 * Entitlement still governs all three. A launcher for a module the tenant does
 * not hold is simply absent, and the application behind it refuses the call at
 * the gateway regardless of what the dashboard rendered.
 *
 * Routes stay semantic. A term may change what an item is called ("Menu"
 * rather than "Catalog") but never where it points.
 */
import type { CapabilityId } from './profiles'
import type { ModuleId } from './modules'
import { hasModule, isPending, type EntitlementRecord } from './resolve'

export type NavLabel =
  | { readonly kind: 'term'; readonly key: string; readonly plural?: boolean }
  | { readonly kind: 'static'; readonly text: string }

export interface NavItem {
  readonly id: string
  readonly label: NavLabel
  /** The unabbreviated name, where there is room to show it. */
  readonly fullName?: string
  readonly icon: string
  /** Internal route within the current application. */
  readonly to?: string
  /** Opens in its own tab. Set for the POS and Bookings applications and for
   *  the CRM, which is a separate deployment on its own subdomain. */
  readonly launch?: string
  /** A one-line description, shown on launcher cards. */
  readonly summary?: string
  /** Held but still provisioning: shown, labelled, and not yet usable. */
  readonly pending?: boolean
}

export interface NavGroup {
  readonly id: string
  readonly label?: string
  readonly items: readonly NavItem[]
}

/**
 * Where the other two applications live.
 *
 * Injected rather than hardcoded: in development they are separate dev servers
 * on their own ports, and in production they are separate bundles served by
 * the frontend pod under their own paths.
 */
export interface LaunchTargets {
  readonly pos: string
  readonly bookings: string
  readonly crm: string
}

// Trailing slashes on purpose. Each of these is a separate application served
// from its own pod under that prefix; without the slash the server answers with
// a directory redirect and the browser pays an extra round trip to learn what
// we already knew.
export const DEFAULT_LAUNCH_TARGETS: LaunchTargets = {
  pos: '/pos/',
  bookings: '/bookings/',
  crm: '/crm/',
}

interface NavSpec extends Omit<NavItem, 'pending' | 'launch'> {
  readonly module?: ModuleId
  readonly capability?: CapabilityId
  readonly launchKey?: keyof LaunchTargets
  readonly always?: boolean
}

const SPEC: ReadonlyArray<{ id: string; label?: string; items: readonly NavSpec[] }> = [
  {
    id: 'insight',
    items: [
      {
        id: 'overview',
        to: '/',
        label: { kind: 'static', text: 'Overview' },
        icon: 'LayoutDashboard',
        always: true,
      },
    ],
  },
  {
    id: 'analyse',
    label: 'Understand',
    items: [
      {
        id: 'financials',
        to: '/financials',
        label: { kind: 'static', text: 'Financials' },
        icon: 'ChartNoAxesCombined',
        module: 'payments',
      },
      {
        // Named by the term set, because "which dishes earn" and "which rooms
        // earn" are the same screen asked in two vocabularies.
        id: 'products',
        to: '/products',
        label: { kind: 'term', key: 'catalog_item', plural: true },
        icon: 'Package',
        module: 'advanced_analytics',
      },
      {
        id: 'customers',
        to: '/customers',
        label: { kind: 'term', key: 'customer', plural: true },
        icon: 'Contact',
        module: 'advanced_analytics',
      },
    ],
  },
  {
    id: 'apps',
    label: 'Applications',
    items: [
      {
        id: 'pos',
        launchKey: 'pos',
        label: { kind: 'static', text: 'Point of sale' },
        summary: 'Register a sale, take payment, close the day.',
        icon: 'ScanLine',
        module: 'pos_orders',
      },
      {
        id: 'bookings',
        launchKey: 'bookings',
        label: { kind: 'static', text: 'Bookings' },
        /* The full name lives here and on the launcher card, where there is
         * room for it. A sidebar row that truncates reads as a defect. */
        summary: 'Calendar, availability, deposits and no-shows.',
        fullName: 'Bookings and appointments',
        icon: 'CalendarDays',
        module: 'bookings',
      },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      {
        id: 'inventory',
        to: '/inventory',
        label: { kind: 'static', text: 'Inventory' },
        icon: 'Boxes',
        module: 'inventory',
      },
      {
        id: 'orders',
        to: '/orders',
        label: { kind: 'term', key: 'order', plural: true },
        icon: 'ReceiptText',
        module: 'pos_orders',
      },
      {
        // Deliberately not the trade term. This screen manages accounts and
        // roles, and its rows include owners, managers and bookkeepers. A
        // salon's account list is not a list of stylists.
        id: 'staff',
        to: '/staff',
        label: { kind: 'static', text: 'Team' },
        icon: 'Users',
        module: 'staff_rota',
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      {
        id: 'payments',
        to: '/payments',
        label: { kind: 'static', text: 'Payments' },
        icon: 'CreditCard',
        module: 'payments',
      },
      {
        id: 'documents',
        to: '/documents',
        label: { kind: 'static', text: 'Invoices and receipts' },
        icon: 'FileText',
        module: 'payments',
      },
      {
        id: 'payouts',
        to: '/payouts',
        label: { kind: 'static', text: 'Payouts' },
        icon: 'Wallet',
        module: 'payments',
      },
    ],
  },
  {
    id: 'grow',
    label: 'Grow',
    items: [
      {
        id: 'discounts',
        to: '/discounts',
        label: { kind: 'static', text: 'Coupons and discounts' },
        icon: 'Percent',
        module: 'catalog',
      },
      {
        id: 'loyalty',
        to: '/loyalty',
        label: { kind: 'static', text: 'Loyalty' },
        icon: 'Sparkles',
        module: 'catalog',
      },
      {
        id: 'marketing',
        to: '/marketing',
        label: { kind: 'static', text: 'Marketing and ads' },
        icon: 'Megaphone',
        module: 'marketing_ads',
      },
      {
        id: 'creative',
        to: '/creative',
        label: { kind: 'static', text: 'Creative' },
        icon: 'Sparkles',
        module: 'ai_creative',
      },
      {
        id: 'site',
        to: '/site',
        label: { kind: 'static', text: 'Website' },
        icon: 'Globe',
        module: 'website_storefront',
      },
      {
        id: 'crm',
        launchKey: 'crm',
        label: { kind: 'static', text: 'CRM' },
        summary: 'Contacts, pipeline and history in your own workspace.',
        icon: 'ExternalLink',
        module: 'crm',
      },
    ],
  },
]

export const FOOTER_NAV: readonly NavItem[] = [
  {
    id: 'subscription',
    to: '/subscription',
    label: { kind: 'static', text: 'Subscription' },
    icon: 'Wallet',
  },
  { id: 'settings', to: '/settings', label: { kind: 'static', text: 'Settings' }, icon: 'Settings' },
]

export function buildNav(
  record: EntitlementRecord,
  targets: LaunchTargets = DEFAULT_LAUNCH_TARGETS,
): NavGroup[] {
  const groups: NavGroup[] = []

  for (const group of SPEC) {
    const items: NavItem[] = []
    for (const spec of group.items) {
      if (!spec.always && spec.module) {
        if (!hasModule(record, spec.module) && !isPending(record, spec.module)) continue
      }
      const pending = spec.module ? isPending(record, spec.module) : false
      const { module: _module, capability: _capability, launchKey, always: _always, ...rest } = spec
      items.push({
        ...rest,
        ...(launchKey ? { launch: targets[launchKey] } : {}),
        ...(pending ? { pending: true } : {}),
      })
    }
    if (items.length > 0) {
      groups.push(
        group.label ? { id: group.id, label: group.label, items } : { id: group.id, items },
      )
    }
  }

  return groups
}

/** The launcher entries on their own, for the overview page's app cards. */
export function launchableApps(
  record: EntitlementRecord,
  targets: LaunchTargets = DEFAULT_LAUNCH_TARGETS,
): NavItem[] {
  return buildNav(record, targets)
    .flatMap((group) => group.items)
    .filter((item) => item.launch !== undefined)
}

/** Every route the dashboard nav can point at, for the vocabulary guard test. */
export function allNavRoutes(): string[] {
  return [
    ...SPEC.flatMap((group) => group.items.flatMap((item) => (item.to ? [item.to] : []))),
    ...FOOTER_NAV.flatMap((item) => (item.to ? [item.to] : [])),
  ]
}
