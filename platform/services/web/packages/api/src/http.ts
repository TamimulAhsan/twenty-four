/**
 * The one place the frontend talks to the network.
 *
 * Every call goes to the Tenant Gateway under /api. The gateway verifies the
 * token, resolves the tenant and checks entitlement before anything downstream
 * sees the request, so nothing here carries a tenant id in a body or trusts a
 * client-side gate.
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

const BASE = '/api'

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = `${BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${url}?${search}` : url
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, query, idempotencyKey } = options

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  let response: Response
  try {
    response = await fetch(buildUrl(path, query), {
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

/** Generates an idempotency key for a write that must not double-apply. */
export function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
