/**
 * Fixture data and the stateful store.
 *
 * Deliberately does not re-export the service worker. Anything that imports
 * this for dev tooling would otherwise pull msw into the production bundle,
 * where it is 300kB of code that can never run. The worker lives behind the
 * ./browser entry point and is imported dynamically, inside a DEV guard.
 */
export { storeFor, resetStore, availableTenants, TenantStore, MockError } from './store'
export { currentTenantId, setCurrentTenantId, isSignedIn, setSignedIn } from './session'
export { SEEDS, DEFAULT_TENANT, seedFor, type TenantSeed } from './seed'
export { buildOnboarding, freshOnboarding } from './onboarding'
export { wire } from './wire'
export { AdminStore, adminStore, resetAdminStore } from './admin/store'
export { ENVIRONMENT, STAFF as ADMIN_STAFF, NOW as ADMIN_NOW } from './admin/platform'
