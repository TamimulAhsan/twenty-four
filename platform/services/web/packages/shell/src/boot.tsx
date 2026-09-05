import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '@twentyfour/runtime'
import { ToastProvider } from '@twentyfour/ui'
import './app.css'

/**
 * Boots one of the three applications.
 *
 * The mock gateway starts before React does. Awaiting it means the first query
 * cannot race the service worker and get a real 404 from the dev server. When
 * the gateway is real this call goes and nothing else changes: every request
 * already goes to /api over fetch.
 */
export async function boot(app: ReactNode): Promise<void> {
  // Imported dynamically inside the guard so the whole mock gateway, service
  // worker and seed data are dropped from the production build rather than
  // shipped to merchants as dead weight.
  if (import.meta.env.DEV) {
    const { startMockGateway } = await import('@twentyfour/mock/browser')
    await startMockGateway()
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
