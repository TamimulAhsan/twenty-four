/**
 * MSW handlers for the Merchant BFF.
 *
 * Real HTTP, intercepted at the network layer, so components use the same
 * fetch path they will use against the gateway. Nothing in the app knows this
 * exists; connecting the real backend is deleting the worker registration.
 */
import { http, HttpResponse, type HttpHandler } from 'msw'
import { money } from '@twentyfour/money'
import { MockError, availableTenants, resetStore, storeFor } from './store'
import { currentTenantId, isSignedIn, setCurrentTenantId, setSignedIn } from './session'
import { wire } from './wire'
import { buildOnboarding } from './onboarding'

const LATENCY_MS = 180

const delay = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS))

function ok(body: unknown, status = 200): Response {
  return HttpResponse.json(wire(body) as object, {
    status,
    headers: { 'X-Request-Id': `mock-${Math.random().toString(36).slice(2, 10)}` },
  })
}

function fail(error: unknown): Response {
  if (error instanceof MockError) {
    return HttpResponse.json(
      { code: error.code, message: error.message },
      { status: error.status },
    )
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.'
  return HttpResponse.json({ code: 'internal', message }, { status: 500 })
}

const store = () => storeFor(currentTenantId())

function requireSession(): void {
  if (!isSignedIn()) {
    throw new MockError(401, 'unauthenticated', 'Sign in to continue.')
  }
}

/** Rejects a call to a module the tenant does not hold, the way the gateway
 *  does. Without this the app can drift into relying on its own gates. */
function requireModule(moduleId: string): void {
  requireSession()
  const current = store()
  if (!current.entitlement.modules.includes(moduleId as never)) {
    throw new MockError(403, 'not_entitled', 'Your plan does not include this.')
  }
}

async function handle(work: () => unknown): Promise<Response> {
  await delay()
  try {
    return ok(work())
  } catch (error) {
    return fail(error)
  }
}

export const handlers: HttpHandler[] = [
  /* --------------------------------------------------------------- session */

  http.get('/api/auth/session', async () => {
    await delay()
    return isSignedIn() ? ok(store().session) : ok(null)
  }),

  http.post('/api/auth/login', async ({ request }) => {
    await delay()
    const body = (await request.json()) as { email?: string; password?: string }
    if (!body.email || !body.password) {
      return fail(new MockError(422, 'invalid_credentials', 'Enter your email and password.'))
    }
    // Any password is accepted except this one, which is here so the error
    // path can be built and looked at rather than assumed.
    if (body.password === 'wrong') {
      return fail(new MockError(401, 'invalid_credentials', 'That email and password do not match.'))
    }
    const matched = availableTenants().find(
      (tenant) => storeFor(tenant.id).session.email === body.email,
    )
    if (matched) setCurrentTenantId(matched.id)
    setSignedIn(true)
    return ok(store().session)
  }),

  http.post('/api/auth/signup', async ({ request }) => {
    await delay()
    const body = (await request.json()) as { industry?: string }
    // A fresh signup starts on the fixture whose trade matches, so the
    // onboarding run ends somewhere that looks like the business described.
    const industry = body.industry ?? ''
    const target = ['restaurant', 'cafe', 'bakery', 'pizzeria', 'bar_pub', 'food_truck', 'catering'].includes(industry)
      ? 'cafe'
      : ['hair_salon', 'barbershop', 'nail_salon', 'beauty_salon', 'spa', 'massage'].includes(industry)
        ? 'salon'
        : 'shop'
    setCurrentTenantId(target)
    resetStore(target)
    storeFor(target).onboarding = buildOnboarding()
    setSignedIn(true)
    return ok(storeFor(target).session)
  }),

  http.post('/api/auth/logout', async () => {
    await delay()
    setSignedIn(false)
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('/api/auth/password-reset', async () => {
    await delay()
    return new HttpResponse(null, { status: 204 })
  }),

  /* ------------------------------------------------------------- bootstrap */

  http.get('/api/bootstrap', async () =>
    handle(() => {
      requireSession()
      const current = store()
      return {
        session: current.session,
        profile: current.profile,
        entitlement: current.entitlement,
        termOverrides: current.termOverrides,
        onboarding: current.onboarding,
      }
    }),
  ),

  http.get('/api/onboarding', async () =>
    handle(() => {
      requireSession()
      return store().onboarding ?? buildOnboarding()
    }),
  ),

  http.post('/api/onboarding/steps/:stepId/retry', async ({ params }) =>
    handle(() => {
      requireSession()
      const current = store()
      const state = current.onboarding
      if (!state) throw new MockError(404, 'not_found', 'Nothing to retry.')
      current.onboarding = {
        ...state,
        steps: state.steps.map((step) =>
          step.id === params['stepId'] ? { ...step, status: 'in_progress' as const } : step,
        ),
      }
      return current.onboarding
    }),
  ),

  /* --------------------------------------------------------------- catalog */

  http.get('/api/catalog/items', async ({ request }) =>
    handle(() => {
      requireModule('catalog')
      const url = new URL(request.url)
      return store().listItems({
        kind: url.searchParams.get('kind') ?? undefined,
        categoryId: url.searchParams.get('categoryId') ?? undefined,
        search: url.searchParams.get('search') ?? undefined,
        includeInactive: url.searchParams.get('includeInactive') === 'true',
      })
    }),
  ),

  http.get('/api/catalog/categories', async () =>
    handle(() => {
      requireModule('catalog')
      return store().categories
    }),
  ),

  http.get('/api/catalog/items/:id', async ({ params }) =>
    handle(() => {
      requireModule('catalog')
      return store().getItem(String(params['id']))
    }),
  ),

  http.post('/api/catalog/items', async ({ request }) => {
    await delay()
    try {
      requireModule('catalog')
      return ok(store().createItem((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/catalog/items/:id', async ({ request, params }) => {
    await delay()
    try {
      requireModule('catalog')
      return ok(store().updateItem(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.delete('/api/catalog/items/:id', async ({ params }) => {
    await delay()
    try {
      requireModule('catalog')
      store().archiveItem(String(params['id']))
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),

  /* ---------------------------------------------------------------- orders */

  http.get('/api/orders/takings', async ({ request }) =>
    handle(() => {
      requireModule('pos_orders')
      const url = new URL(request.url)
      return store().takings(url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10))
    }),
  ),

  /* Registered before /api/orders/:id on purpose: MSW matches in order, and
     the parameterised route would otherwise swallow every one of these and
     hand the store the literal string "parked" as an id. */

  http.get('/api/orders/parked', async () =>
    handle(() => {
      requireModule('pos_orders')
      return store().listParkedOrders()
    }),
  ),

  http.post('/api/orders/parked', async ({ request }) => {
    await delay()
    try {
      requireModule('pos_orders')
      return ok(store().parkOrder((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/orders/parked/:id', async ({ request, params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      return ok(
        store().updateParkedOrder(String(params['id']), (await request.json()) as never),
      )
    } catch (error) {
      return fail(error)
    }
  }),

  http.delete('/api/orders/parked/:id', async ({ params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      store().discardParkedOrder(String(params['id']))
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),

  http.post('/api/orders/parked/:id/settle', async ({ request, params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      const body = (await request.json()) as { tenders?: never[] }
      return ok(store().settleParkedOrder(String(params['id']), body.tenders ?? []))
    } catch (error) {
      return fail(error)
    }
  }),

  http.get('/api/orders/day-close', async ({ request }) =>
    handle(() => {
      requireModule('pos_orders')
      const url = new URL(request.url)
      return store().dayClose(
        url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10),
      )
    }),
  ),

  http.post('/api/orders/day-close', async ({ request }) => {
    await delay()
    try {
      requireModule('pos_orders')
      const body = (await request.json()) as {
        date: string
        openingFloat: { minor: string; currency: string }
        countedCash: { minor: string; currency: string }
        note?: string
      }
      return ok(
        store().closeDay({
          date: body.date,
          openingFloat: money(Number(body.openingFloat.minor), body.openingFloat.currency),
          countedCash: money(Number(body.countedCash.minor), body.countedCash.currency),
          ...(body.note !== undefined ? { note: body.note } : {}),
        }),
      )
    } catch (error) {
      return fail(error)
    }
  }),

  http.get('/api/orders', async ({ request }) =>
    handle(() => {
      requireModule('pos_orders')
      const url = new URL(request.url)
      return store().listOrders({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
      })
    }),
  ),

  http.get('/api/orders/:id', async ({ params }) =>
    handle(() => {
      requireModule('pos_orders')
      return store().getOrder(String(params['id']))
    }),
  ),

  http.post('/api/orders', async ({ request }) => {
    await delay()
    try {
      requireModule('pos_orders')
      return ok(store().placeOrder((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.post('/api/orders/:id/void', async ({ request, params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      const body = (await request.json()) as { reason?: string }
      return ok(store().voidOrder(String(params['id']), body.reason ?? ''))
    } catch (error) {
      return fail(error)
    }
  }),

  http.post('/api/orders/:id/refund', async ({ request, params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      const body = (await request.json()) as { lineIds?: string[] }
      return ok(store().refundOrder(String(params['id']), body.lineIds))
    } catch (error) {
      return fail(error)
    }
  }),

  /* -------------------------------------------------------------- bookings */

  http.get('/api/bookings', async ({ request }) =>
    handle(() => {
      requireModule('bookings')
      const url = new URL(request.url)
      const today = new Date().toISOString().slice(0, 10)
      return store().listBookings(
        url.searchParams.get('from') ?? today,
        url.searchParams.get('to') ?? today,
      )
    }),
  ),

  http.post('/api/bookings', async ({ request }) => {
    await delay()
    try {
      requireModule('bookings')
      return ok(store().createBooking((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/bookings/:id', async ({ request, params }) => {
    await delay()
    try {
      requireModule('bookings')
      return ok(store().updateBooking(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  /* ------------------------------------------------------------- inventory */

  http.get('/api/inventory/levels', async () =>
    handle(() => {
      requireModule('inventory')
      return store().stockLevels()
    }),
  ),

  http.post('/api/inventory/adjustments', async ({ request }) => {
    await delay()
    try {
      requireModule('inventory')
      const body = (await request.json()) as { itemId: string; delta: number; reason: string }
      return ok(store().adjustStock(body.itemId, body.delta, body.reason))
    } catch (error) {
      return fail(error)
    }
  }),

  /* ------------------------------------------------------------- customers */

  http.get('/api/customers', async ({ request }) =>
    handle(() => {
      requireSession()
      const url = new URL(request.url)
      return store().listCustomers({ search: url.searchParams.get('search') ?? undefined })
    }),
  ),

  http.get('/api/customers/:id', async ({ params }) =>
    handle(() => {
      requireSession()
      return store().getCustomer(String(params['id']))
    }),
  ),

  http.patch('/api/customers/:id', async ({ request, params }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateCustomer(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  /* ------------------------------------------------------------- discounts */

  http.get('/api/discounts', async () =>
    handle(() => {
      requireSession()
      return store().discounts
    }),
  ),

  http.post('/api/discounts', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().createDiscount((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/discounts/:id', async ({ request, params }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateDiscount(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  /* --------------------------------------------------------------- loyalty */

  http.get('/api/loyalty/programme', async () =>
    handle(() => {
      requireSession()
      return store().loyaltyProgramme
    }),
  ),

  http.patch('/api/loyalty/programme', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateLoyaltyProgramme((await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.get('/api/loyalty/members', async () =>
    handle(() => {
      requireSession()
      return store().loyaltyMembers
    }),
  ),

  /* ---------------------------------------------------------------- tables */

  http.get('/api/tables', async () =>
    handle(() => {
      requireModule('pos_orders')
      return store().listTables()
    }),
  ),

  http.patch('/api/tables/:id', async ({ request, params }) => {
    await delay()
    try {
      requireModule('pos_orders')
      return ok(store().updateTable(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  /* -------------------------------------------------------------- settings */

  http.patch('/api/settings/profile', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateProfile((await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/settings/terms', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateTerms((await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.get('/api/settings/notifications', async () =>
    handle(() => {
      requireSession()
      return store().notifications
    }),
  ),

  http.patch('/api/settings/notifications', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateNotifications((await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  /* ----------------------------------------------------------------- roles */

  http.get('/api/roles', async () => handle(() => { requireSession(); return store().listRoles() })),

  http.post('/api/roles', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().createRole((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/roles/:id', async ({ request, params }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateRole(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.delete('/api/roles/:id', async ({ params }) => {
    await delay()
    try {
      requireSession()
      store().removeRole(String(params['id']))
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),

  /* ----------------------------------------------------------------- staff */

  http.get('/api/staff', async () =>
    handle(() => {
      requireSession()
      return store().listStaff()
    }),
  ),

  http.post('/api/staff/invitations', async ({ request }) => {
    await delay()
    try {
      requireSession()
      return ok(store().inviteStaff((await request.json()) as never), 201)
    } catch (error) {
      return fail(error)
    }
  }),

  http.patch('/api/staff/:id', async ({ request, params }) => {
    await delay()
    try {
      requireSession()
      return ok(store().updateStaff(String(params['id']), (await request.json()) as never))
    } catch (error) {
      return fail(error)
    }
  }),

  http.post('/api/staff/:id/invitation', async ({ params }) => {
    await delay()
    try {
      requireSession()
      return ok(store().resendInvitation(String(params['id'])))
    } catch (error) {
      return fail(error)
    }
  }),

  http.delete('/api/staff/:id', async ({ params }) => {
    await delay()
    try {
      requireSession()
      store().removeStaff(String(params['id']))
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),

  /* -------------------------------------------------------------- payments */

  http.get('/api/payments', async () =>
    handle(() => {
      requireModule('payments')
      return store().payments
    }),
  ),

  http.get('/api/payments/:id', async ({ params }) =>
    handle(() => {
      requireModule('payments')
      const found = store().payments.find((payment) => payment.id === String(params['id']))
      if (!found) throw new MockError(404, 'not_found', 'No such payment.')
      return found
    }),
  ),

  /* ------------------------------------------------------------- documents */

  http.get('/api/documents', async ({ request }) =>
    handle(() => {
      requireModule('payments')
      const url = new URL(request.url)
      const kind = url.searchParams.get('kind')
      const all = store().documents
      return kind ? all.filter((document) => document.kind === kind) : all
    }),
  ),

  http.get('/api/documents/:id', async ({ params }) =>
    handle(() => {
      requireModule('payments')
      const found = store().documents.find((document) => document.id === String(params['id']))
      if (!found) throw new MockError(404, 'not_found', 'No such document.')
      return found
    }),
  ),

  /* --------------------------------------------------------------- billing */

  http.get('/api/billing/subscription', async () =>
    handle(() => {
      requireSession()
      const current = store()
      return { ...current.subscription, seats: current.entitlement.seats }
    }),
  ),
]
