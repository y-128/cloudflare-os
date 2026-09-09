import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./src/email.ts",
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
      durableObjects: {
        EmailAddress: { className: "EmailAddress", useSQLite: true },
      },
    },
  })],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
