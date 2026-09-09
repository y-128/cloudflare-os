import capnwebValidate from "capnweb-validate/vite";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { INBOX_LOCAL_DEV: "false" },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./workers/app.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { DOMAINS: "example.com", EMAIL_ADDRESSES: "[]" },
        r2Buckets: ["BUCKET"],
        durableObjects: {
          MAILBOX: { className: "MailboxDO", useSQLite: true },
          CONFIG: { className: "ConfigDO", useSQLite: true },
          EMAIL_AGENT: { className: "EmailAgent", useSQLite: true },
          EMAIL_MCP: { className: "EmailMCP", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
