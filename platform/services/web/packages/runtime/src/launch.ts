import { DEFAULT_LAUNCH_TARGETS, type LaunchTargets } from '@twentyfour/entitlement'

/**
 * Where the sibling applications live.
 *
 * Separate applications means separate origins in development and separate
 * bundles in production, so the address cannot be a constant in the code. It
 * comes from the build environment, with the production paths as the fallback.
 */
export function launchTargets(env: Record<string, string | boolean | undefined>): LaunchTargets {
  const read = (key: string, fallback: string): string => {
    const value = env[key]
    return typeof value === 'string' && value.length > 0 ? value : fallback
  }
  return {
    pos: read('VITE_POS_URL', DEFAULT_LAUNCH_TARGETS.pos),
    bookings: read('VITE_BOOKINGS_URL', DEFAULT_LAUNCH_TARGETS.bookings),
    crm: read('VITE_CRM_URL', DEFAULT_LAUNCH_TARGETS.crm),
  }
}
