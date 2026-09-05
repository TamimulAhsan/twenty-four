/**
 * Which fixture is active, and whether anyone is signed in.
 *
 * Kept in localStorage so the dev toolbar survives a reload. This is mock
 * scaffolding: the real session is an httpOnly cookie issued on the parent
 * domain, which JavaScript never reads.
 */
import { DEFAULT_TENANT } from './seed'

const TENANT_KEY = 'tf.mock.tenant'
const SIGNED_IN_KEY = 'tf.mock.signedIn'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Nothing to do: the fixture falls back to its default.
  }
}

export function currentTenantId(): string {
  return read(TENANT_KEY) ?? DEFAULT_TENANT
}

export function setCurrentTenantId(tenantId: string): void {
  write(TENANT_KEY, tenantId)
}

export function isSignedIn(): boolean {
  return read(SIGNED_IN_KEY) === 'true'
}

export function setSignedIn(signedIn: boolean): void {
  write(SIGNED_IN_KEY, String(signedIn))
}
