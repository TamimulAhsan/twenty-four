/**
 * Query keys.
 *
 * Semantic, like every other identifier in the product. A key named for a
 * trade would put that trade's vocabulary into the cache, and renaming a term
 * would then invalidate the wrong things.
 */
export const queryKeys = {
  bootstrap: () => ['bootstrap'] as const,
  onboarding: () => ['onboarding'] as const,

  catalog: {
    items: (filters?: Record<string, unknown>) => ['catalog', 'items', filters ?? {}] as const,
    item: (id: string) => ['catalog', 'item', id] as const,
    categories: () => ['catalog', 'categories'] as const,
  },

  orders: {
    list: (filters?: Record<string, unknown>) => ['orders', 'list', filters ?? {}] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
    takings: (date: string) => ['orders', 'takings', date] as const,
    parked: () => ['orders', 'parked'] as const,
    dayClose: (date: string) => ['orders', 'day-close', date] as const,
  },

  bookings: {
    range: (from: string, to: string) => ['bookings', 'range', from, to] as const,
    detail: (id: string) => ['bookings', 'detail', id] as const,
    // The date is part of the key, and so is the resource: asking about
    // Tuesday for anybody is a different question from asking about Tuesday
    // for one chair, not the same one refetched.
    availability: (itemId: string, date: string, resourceId?: string) =>
      ['bookings', 'availability', itemId, date, resourceId ?? ''] as const,
    resources: () => ['bookings', 'resources'] as const,
  },

  // One key per question, and the period is part of it. Two screens asking for
  // the same window share an answer; changing the window is a different
  // question rather than the same one refetched.
  media: {
    list: (filters?: Record<string, unknown>) => ['media', 'list', filters ?? {}] as const,
    // The signed URL is keyed separately and never cached long: it expires, and
    // a stale one renders as a broken image rather than as an error.
    url: (id: string) => ['media', 'url', id] as const,
  },

  audit: {
    list: (filters?: Record<string, unknown>) => ['audit', 'list', filters ?? {}] as const,
    trail: (subjectType: string, subjectId: string) =>
      ['audit', 'trail', subjectType, subjectId] as const,
  },

  support: {
    requests: () => ['support', 'requests'] as const,
    sessions: () => ['support', 'sessions'] as const,
  },

  ledger: {
    accounts: () => ['ledger', 'accounts'] as const,
    trialBalance: (from?: string, to?: string) => ['ledger', 'trial-balance', from, to] as const,
    entries: (filters?: Record<string, unknown>) => ['ledger', 'entries', filters ?? {}] as const,
    account: (code: string, from?: string, to?: string) =>
      ['ledger', 'account', code, from, to] as const,
  },

  kitchen: {
    // The station is part of the key: the grill's rail and the pass's rail are
    // different questions, not the same one refetched.
    tickets: (stationId?: string) => ['kitchen', 'tickets', stationId ?? ''] as const,
    stations: () => ['kitchen', 'stations'] as const,
  },

  analytics: {
    summary: (from: string, to: string) => ['analytics', 'summary', from, to] as const,
    series: (from: string, to: string) => ['analytics', 'series', from, to] as const,
    breakdown: (from: string, to: string, by: string) =>
      ['analytics', 'breakdown', from, to, by] as const,
    heatmap: (from: string, to: string) => ['analytics', 'heatmap', from, to] as const,
  },

  inventory: {
    levels: () => ['inventory', 'levels'] as const,
  },

  tables: {
    list: () => ['tables', 'list'] as const,
  },

  customers: {
    list: (filters?: Record<string, unknown>) => ['customers', 'list', filters ?? {}] as const,
    detail: (id: string) => ['customers', 'detail', id] as const,
  },

  discounts: {
    list: () => ['discounts', 'list'] as const,
  },

  loyalty: {
    programme: () => ['loyalty', 'programme'] as const,
    members: () => ['loyalty', 'members'] as const,
  },

  staff: {
    list: () => ['staff', 'list'] as const,
  },

  roles: {
    list: () => ['roles', 'list'] as const,
  },

  settings: {
    notifications: () => ['settings', 'notifications'] as const,
  },

  payments: {
    list: (filters?: Record<string, unknown>) => ['payments', 'list', filters ?? {}] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },

  documents: {
    list: (filters?: Record<string, unknown>) => ['documents', 'list', filters ?? {}] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    // An issued document never changes, so this one never goes stale.
    artifact: (id: string) => ['documents', 'artifact', id] as const,
  },

  billing: {
    subscription: () => ['billing', 'subscription'] as const,
  },
} as const

/**
 * Admin plane keys.
 *
 * A separate tree, prefixed, so nothing an admin screen caches can ever be
 * served to a merchant screen or the other way round. The two planes run in
 * different applications on different hosts, so this can only happen by
 * mistake, and a shared prefix is how that mistake would look.
 */
export const adminKeys = {
  session: () => ['admin', 'session'] as const,
  overview: () => ['admin', 'overview'] as const,
  environment: () => ['admin', 'environment'] as const,
  billing: () => ['admin', 'billing'] as const,
  tiers: () => ['admin', 'tiers'] as const,
  staff: () => ['admin', 'staff'] as const,
  roles: () => ['admin', 'roles'] as const,
  audit: (filter?: string) => ['admin', 'audit', filter ?? 'all'] as const,
  sessions: () => ['admin', 'support-sessions'] as const,
  provisioning: {
    queue: () => ['admin', 'provisioning'] as const,
    run: (tenantId: string) => ['admin', 'provisioning', tenantId] as const,
  },
  tenants: {
    list: () => ['admin', 'tenants'] as const,
    detail: (id: string) => ['admin', 'tenants', id] as const,
    orders: (id: string) => ['admin', 'tenants', id, 'orders'] as const,
    invoices: (id: string) => ['admin', 'tenants', id, 'invoices'] as const,
    audit: (id: string) => ['admin', 'tenants', id, 'audit'] as const,
  },
} as const
