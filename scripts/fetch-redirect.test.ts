import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The Workers runtime does not implement `redirect: "error"`. `fetch` rejects it outright:
 *
 *     TypeError: Invalid redirect value, must be one of "follow" or "manual"
 *     ("error" won't be implemented since it does not make sense at the edge;
 *      use "manual" and check the response status code).
 *
 * It is valid in the browser and in Node, so it type-checks, passes review, and only fails at
 * runtime — where it took down every Cloudflare API call and every Discord notification in the
 * inbox worker at once. The generic error handling reported it as a network failure, so the real
 * cause stayed hidden until the logging was made specific.
 *
 * Use `redirect: "manual"` and check the status instead, which keeps the intent (never follow a
 * redirect, so an Authorization header cannot be replayed to another host).
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Worker source only. Frontend code runs in a browser, where "error" is implemented.
const WORKER_DIRECTORIES = ["packages", "scripts"];
const SKIPPED = new Set([".wrangler", "node_modules", "dist", "dist-app", "generated", ".git"]);
const OFFENDING = /redirect:\s*["']error["']/;

/** Collects every TypeScript source file below `dir`, skipping build output and dependencies. */
function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collectSources(path));
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Strips comments so the explanation above does not count as a usage. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("fetch redirect mode", () => {
  it("no worker source passes redirect: \"error\"", () => {
    const offenders: string[] = [];
    for (const directory of WORKER_DIRECTORIES) {
      for (const file of collectSources(join(ROOT, directory))) {
        // Frontend code is exempt: it runs in a browser, which implements "error".
        if (file.includes(join("packages", "workshop-frontend"))) continue;
        // This file carries the pattern in its own matcher, so it would always report itself.
        if (file === fileURLToPath(import.meta.url)) continue;
        if (OFFENDING.test(stripComments(readFileSync(file, "utf8")))) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    assert.deepEqual(offenders, [],
      `redirect: "error" throws a TypeError in the Workers runtime; use "manual" and check the status`);
  });
});
