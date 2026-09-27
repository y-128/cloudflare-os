import { createExecutionContext, env as bindings, waitOnExecutionContext } from "cloudflare:test";
import { PHOTOS_API_BASE, PHOTOS_REQUEST_HEADER } from "../shared/api-types";
import type { StorageConnectionId } from "../shared/ids";
import { app } from "../workers/app";
import { applyMigrations } from "../workers/db/migrate";
import { createPhotoRecord, type NewPhoto } from "../workers/db/photos";
import type { PhotosEnv } from "../workers/env";

/** The test bindings: real D1 and Durable Objects from miniflare. */
export const env = bindings as PhotosEnv;

/** The administrator every authenticated test request acts for. */
export const ACTOR = "admin@example.com";

/** The storage connection test assets live on. */
export const CONNECTION = "stc_01J00000000000000000000000" as StorageConnectionId;

/** A Workshop that admits any request carrying `Bearer admin` and records what it was sent. */
export function fakeWorkshop() {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      if (request.headers.get("Authorization") !== "Bearer admin" ||
          request.headers.get(PHOTOS_REQUEST_HEADER) !== "1") {
        return new Response(null, { status: 403 });
      }
      return Response.json({ actor: ACTOR });
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

/** Sends a request to the worker as a signed-in administrator (unless headers say otherwise). */
export async function call(
  method: string,
  path: string,
  options: {
    body?: unknown; rawBody?: Uint8Array; headers?: Record<string, string>; env?: Partial<PhotosEnv>;
  } = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`https://cfos.example${PHOTOS_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: "Bearer admin",
      [PHOTOS_REQUEST_HEADER]: "1",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const response = await app.fetch(request, {
    ...env, WORKSHOP_AUTH: fakeWorkshop().fetcher, ...options.env,
  }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Sends a request and parses its JSON body, failing on a non-2xx status. */
export async function callJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await call(method, path, { body });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

const TABLES = [
  "share_links", "publication_objects", "publications", "publication_targets", "album_photos",
  "albums", "photo_tags", "tags", "photo_exif", "photo_assets", "photos", "photographer_aliases",
  "photographers", "storage_connections", "usage_samples",
];

/** Brings the schema up to date and empties every table, leaving one storage connection. */
export async function resetDb(): Promise<void> {
  await applyMigrations(env.PHOTOS_DB);
  await env.PHOTOS_DB.batch([
    ...TABLES.map((table) => env.PHOTOS_DB.prepare(`DELETE FROM ${table}`)),
    env.PHOTOS_DB.prepare(`INSERT INTO storage_connections (id, kind, name, config_json, status,
        created_by, created_at, updated_at) VALUES (?, 'r2-binding', 'Test R2', '{}', 'online', ?, 0, 0)`)
      .bind(CONNECTION, ACTOR),
  ]);
}

let counter = 0;

/** Registers a photo with one original file; `overrides` adjust the record. */
export async function addPhoto(overrides: Partial<NewPhoto> & { filename?: string; raw?: boolean } = {}) {
  counter++;
  const { filename, raw, ...rest } = overrides;
  return createPhotoRecord(env.PHOTOS_DB, {
    takenAt: 1_700_000_000_000 + counter * 1000,
    takenAtSource: "exif",
    assets: [{
      role: "original",
      connectionId: CONNECTION,
      storageKey: `originals/${counter}`,
      mimeType: raw ? "image/x-sony-arw" : "image/jpeg",
      formatFamily: raw ? "raw" : "jpeg",
      byteSize: 1000 + counter,
      originalFilename: filename ?? `DSC${String(counter).padStart(5, "0")}.${raw ? "ARW" : "JPG"}`,
      sha256: counter.toString(16).padStart(64, "0"),
    }],
    ...rest,
  }, ACTOR);
}
