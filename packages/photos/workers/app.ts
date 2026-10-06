import { createLogger } from "@gadgets/backend-utils/logger";
import { Hono } from "hono";
import { ZodError } from "zod";
import { PHOTOS_API_BASE } from "../shared/api-types";
import { authenticateAdmin, hasValidCredentialKey } from "./auth";
import type { PhotosEnv, PhotosHono } from "./env";
import { HttpError } from "./http";
import { agentRoutes } from "./routes/agent";
import { albumsRoutes } from "./routes/albums";
import { blobRoutes, downloadsRoutes } from "./routes/downloads";
import { importsRoutes } from "./routes/imports";
import { photographersRoutes } from "./routes/photographers";
import { photosRoutes } from "./routes/photos";
import { storageRoutes } from "./routes/storage";
import { tagsRoutes } from "./routes/tags";
import { uploadsRoutes, uploadWriteRoutes } from "./routes/uploads";

export { NasAgentDO } from "./durableObject/nas-agent";
export { PhotoJobsDO } from "./durableObject/photo-jobs";
export { SchemaMigratorDO } from "./durableObject/schema";

const logger = createLogger<{ method?: string; route?: string }>({ component: "photos.http" });

// Per isolate: the schema is checked once, then trusted until the isolate is recycled.
let schemaReady: Promise<void> | undefined;

/** Resolves once this isolate has confirmed the D1 schema is current. Retries after a failure. */
function ensureSchema(env: PhotosEnv, ctx: Pick<ExecutionContext, "waitUntil">): Promise<void> {
  schemaReady ??= (async () => {
    await env.SCHEMA_MIGRATOR.getByName("schema").migrate();
    ctx.waitUntil(env.PHOTO_JOBS.getByName("library").ensureScheduled());
  })().catch((err: unknown) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

const api = new Hono<PhotosHono>()
  .use("*", async (c, next) => {
    // Configuration is checked before authentication so a misconfigured deployment says so.
    if (!hasValidCredentialKey(c.env)) throw new HttpError(503, "credential_key_missing");
    const actor = await authenticateAdmin(c.req.raw, c.env);
    if (!actor) throw new HttpError(403, "forbidden");
    c.set("actor", actor);
    await ensureSchema(c.env, c.executionCtx);
    await next();
  })
  .route("/photos", photosRoutes)
  .route("/photos", downloadsRoutes)
  .route("/uploads", uploadsRoutes)
  .route("/imports", importsRoutes)
  .route("/tags", tagsRoutes)
  .route("/albums", albumsRoutes)
  .route("/photographers", photographersRoutes)
  .route("/storage", storageRoutes);

/** The Photos worker's HTTP surface, mounted where the router forwards it. */
export const app = new Hono<PhotosHono>()
  .use("*", async (c, next) => {
    await next();
    // Everything here is per-administrator data; never let a shared cache keep it. Blob responses
    // set their own private, expiring policy.
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  })
  // Before the authenticated API: blob URLs carry their own authority (see blobRoutes).
  .route(`${PHOTOS_API_BASE}/blob`, blobRoutes)
  .route(`${PHOTOS_API_BASE}/upload`, uploadWriteRoutes)
  .route(`${PHOTOS_API_BASE}/agent`, agentRoutes)
  .route(PHOTOS_API_BASE, api)
  .notFound((c) => c.json({ error: "not_found" }, 404))
  .onError((err, c) => {
    const known = HttpError.revive(err);
    if (known) return c.json({ error: known.code }, known.status);
    if (err instanceof ZodError || err instanceof SyntaxError) {
      return c.json({ error: "invalid_request" }, 400);
    }
    logger.error("request failed", {
      event: "photos.request.failed", method: c.req.method, route: c.req.routePath, error: err,
    });
    return c.json({ error: "internal_error" }, 500);
  });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<PhotosEnv>;
