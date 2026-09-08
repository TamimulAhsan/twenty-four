import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '@twentyfour/runtime'
import { ToastProvider } from '@twentyfour/ui'
import './app.css'

export interface BootOptions {
  /**
   * Which gateway this application talks to.
   *
   * The admin console is behind a different gateway with a different auth
   * realm, on a different host. Naming it here means its mock worker registers
   * only the admin handlers, so a screen that called the merchant API in
   * development would fail rather than quietly work.
   */
  plane?: 'tenant' | 'admin'
  /**
   * Whether to stand the mock gateway up at all.
   *
   * False when the application is pointed at a real backend in development.
   * The two cannot be mixed per endpoint: the moment a session is involved, a
   * mock sign-in and a real data call disagree about who is signed in, and the
   * result is a console that looks authenticated and is refused by everything.
   */
  mock?: boolean
}

/**
 * Boots one of the applications.
 *
 * The mock gateway starts before React does. Awaiting it means the first query
 * cannot race the service worker and get a real 404 from the dev server. When
 * the gateway is real this call goes and nothing else changes: every request
 * already goes to /api or /admin/api over fetch.
 */
export async function boot(app: ReactNode, options: BootOptions = {}): Promise<void> {
  // Imported dynamically inside the guard so the whole mock gateway, service
  // worker and seed data are dropped from the production build rather than
  // shipped to merchants as dead weight.
  if (import.meta.env.DEV && (options.mock ?? true)) {
    const { startMockGateway } = await import('@twentyfour/mock/browser')
    await startMockGateway(options.plane ?? 'tenant')
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('missing #root')

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>{app}</ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
