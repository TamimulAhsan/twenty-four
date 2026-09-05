import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))

/**
 * Till: its own build, its own image, its own deployment.
 *
 * base is set so every asset URL is prefixed and the bundle can be served from
 * its own pod behind that path. All the applications stay on one origin, which
 * is what lets the session cookie carry across them: put this on another origin
 * and a merchant launching it from the dashboard has to sign in again.
 */
export default defineConfig({
  base: '/pos/',
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@twentyfour/tokens': pkg('tokens'),
      '@twentyfour/money': pkg('money'),
      '@twentyfour/terms': pkg('terms'),
      '@twentyfour/entitlement': pkg('entitlement'),
      '@twentyfour/api': pkg('api'),
      '@twentyfour/ui': pkg('ui'),
      '@twentyfour/runtime': pkg('runtime'),
      '@twentyfour/rbac': pkg('rbac'),
      '@twentyfour/analytics': pkg('analytics'),
      // The subpath alias must come first: Vite matches by prefix, and the
      // bare specifier would otherwise swallow it.
      '@twentyfour/mock/browser': fileURLToPath(
        new URL('../../packages/mock/src/browser.ts', import.meta.url),
      ),
      '@twentyfour/mock': pkg('mock'),
      '@twentyfour/shell/app.css': fileURLToPath(
        new URL('../../packages/shell/src/app.css', import.meta.url),
      ),
      '@twentyfour/shell': pkg('shell'),
    },
  },
  server: { port: 5181, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // One vendor chunk so shared code caches predictably and a build diff
        // stays readable, rather than being named after whichever module
        // Rollup happened to hoist it from.
        manualChunks: (id: string) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
})
