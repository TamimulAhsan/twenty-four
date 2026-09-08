import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'
import { adminHandlers } from './admin/handlers'

export { handlers, adminHandlers }

/**
 * Which gateway this worker stands in for.
 *
 * There are two, they have different auth realms, and in production they are
 * reached from different hosts. Registering only one plane's handlers keeps
 * that true in development as well: an admin screen that called /api would get
 * an unhandled request instead of a merchant fixture, which is the cross-plane
 * mistake worth catching while it is still cheap.
 */
export type Plane = 'tenant' | 'admin'

/**
 * Starts the mock gateway.
 *
 * Called only in development. When the real gateway exists this call goes and
 * nothing else changes: every component already speaks to /api or /admin/api
 * over fetch.
 */
export async function startMockGateway(plane: Plane = 'tenant'): Promise<void> {
  const worker = setupWorker(...(plane === 'admin' ? adminHandlers : handlers))
  await worker.start({
    // A request the handlers do not cover should reach the network, not fail.
    onUnhandledRequest: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })
}
