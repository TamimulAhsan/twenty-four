import { QueryClient } from '@tanstack/react-query'

/**
 * One query client configuration for all three applications.
 *
 * The retry rule matters more than it looks: a refused module and a malformed
 * request will both be refused again, so retrying them just delays the error
 * the merchant needs to see. Only something transient is worth a second go.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status ?? 0
          if (status >= 400 && status < 500) return false
          return failureCount < 2
        },
      },
      mutations: { retry: false },
    },
  })
}
