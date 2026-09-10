import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { vitestTask } from '@gadgets/scripts/vitest-task'
import { VitePWA } from 'vite-plugin-pwa'

// `dist/` is this package's own build output, excluded from the inputs of the bundle and test
// tasks: vp declines to cache a task that reads a path it also wrote. Package-relative rather than
// workspace-wide -- `typed-storage` emits, and its `exports` resolves to `dist/index.js`, so a
// pattern matching every package's `dist` would drop a real input.
const frontendBundleTaskOptions = {
  dependsOn: ['clean:dist'],
  env: ['VITE_*'],
  input: [
    { auto: true },
    { pattern: '!dist/**', base: 'package' } as const,
    // Wrangler's scratch bundles are randomly named, and tracking reaches past the package that
    // owns the task, so any sibling that ran `wrangler dev` guarantees a miss here. Workspace-wide
    // for that reason; `build:app` and the shared `test` task exclude the same tree.
    { pattern: '!**/.wrangler/**', base: 'workspace' } as const,
  ],
  output: ['dist/**'],
}

const ownDist = { pattern: '!dist/**', base: 'package' } as const
const viteBuildCommand =
  `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`

const runConfig = {
  run: {
    tasks: {
      'clean:dist': {
        command: `node --input-type=module -e "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true })"`,
        cache: false,
      },
      /**
       * `build` is a task rather than a package.json script so `env` can declare the `VITE_*` flags
       * it reads: a cached `vp` run executes scripts in a clean environment, and the values would be
       * missing from the fingerprint besides. `VITE_CF_ACCESS_MODE` is inlined into the bundle
       * (`src/useAuth.ts`) and `VITE_FRONTEND_ERROR_REPORTING` selects hidden source maps below, so
       * replaying a bundle built under different values is wrong rather than merely stale.
       *
       * Separate commands rather than one `&&` string so each is a cache entry of its own; `env` is
       * task-wide, so changing a flag re-runs all three anyway. `tsconfig.vite.json` is the
       * config-file pass (`vite.config.ts` and the scripts it imports), which the app's own
       * `tsconfig.json` excludes.
       *
       * Production mode is set before Vite is imported because Vite snapshots whether `NODE_ENV`
       * was present before loading this config. The Node launcher is shell-neutral.
       */
      build: {
        command: ['tsc', 'tsc -p tsconfig.vite.json', viteBuildCommand],
        ...frontendBundleTaskOptions,
      },
      'build:assets': {
        command: viteBuildCommand,
        ...frontendBundleTaskOptions,
      },
      test: vitestTask('vitest run', [ownDist]),
    },
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const backendHost = env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  const frontendErrorReporting = env.VITE_FRONTEND_ERROR_REPORTING === 'true'
  return {
    // Spread, not a literal `run: {...}`: `run` is Vite+'s field and vite's own `defineConfig` has
    // no such property, but the excess-property check doesn't reach spreads.
    ...runConfig,
    plugins: [
      // Keep route-generator scratch files outside the workspace and its task fingerprints.
      TanStackRouterVite({ target: 'react', autoCodeSplitting: true, tmpDir: join(tmpdir(), 'cfos-router') }),
      react(),
      tailwindcss(),
      tsconfigPaths(),
      VitePWA({
        strategies: 'generateSW',
        registerType: 'autoUpdate',
        // The Toasty integration registers the worker without forcing a reload of unsaved forms.
        injectRegister: false,
        manifest: {
          name: 'Cloudflare OS',
          short_name: 'CF OS',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          lang: 'ja',
          theme_color: '#ff4801',
          background_color: '#fcfcfb',
          icons: [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Explicit because custom registration disables the plugin's automatic defaults.
          skipWaiting: true,
          clientsClaim: true,
          // Only build-time shell files belong here. Never add API/runtime response caching.
          globPatterns: ['**/*.{js,css,html,woff,woff2,ttf,otf,png,svg,ico}'],
          globIgnores: ['api/**', 'cdn-cgi/**'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api(?:[/?]|$)/, /^\/cdn-cgi(?:[/?]|$)/, /^\/gatekeeper(?:[/?]|$)/, /^\/blueprint-screenshot(?:[/?]|$)/],
          runtimeCaching: [],
        },
      }),
    ],
    server: {
      port: 3000,
      host: true,
      proxy: {
        '/api/inbox': { target: `http://${backendHost}`, ws: true },
        '/api/client-errors': `http://${backendHost}`,
        '/blueprint-screenshot': `http://${backendHost}`,
        '/api/site-logo': `http://${backendHost}`,
      },
    },
    build: {
      // Production reporting uploads these separately; hidden maps never reveal a map URL to users.
      sourcemap: frontendErrorReporting ? 'hidden' : false,
    },
  }
})
