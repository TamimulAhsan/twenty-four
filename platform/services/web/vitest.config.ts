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
      // Before the bare specifier: Vite matches aliases by prefix in the order
      // they are declared, and the bare one would otherwise swallow this.
      '@twentyfour/mock/browser': resolve('./packages/mock/src/browser.ts'),
      '@twentyfour/mock': resolve('./packages/mock/src/index.ts'),
      '@twentyfour/ui': resolve('./packages/ui/src/index.ts'),
      '@twentyfour/runtime': resolve('./packages/runtime/src/index.ts'),
      '@twentyfour/rbac': resolve('./packages/rbac/src/index.ts'),
      '@twentyfour/analytics': resolve('./packages/analytics/src/index.ts'),
      '@twentyfour/shell/app.css': resolve('./packages/shell/src/app.css'),
      '@twentyfour/shell': resolve('./packages/shell/src/index.ts'),
    },
  },
  test: {
    // Node by default, because most of what is tested here is a store and a
    // set of rules with no DOM in sight. A file that needs one asks for jsdom
    // in its own docblock rather than making every other file pay for it.
    environment: 'node',
    include: ['packages/**/*.test.ts?(x)', 'apps/**/*.test.ts?(x)'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
