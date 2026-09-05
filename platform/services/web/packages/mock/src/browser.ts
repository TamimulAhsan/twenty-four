import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export { handlers }

export const worker = setupWorker(...handlers)

/**
 * Starts the mock gateway.
 *
 * Called only in development. When the real gateway exists this call goes and
 * nothing else changes: every component already speaks to /api over fetch.
 */
export async function startMockGateway(): Promise<void> {
  await worker.start({
    // A request the handlers do not cover should reach the network, not fail.
    onUnhandledRequest: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })
}
