import { Hono } from "hono";
import type { AssetRole, DownloadTargetView, FormatFamily } from "../../shared/api-types";
import type { PhotosEnv, PhotosHono } from "../env";
import { found } from "../http";
import { photoId, downloadRequest } from "../schemas";
import { verifyGrant } from "../storage/grants";
import { attachmentDisposition } from "../storage/provider";
import { StorageRegistry } from "../storage/registry";
import { body, param, registry } from "./common";

interface CandidateRow {
  role: AssetRole;
  format_family: FormatFamily | null;
  is_primary: number;
  connection_id: string;
  storage_key: string;
  original_filename: string | null;
  mime_type: string;
  offline: number;
}

/** Photo downloads for library members (administrators may always download). */
export const downloadsRoutes = new Hono<PhotosHono>()
  .post("/:id/download", async (c) => {
    const id = param(c, "id", photoId);
    const { variant } = await body(c, downloadRequest);
    const { results } = await c.env.PHOTOS_DB.prepare(`SELECT a.role, a.format_family, a.is_primary,
        a.connection_id, a.storage_key, a.original_filename, a.mime_type,
        s.status = 'offline' AS offline
        FROM photo_assets a JOIN storage_connections s ON s.id = a.connection_id
        WHERE a.photo_id = ? AND a.state = 'available'
        ORDER BY offline, a.role = 'replica', a.is_primary DESC`).bind(id).all<CandidateRow>();
    const wanted = results.filter((row) => {
      if (variant === "preview") return row.role === "preview";
      if (row.role !== "original" && row.role !== "replica") return false;
      if (variant === "raw") return row.format_family === "raw";
      if (variant === "jpeg") return row.format_family === "jpeg";
      return true;
    });
    if (wanted.length === 0) {
      return c.json({ kind: "unavailable", reason: "missing" } satisfies DownloadTargetView);
    }
    const [best] = wanted;
    if (best.offline) return c.json({ kind: "unavailable", reason: "offline" } satisfies DownloadTargetView);
    const provider = await registry(c).get(best.connection_id);
    return c.json(await provider.createDownload(best.storage_key, {
      filename: best.original_filename ?? best.storage_key.split("/").at(-1),
      contentType: best.mime_type,
    }) satisfies DownloadTargetView);
  });

/**
 * Streams an object named by a signed, expiring token. Mounted outside the administrator check
 * because <img> and downloads cannot send headers; the token is the whole authority, and it names
 * exactly one object.
 */
export const blobRoutes = new Hono<{ Bindings: PhotosEnv }>()
  .get("/:token", async (c) => {
    const grant = found(await verifyGrant(c.env, c.req.param("token"), "read"), "not_found");
    const provider = await new StorageRegistry(c.env, new URL(c.req.url).origin).get(grant.connectionId);
    const object = found(await provider.read(grant.key), "not_found");
    const headers = new Headers({
      "Content-Length": String(object.size),
      "Content-Type": grant.contentType ?? object.contentType ?? "application/octet-stream",
      // Private: the URL is a bearer credential, so no shared cache may keep the response.
      "Cache-Control": `private, max-age=${Math.max(0, Math.floor((grant.expiresAt - Date.now()) / 1000))}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    if (grant.filename) headers.set("Content-Disposition", attachmentDisposition(grant.filename));
    return new Response(object.body, { headers });
  });
