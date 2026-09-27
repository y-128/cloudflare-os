import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/app.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["nodejs_compat"],
        // 32 zero bytes: a well-formed key, never a real one.
        bindings: { PHOTOS_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
        d1Databases: ["PHOTOS_DB"],
        r2Buckets: ["PHOTOS_BUCKET"],
        durableObjects: {
          PHOTO_JOBS: { className: "PhotoJobsDO", useSQLite: true },
          SCHEMA_MIGRATOR: { className: "SchemaMigratorDO", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
