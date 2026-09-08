/**
 * The one place the frontend talks to the network.
 *
 * There are two gateways, and they are not the same door. The Tenant Gateway
 * under /api verifies the merchant's token, resolves the tenant and checks
 * entitlement before anything downstream sees the request, so nothing here
 * carries a tenant id in a body or trusts a client-side gate. The Admin
 * Gateway under /admin/api has its own auth realm: staff SSO, MFA and an IP
 * allowlist, and it is reached from a different host entirely.
 *
 * They share this transport and nothing else. A base is picked per call rather
 * than per module so a mistake is a compile error at the call site instead of
 * a merchant token being presented to the staff plane.
 */

export interface FieldError {
  readonly field: string
  readonly message: string
}

export class HttpError extends Error {
  readonly status: number
  /** Stable machine-readable code from the gateway. */
  readonly code: string
  readonly fieldErrors: readonly FieldError[]
  readonly requestId: string | undefined

  constructor(init: {
    status: number
    code: string
    message: string
    fieldErrors?: readonly FieldError[]
    requestId?: string
  }) {
    super(init.message)
    this.name = 'HttpError'
    this.status = init.status
    this.code = init.code
    this.fieldErrors = init.fieldErrors ?? []
    this.requestId = init.requestId
  }

  /** The gateway refused a module this tenant does not hold. The UI should
   *  have hidden it, but the server is the control, so this is reachable. */
  get isNotEntitled(): boolean {
    return this.status === 403 && this.code === 'not_entitled'
  }

  get isUnauthenticated(): boolean {
    return this.status === 401
  }

  /** Worth retrying without changing anything. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  query?: Record<string, string | number | boolean | undefined>
  /**
   * Makes a write safe to retry. Payments and order placement must carry one:
   * a retried checkout without a key is a double charge.
   */
  idempotencyKey?: string
}

/** The Tenant Gateway. Merchant session, entitlement enforced per request. */
const TENANT_BASE = '/api'

/** The Admin Gateway. Staff SSO, MFA, IP allowlist, its own host. */
const ADMIN_BASE = '/admin/api'

function buildUrl(base: string, path: string, query: RequestOptions['query']): string {
  const url = `${base}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${url}?${search}` : url
}

async function call<T>(base: string, path: string, options: RequestOptions): Promise<T> {
  const { method = 'GET', body, signal, query, idempotencyKey } = options

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  let response: Response
  try {
    response = await fetch(buildUrl(base, path, query), {
      method,
      headers,
      // The session cookie is issued on the parent domain and shared with the
      // CRM subdomain. It is never read by JavaScript.
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new HttpError({
      status: 0,
      code: 'network_unreachable',
      message: 'Could not reach the server.',
    })
  }

  const requestId = response.headers.get('X-Request-Id') ?? undefined

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = undefined
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }

  if (!response.ok) {
    const error = (payload ?? {}) as Record<string, unknown>
    throw new HttpError({
      status: response.status,
      code: typeof error['code'] === 'string' ? error['code'] : 'unknown',
      message:
        typeof error['message'] === 'string'
          ? error['message']
          : `Request failed with status ${response.status}.`,
      fieldErrors: Array.isArray(error['fieldErrors'])
        ? (error['fieldErrors'] as FieldError[])
        : [],
      requestId,
    })
  }

  return payload as T
}

/** A call to the Tenant Gateway, as the signed-in merchant. */
export function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return call<T>(TENANT_BASE, path, options)
}

/**
 * A call to the Admin Gateway, as a signed-in specialist.
 *
 * Separate from request on purpose. The two planes never share an auth path,
 * and the admin console is served from its own host, so a call that went to
 * the wrong base would be a cross-plane request rather than a 404.
 */
export function adminRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return call<T>(ADMIN_BASE, path, options)
}

/** Generates an idempotency key for a write that must not double-apply. */
export function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
