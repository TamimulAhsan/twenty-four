import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))

/**
 * The admin console: its own build, its own image, its own deployment.
 *
 * base is '/' rather than a path prefix, because this application does not
 * share an origin with the merchant ones. That is the whole point. The four
 * merchant applications sit on one host so the session cookie issued on the
 * parent domain carries between them; putting the staff console under that
 * same namespace would hand the merchant cookie space to the plane that can
 * see every merchant. It gets its own host, its own gateway and its own
 * sign-in, and nothing is shared but the design system.
 */
export default defineConfig({
  base: '/',
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
  server: {
    port: 5184,
    strictPort: true,
    // Same-origin, always. The admin cookie is host-only, so the console and
    // its gateway have to look like one origin to the browser: pointing the
    // console straight at another host would mean the cookie the gateway sets
    // is never sent back.
    //
    // Set VITE_ADMIN_API to a reachable admin gateway to develop against the
    // cluster. Unset, the mock answers and this proxy is never consulted.
    proxy: process.env['VITE_ADMIN_API']
      ? {
          '/admin/api': {
            target: process.env['VITE_ADMIN_API'],
            changeOrigin: false,
          },
        }
      : undefined,
  },
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
