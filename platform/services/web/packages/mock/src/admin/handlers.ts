/**
 * MSW handlers for the Admin Gateway.
 *
 * A separate base and a separate session from the merchant handlers, because
 * they are a separate gateway. Nothing here reads the merchant's signed-in
 * state and nothing there reads this one: signing out of the console must not
 * sign anyone out of a till, and signing into a till must not open the
 * console.
 */
import { http, HttpResponse, type HttpHandler } from 'msw'
import type { ModuleId, TierId } from '@twentyfour/entitlement'
import type { ImpersonationMode, TenantStatus } from '@twentyfour/api'
import { MockError } from '../store'
import { wire } from '../wire'
import { ADMIN_ROLES, ENVIRONMENT, STAFF } from './platform'
import { adminStore } from './store'

const LATENCY_MS = 140

const delay = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS))

function ok(body: unknown, status = 200): Response {
  return HttpResponse.json(wire(body) as object, {
    status,
    headers: { 'X-Request-Id': `admin-${Math.random().toString(36).slice(2, 10)}` },
  })
}

function fail(error: unknown): Response {
  if (error instanceof MockError) {
    return HttpResponse.json(
      { code: error.code, message: error.message, fieldErrors: error.fieldErrors },
      { status: error.status },
    )
  }
  const message = error instanceof Error ? error.message : 'Something went wrong.'
  return HttpResponse.json({ code: 'internal', message }, { status: 500 })
}

async function handle(work: () => unknown): Promise<Response> {
  await delay()
  try {
    return ok(work())
  } catch (error) {
    return fail(error)
  }
}

const body = async (request: Request): Promise<Record<string, unknown>> =>
  ((await request.json()) ?? {}) as Record<string, unknown>

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const adminHandlers: HttpHandler[] = [
  /* ------------------------------------------------------------ the door */

  // Null rather than 401. Arriving signed out is the ordinary case for a
  // console behind SSO, and a 401 here would make every first load an error
  // in the console's own network panel.
  http.get('/admin/api/auth/session', async () => {
    await delay()
    return ok(adminStore().currentSession())
  }),

  // The handoff. There is no sign-in form on this plane: one form serves both,
  // it lives on the merchant origin, and a specialist arrives here holding a
  // one-time code it gave them.
  http.post('/admin/api/session/exchange', async ({ request }) => {
    const payload = await body(request)
    return handle(() => adminStore().redeemHandoff(text(payload['code'])))
  }),

  http.delete('/admin/api/auth/session', async () => {
    await delay()
    try {
      adminStore().signOut()
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),

  /* ------------------------------------------------------ the environment */

  http.get('/admin/api/overview', async () => handle(() => adminStore().overview())),

  http.get('/admin/api/environment', async () => handle(() => ENVIRONMENT)),

  http.get('/admin/api/staff', async () => handle(() => STAFF)),

  http.get('/admin/api/roles', async () => handle(() => ADMIN_ROLES)),

  /* ----------------------------------------------------------- the money */

  http.get('/admin/api/billing', async () => handle(() => adminStore().billing())),

  /* --------------------------------------------------------- the registry */

  http.get('/admin/api/registry/tiers', async () => handle(() => adminStore().listTiers())),

  http.put('/admin/api/registry/tiers/:tier/grants', async ({ request, params }) => {
    const payload = await body(request)
    return handle(() => {
      const grants = Array.isArray(payload['grants']) ? (payload['grants'] as ModuleId[]) : []
      return adminStore().setTierGrants(params['tier'] as TierId, grants)
    })
  }),

  /* ---------------------------------------------------------- the tenants */

  http.get('/admin/api/tenants', async () => handle(() => adminStore().listTenants())),

  http.get('/admin/api/tenants/:id', async ({ params }) =>
    handle(() => adminStore().getTenant(String(params['id']))),
  ),

  http.get('/admin/api/tenants/:id/orders', async ({ params }) =>
    handle(() => adminStore().tenantOrders(String(params['id']))),
  ),

  http.get('/admin/api/tenants/:id/invoices', async ({ params }) =>
    handle(() => adminStore().tenantInvoices(String(params['id']))),
  ),

  http.get('/admin/api/tenants/:id/audit', async ({ params }) =>
    handle(() => adminStore().tenantAudit(String(params['id']))),
  ),

  http.put('/admin/api/tenants/:id/status', async ({ request, params }) => {
    const payload = await body(request)
    return handle(() =>
      adminStore().setStatus(
        String(params['id']),
        text(payload['status']) as TenantStatus,
        text(payload['reason']),
      ),
    )
  }),

  http.put('/admin/api/tenants/:id/tier', async ({ request, params }) => {
    const payload = await body(request)
    return handle(() =>
      adminStore().setTier(
        String(params['id']),
        text(payload['tier']) as TierId,
        text(payload['reason']),
      ),
    )
  }),

  http.put('/admin/api/tenants/:id/modules', async ({ request, params }) => {
    const payload = await body(request)
    return handle(() =>
      adminStore().overrideModule(String(params['id']), {
        moduleId: text(payload['moduleId']) as ModuleId,
        entitled: payload['entitled'] === true,
        reason: text(payload['reason']),
      }),
    )
  }),

  /* ------------------------------------------------------ the saga queue */

  http.get('/admin/api/provisioning', async () =>
    handle(() => adminStore().provisioningQueue()),
  ),

  http.get('/admin/api/provisioning/:id', async ({ params }) =>
    handle(() => adminStore().provisioningRun(String(params['id']))),
  ),

  http.post('/admin/api/provisioning/:id/steps/:stepId/retry', async ({ params }) =>
    handle(() => adminStore().retryStep(String(params['id']), String(params['stepId']))),
  ),

  /* ------------------------------------------------------------ the trail */

  http.get('/admin/api/audit', async ({ request }) =>
    handle(() => {
      const filter = new URL(request.url).searchParams.get('filter')
      return adminStore().listAudit(filter ?? undefined)
    }),
  ),

  /* --------------------------------------------------------- the sessions */

  http.get('/admin/api/support-sessions', async () => handle(() => adminStore().listSessions())),

  http.post('/admin/api/support-sessions', async ({ request }) => {
    const payload = await body(request)
    return handle(() =>
      adminStore().startSession({
        tenantId: text(payload['tenantId']),
        mode: (text(payload['mode']) || 'read') as ImpersonationMode,
        reason: text(payload['reason']),
      }),
    )
  }),

  http.post('/admin/api/support-sessions/:id/elevate', async ({ request, params }) => {
    const payload = await body(request)
    return handle(() =>
      adminStore().elevateSession(String(params['id']), text(payload['reason'])),
    )
  }),

  http.post('/admin/api/support-sessions/:id/extend', async ({ params }) =>
    handle(() => adminStore().extendSession(String(params['id']))),
  ),

  http.delete('/admin/api/support-sessions/:id', async ({ params }) => {
    await delay()
    try {
      adminStore().revokeSession(String(params['id']))
      return new HttpResponse(null, { status: 204 })
    } catch (error) {
      return fail(error)
    }
  }),
]
