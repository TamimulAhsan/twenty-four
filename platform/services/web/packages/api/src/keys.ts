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
  },

  billing: {
    subscription: () => ['billing', 'subscription'] as const,
  },
} as const
