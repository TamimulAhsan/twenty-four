import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@twentyfour/tokens': resolve('./packages/tokens/src/index.ts'),
      '@twentyfour/money': resolve('./packages/money/src/index.ts'),
      '@twentyfour/terms': resolve('./packages/terms/src/index.ts'),
      '@twentyfour/entitlement': resolve('./packages/entitlement/src/index.ts'),
      '@twentyfour/api': resolve('./packages/api/src/index.ts'),
      '@twentyfour/mock': resolve('./packages/mock/src/index.ts'),
      '@twentyfour/ui': resolve('./packages/ui/src/index.ts'),
      '@twentyfour/runtime': resolve('./packages/runtime/src/index.ts'),
      '@twentyfour/rbac': resolve('./packages/rbac/src/index.ts'),
      '@twentyfour/analytics': resolve('./packages/analytics/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
})
