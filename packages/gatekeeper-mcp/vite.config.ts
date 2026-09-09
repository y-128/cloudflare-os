// Vite+ per-package settings. Shared by all gatekeepers with a configurator UI and living beside the
// builder it runs; `withTests` is that config plus the shared vitest `test` task.
import { withTests } from '@gadgets/scripts/gatekeeper-configurator'

export default {
  ...withTests,
  test: {
    // Run source tests once, excluding Wrangler's generated copies.
    include: ["__tests__/**/*.test.ts"],
  },
}
